import { createHash, randomUUID } from 'node:crypto'
import { readFile, lstat, readdir, realpath } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { safeRelative, stableDigest } from '../core/recipe.js'
import { canonicalPath, samePath, within } from '../core/paths.js'
import { DEFAULT_ADAPTERS, adapterFor, validateAdapters, type LanguageAdapter } from './languages/index.js'
import { MAX_SPEC_MODULES, MIN_SPEC_MODULES, type CreateSpecBatchOptions, type EvidenceChunk, type SpecBatch, type SpecBatchSummary, type SpecDiscovery, type SpecExclusion, type SpecModule } from './types.js'

const IGNORED_FOLDERS = new Set(['.git', 'node_modules', '.dsh-ditto', 'dist', 'build', 'out', 'target', 'generated', 'coverage', 'test', 'tests', '__tests__', 'vendor'])
const MAX_SOURCE_BYTES = 1_000_000
const EVIDENCE_LINES = 24

/** Reads source text only. It never imports, evaluates, or executes a discovered module. */
export async function createSpecBatch(options: CreateSpecBatchOptions): Promise<SpecBatch> {
  if (!options || typeof options.sourceRoot !== 'string' || typeof options.outputRoot !== 'string') throw new Error('sourceRoot and outputRoot are required')
  const minModules = options.minModules ?? MIN_SPEC_MODULES; const maxModules = options.maxModules ?? MAX_SPEC_MODULES
  if (!Number.isInteger(minModules) || !Number.isInteger(maxModules) || minModules < MIN_SPEC_MODULES || minModules > maxModules || maxModules > MAX_SPEC_MODULES) throw new Error(`A batch must cover between ${MIN_SPEC_MODULES} and ${MAX_SPEC_MODULES} modules`)
  const adapters = options.adapters ?? DEFAULT_ADAPTERS
  validateAdapters(adapters)
  const sourceRoot = await realpath(options.sourceRoot); const outputRoot = await canonicalPath(options.outputRoot)
  if (pathsOverlap(sourceRoot, outputRoot)) throw new Error('The specification output folder must be separate from and outside the source folder')
  const stateRoot = options.stateRoot ? await canonicalPath(options.stateRoot) : undefined
  // Ditto's own metadata is never read as source text; it is excluded, not fatal, so the
  // common case of running Code-to-Spec over a workspace that holds stateRoot still works.
  if (stateRoot && pathsOverlap(outputRoot, stateRoot)) throw new Error('The specification output folder must not overlap Ditto state metadata')
  if (stateRoot && within(stateRoot, sourceRoot, true)) throw new Error('The specification source folder must not live inside Ditto state metadata')
  const scan = await collectSourceFiles(sourceRoot, maxModules, adapters, stateRoot ? [stateRoot] : [])
  const files = scan.files
  if (files.length < minModules) throw new Error(`At least ${minModules} ${describeLanguages(adapters)} modules are needed; found ${files.length}`)
  const items = await Promise.all(files.map(source => prepareModule(sourceRoot, source, adapters)))
  assertOutputCollisions(items)
  const samples = chooseSamples(items)
  const batch: SpecBatch = {
    version: 'm1', id: randomUUID(), revision: 1, digest: '', createdAt: new Date().toISOString(), sourceRoot, outputRoot,
    recipe: { version: 1, instructions: normalizeInstructions(options.instructions ?? ''), approvedSamples: [] }, discovery: scan.discovery, samples, items,
    summary: summarizeSpecItems(items),
  }
  return withSpecDigest(batch)
}

export async function prepareModule(sourceRoot: string, source: string, adapters: readonly LanguageAdapter[] = DEFAULT_ADAPTERS): Promise<SpecModule> {
  const actual = await realpath(source); const info = await lstat(actual)
  if (!info.isFile() || info.isSymbolicLink() || !within(sourceRoot, actual)) throw new Error(`Links and files outside the source folder are not accepted: ${source}`)
  if (info.size > MAX_SOURCE_BYTES) throw new Error(`Source file is too large: ${source}`)
  const adapter = adapterFor(actual, adapters)
  if (!adapter) throw new Error(`No language adapter claims ${source}`)
  const bytes = await readFile(actual); const text = bytes.toString('utf8')
  if (text.includes('\u0000')) throw new Error(`Source is not a text file Ditto can process: ${source}`)
  const relativePath = relative(sourceRoot, actual).split(sep).join('/')
  safeRelative(relativePath)
  const sourceHash = hash(bytes); const evidence = makeEvidence(relativePath, text)
  const id = `module_${stableDigest(relativePath).slice(0, 20)}`
  return { id, source: actual, relativePath, language: adapter.id, sourceHash, outputPath: outputFor(relativePath), evidence, facts: adapter.structuralFacts(text), status: 'pending' }
}

export function makeEvidence(relativePath: string, text: string): EvidenceChunk[] {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const chunks: EvidenceChunk[] = []
  for (let offset = 0; offset < lines.length; offset += EVIDENCE_LINES) {
    const startLine = offset + 1; const endLine = Math.min(lines.length, offset + EVIDENCE_LINES)
    const chunkText = lines.slice(offset, endLine).join('\n')
    const contentHash = hash(chunkText)
    const id = `ev_${stableDigest({ relativePath, startLine, endLine, contentHash }).slice(0, 24)}`
    chunks.push({ id, relativePath, startLine, endLine, contentHash, text: chunkText })
  }
  return chunks
}

export function outputFor(relativePath: string): string {
  const extension = extname(relativePath); const leaf = basename(relativePath, extension)
  const folder = dirname(relativePath); const result = folder === '.' ? `${leaf}.md` : `${folder}/${leaf}.md`
  return safeRelative(result)
}

/**
 * Three structurally different samples: the richest exporter, the module with
 * the most imports, and the smallest module. This is a deterministic spread,
 * not a confidence score.
 */
export function chooseSamples(items: SpecModule[]): string[] {
  if (items.length < 3) throw new Error('At least three modules are needed for calibration samples')
  const scored = items.map(item => ({ item, score: item.facts.exports.length * 10 + item.facts.imports.length * 4 + Math.min(item.facts.lineCount, 100) / 100 }))
  const selected: SpecModule[] = [[...scored].sort((a, b) => b.score - a.score || a.item.relativePath.localeCompare(b.item.relativePath))[0]!.item]
  const importRich = [...scored].sort((a, b) => b.item.facts.imports.length - a.item.facts.imports.length || a.item.relativePath.localeCompare(b.item.relativePath)).find(candidate => !selected.some(chosen => chosen.id === candidate.item.id))?.item
  if (importRich) selected.push(importRich)
  const next = [...items].sort((a, b) => a.facts.lineCount - b.facts.lineCount || a.relativePath.localeCompare(b.relativePath)).find(item => !selected.some(chosen => chosen.id === item.id))
  if (next) selected.push(next)
  for (const item of items) if (selected.length < 3 && !selected.some(chosen => chosen.id === item.id)) selected.push(item)
  return selected.slice(0, 3).map(item => item.id)
}

export function summarizeSpecItems(items: SpecModule[]): SpecBatchSummary {
  const count = (status: SpecModule['status']) => items.filter(item => item.status === status).length
  return { total: items.length, pending: count('pending'), sampleReady: count('sample-ready'), approved: count('approved'), ready: count('ready'), applied: count('applied'), needsReview: count('needs-review'), rejected: count('rejected'), failed: count('failed') }
}

/** Status and apply outcomes are omitted so a durable interrupted batch retains its reviewed identity. */
export function withSpecDigest(batch: Omit<SpecBatch, 'digest'> & { digest?: string }): SpecBatch {
  const digest = stableDigest({ version: batch.version, id: batch.id, revision: batch.revision, createdAt: batch.createdAt, sourceRoot: batch.sourceRoot, outputRoot: batch.outputRoot, recipe: batch.recipe, discovery: batch.discovery, samples: batch.samples, items: batch.items.map(item => ({ id: item.id, source: item.source, relativePath: item.relativePath, language: item.language, sourceHash: item.sourceHash, outputPath: item.outputPath, evidence: item.evidence, facts: item.facts, draft: item.draft, renderedMarkdown: item.renderedMarkdown, renderedHash: item.renderedHash, approvedMarkdown: item.approvedMarkdown, generation: item.generation && { ...item.generation, cached: undefined } })) })
  return { ...batch, digest } as SpecBatch
}

export function assertOutputCollisions(items: SpecModule[]): void { const seen = new Set<string>(); for (const item of items) { const value = safeRelative(item.outputPath).replace(/[\\/]/g, '/').toLocaleLowerCase('en-US'); if (seen.has(value)) throw new Error(`Two modules would write the same specification file: ${item.outputPath}`); seen.add(value) } }

export function hash(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex') }
export function normalizeInstructions(value: string): string { if (typeof value !== 'string' || value.length > 8_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new Error('Batch instructions are invalid (up to 8,000 characters of plain text)'); return value.trim() }

function describeLanguages(adapters: readonly LanguageAdapter[]): string { return adapters.map(adapter => adapter.displayName).join(' / ') }
function pathsOverlap(a: string, b: string): boolean { return within(a, b, true) || within(b, a, true) }

async function collectSourceFiles(root: string, max: number, adapters: readonly LanguageAdapter[], ignoredRoots: readonly string[] = []): Promise<{ files: string[]; discovery: SpecDiscovery }> {
  const files: string[] = []
  const excluded: SpecExclusion[] = []; const counts: Record<SpecExclusion['reason'], number> = { 'ignored-folder': 0, 'state-folder': 0, 'non-code': 0, 'declaration-file': 0, generated: 0, 'too-large': 0, symlink: 0 }
  const exclude = (path: string, reason: SpecExclusion['reason']) => { counts[reason]++; if (excluded.length < 200) excluded.push({ relativePath: path.split(sep).join('/'), reason }) }
  async function walk(folder: string): Promise<void> {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const candidate = join(folder, entry.name); const relativePath = relative(root, candidate)
      const info = await lstat(candidate)
      if (info.isSymbolicLink()) { exclude(relativePath, 'symlink'); continue }
      const actual = await realpath(candidate)
      if (!within(root, actual) && !samePath(root, actual)) { exclude(relativePath, 'symlink'); continue }
      if (info.isDirectory()) {
        if (ignoredRoots.some(ignored => samePath(ignored, actual))) exclude(relativePath, 'state-folder')
        else if (IGNORED_FOLDERS.has(entry.name)) exclude(relativePath, 'ignored-folder')
        else await walk(actual)
        continue
      }
      if (!info.isFile()) continue
      const adapter = adapterFor(entry.name, adapters)
      if (!adapter) { exclude(relativePath, 'non-code'); continue }
      const reason = adapter.exclude?.(entry.name)
      if (reason) { exclude(relativePath, reason); continue }
      if (info.size > MAX_SOURCE_BYTES) { exclude(relativePath, 'too-large'); continue }
      files.push(actual); if (files.length > max) throw new Error(`The batch exceeds ${max} modules; narrow the source folder or split the work into several batches`)
    }
  }
  await walk(root); files.sort((a, b) => a.localeCompare(b)); excluded.sort((a, b) => a.relativePath.localeCompare(b.relativePath)); return { files, discovery: { inScope: files.length, excludedTotal: Object.values(counts).reduce((sum, count) => sum + count, 0), excludedByReason: counts, excluded } }
}
