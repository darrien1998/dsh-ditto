import { lstat, readFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { stableDigest } from '../core/recipe.js'
import { assertNoLinkAncestor, samePath } from '../core/paths.js'
import { hash, summarizeSpecItems, withSpecDigest } from './prepare.js'
import { hasCurrentSampleApproval, recipeDigest, submitSpecDraft } from './generate.js'
import { validateReviewedMarkdown, renderedHash } from './draft.js'
import type { SpecBatch, SpecModule } from './types.js'

const ENVIRONMENT_FILES = ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'tsconfig.json', 'pyproject.toml', 'poetry.lock', 'uv.lock', 'requirements.txt', 'pom.xml', 'build.gradle', 'gradle.lockfile']

/** Fingerprint known dependency/configuration manifests without executing or following links. */
export async function environmentHash(workspaceRoot: string): Promise<string> {
  const files: Array<[string, string]> = []
  for (const name of ENVIRONMENT_FILES) {
    const file = join(workspaceRoot, name)
    try {
      await assertNoLinkAncestor(file, 'Dependency manifests must not use links')
      const info = await lstat(file)
      if (!info.isFile() || info.isSymbolicLink() || info.size > 2_000_000) throw new Error(`Cannot fingerprint dependency manifest: ${name}`)
      files.push([name, hash(await readFile(file))])
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') files.push([name, 'absent']); else throw error }
  }
  return stableDigest({ format: 'ditto-reuse-1', workspaceRoot, files })
}

export function specIdentity(batch: SpecBatch) { return { id: batch.id, revision: batch.revision, digest: batch.digest } }
export function contextIdentity(batch: SpecBatch): string { return stableDigest({ instructions: batch.recipe.instructions, guidance: batch.recipe.guidance, approvedSamples: batch.recipe.approvedSamples }) }

export function specProgress(batch: SpecBatch) {
  const calibrated = hasCurrentSampleApproval(batch)
  const pending = batch.items.filter(item => ['pending', 'needs-review'].includes(item.status) && (calibrated ? !batch.samples.includes(item.id) : batch.samples.includes(item.id)))
  const next = pending.length ? 'ditto_spec_work' : !calibrated ? 'review_samples_then_ditto_spec_approve' : batch.items.every(item => item.status === 'applied') ? 'complete' : batch.items.every(item => ['ready', 'approved', 'applied'].includes(item.status)) ? 'review_full_preview_then_ditto_spec_apply' : 'ditto_spec_status'
  return { phase: calibrated ? 'remaining' as const : 'samples' as const, pending, next }
}

/** All drafts are validated in memory; the caller commits the final batch once. */
export function submitSpecDrafts(batch: SpecBatch, drafts: Array<{ moduleId: string; draft: unknown; metadata?: Record<string, string> }>): SpecBatch {
  if (!Array.isArray(drafts) || drafts.length < 1 || drafts.length > 5 || new Set(drafts.map(entry => entry?.moduleId)).size !== drafts.length) throw new Error('Submit between one and five distinct module drafts')
  let next = batch
  for (const entry of drafts) next = submitSpecDraft(next, { ...entry, generatorId: 'dsh-agent-driven' })
  return next
}

/** Conservative static local dependency closure. Ambiguity or dynamic loading disables reuse. */
export function dependencyIdentity(batch: SpecBatch, start: SpecModule): string | undefined {
  const seen = new Map<string, string>()
  function visit(item: SpecModule): boolean {
    if (seen.has(item.relativePath)) return true
    seen.set(item.relativePath, item.sourceHash)
    const text = item.evidence.map(chunk => chunk.text).join('\n')
    if (!['typescript', 'python', 'java'].includes(item.language) || /\b(?:eval|Function|__import__)\s*\(|\bimportlib\b|\b(?:import|require)\s*\(\s*[^'"\s]/.test(text)) return false
    const specifiers = new Set(item.facts.imports)
    for (const match of text.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) specifiers.add(match[1]!)
    for (const match of text.matchAll(/\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specifiers.add(match[1]!)
    for (const specifier of specifiers) {
      let local = specifier.startsWith('.')
      let candidates: string[] = []
      if (item.language === 'typescript' && local) {
        const base = posix.normalize(posix.join(posix.dirname(item.relativePath), specifier))
        const bare = base.replace(/\.[cm]?jsx?$/, '')
        candidates = [base, ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'].flatMap(ext => [bare + ext, posix.join(base, 'index' + ext)])]
      } else if (item.language === 'python') {
        const dots = /^\.+/.exec(specifier)?.[0].length ?? 0
        const directory = dots ? posix.join(posix.dirname(item.relativePath), ...Array(Math.max(0, dots - 1)).fill('..')) : ''
        const base = posix.join(directory, specifier.slice(dots).replaceAll('.', '/'))
        candidates = [base + '.py', posix.join(base, '__init__.py')]
        // `from . import name` does not enumerate imported children in the structural adapter.
        if (dots && specifier.length === dots) return false
      } else if (item.language === 'java') {
        const path = specifier.replaceAll('.', '/') + '.java'
        candidates = batch.items.filter(candidate => path.endsWith(candidate.relativePath) || candidate.relativePath.endsWith(path)).map(candidate => candidate.relativePath)
        if (specifier.endsWith('.*')) return false
      }
      const matches = batch.items.filter(candidate => candidates.includes(candidate.relativePath))
      if (matches.length > 1 || (specifier && matches.length === 0)) return false
      if (matches.length && !visit(matches[0]!)) return false
    }
    return true
  }
  if (!visit(start)) return undefined
  // Python package children and Java package-visible names need a broader invalidation
  // boundary than the text adapter can resolve: include every discovered peer module.
  if (start.language === 'python' || start.language === 'java') {
    for (const item of batch.items.filter(item => item.language === start.language)) seen.set(item.relativePath, item.sourceHash)
  }
  return stableDigest([...seen].sort(([a], [b]) => a.localeCompare(b)))
}

/** Reuse content as new review candidates; approval and output outcomes never transfer. */
export function reuseSpecDrafts(batch: SpecBatch, prior: SpecBatch) {
  if (batch.id === prior.id || !samePath(batch.sourceRoot, prior.sourceRoot)) throw new Error('Reuse requires a different batch for the same source folder')
  if (!batch.environmentHash || batch.environmentHash !== prior.environmentHash) throw new Error('Dependency environment changed or was not recorded; create fresh drafts')
  if (batch.recipe.instructions !== prior.recipe.instructions || stableDigest(batch.recipe.guidance ?? null) !== stableDigest(prior.recipe.guidance ?? null)) throw new Error('Task instructions or template changed; create fresh drafts')
  if (!hasCurrentSampleApproval(prior)) throw new Error('The source batch has no current sample approval')
  const progress = specProgress(batch)
  if (progress.phase === 'remaining' && stableDigest(batch.recipe.approvedSamples) !== stableDigest(prior.recipe.approvedSamples)) throw new Error('The approved examples changed; remaining drafts need fresh generation')
  const reused: string[] = []; const skipped: Array<{ id: string; reason: string }> = []
  const items = batch.items.map(item => {
    if (!progress.pending.some(candidate => candidate.id === item.id)) return item
    const old = prior.items.find(candidate => candidate.relativePath === item.relativePath && candidate.language === item.language && candidate.sourceHash === item.sourceHash)
    const fingerprint = dependencyIdentity(batch, item)
    if (!old?.draft || !old.renderedMarkdown || !['ready', 'approved', 'applied'].includes(old.status) || !fingerprint || fingerprint !== dependencyIdentity(prior, old)) { skipped.push({ id: item.id, reason: 'Source, static dependencies, or reusable reviewed draft differs' }); return item }
    const markdown = old.approvedMarkdown ?? old.renderedMarkdown
    validateReviewedMarkdown(markdown, item)
    // Validate structured citations against the new evidence too.
    submitSpecDraft(batch, { moduleId: item.id, draft: old.draft })
    reused.push(item.id)
    return { ...item, draft: old.draft, renderedMarkdown: markdown, renderedHash: renderedHash(markdown), ...(progress.phase === 'samples' ? { approvedMarkdown: markdown } : {}), status: progress.phase === 'samples' ? 'sample-ready' as const : 'ready' as const, reason: undefined, generation: { generatorId: 'dsh-reuse', sourceHash: item.sourceHash, recipeDigest: recipeDigest(batch), cached: true, metadata: { sourceBatchId: prior.id } } }
  })
  return { batch: withSpecDigest({ ...batch, digest: '', items, summary: summarizeSpecItems(items) }), reused, skipped }
}
