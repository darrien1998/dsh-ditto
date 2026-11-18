import { atomicWriteStateText, readStateText } from '../core/state-paths.js'
import { renderSpecDraft, renderedHash, validateReviewedMarkdown, validateSpecDraft } from './draft.js'
import { hash, normalizeInstructions, summarizeSpecItems, withSpecDigest } from './prepare.js'
import type { GenerateSpecOptions, SpecBatch, SpecBatchEdit, SpecDraft, SpecGenerationResponse, SpecGenerator, SpecModule } from './types.js'

export async function generateSpecBatch(batch: SpecBatch, generator: SpecGenerator, options: GenerateSpecOptions = {}): Promise<SpecBatch> {
  assertSpecBatch(batch); if (!generator || typeof generator.id !== 'string' || generator.id.length < 1 || generator.id.length > 160 || typeof generator.generate !== 'function') throw new Error('Invalid generator contract')
  const only = options.only ?? 'samples'
  if (only === 'remaining' && !hasCurrentSampleApproval(batch)) throw new Error('Approve the current three calibration samples before generating the remaining modules')
  const targets = batch.items.filter(item => only === 'samples' ? batch.samples.includes(item.id) && item.status === 'pending' : !batch.samples.includes(item.id) && item.status === 'pending')
  let current = batch
  for (const item of targets) {
    const result = await generateOne(current, item, generator, options.stateRoot)
    const items = current.items.map(candidate => candidate.id === item.id ? result : candidate)
    current = withSpecDigest({ ...current, digest: '', items, summary: summarizeSpecItems(items) })
  }
  return current
}

/** Safe boundary for DSH/UI model integration: validate and render one structured model response. */
export function submitSpecDraft(batch: SpecBatch, input: { moduleId: string; draft: unknown; metadata?: Record<string, string>; generatorId?: string }): SpecBatch {
  assertSpecBatch(batch); const item = batch.items.find(candidate => candidate.id === input.moduleId)
  if (!item || !['pending', 'needs-review'].includes(item.status)) throw new Error('This module is not accepting a draft right now')
  if (!batch.samples.includes(item.id) && !hasCurrentSampleApproval(batch)) throw new Error('Remaining modules are locked until all three calibration samples are approved for the current revision')
  validateMetadata(input.metadata); validateSpecDraft(input.draft, item)
  const draft = input.draft as SpecDraft; const markdown = renderSpecDraft(draft, item)
  const status = batch.samples.includes(item.id) ? 'sample-ready' as const : 'ready' as const
  const updated: SpecModule = { ...item, draft, renderedMarkdown: markdown, renderedHash: renderedHash(markdown), status, reason: undefined, generation: { generatorId: input.generatorId ?? 'external', sourceHash: item.sourceHash, recipeDigest: recipeDigest(batch), cached: false, ...(input.metadata ? { metadata: input.metadata } : {}) } }
  const items = batch.items.map(candidate => candidate.id === item.id ? updated : candidate)
  return withSpecDigest({ ...batch, digest: '', items, summary: summarizeSpecItems(items) })
}

export function reviseSpecBatch(batch: SpecBatch, edit: SpecBatchEdit): SpecBatch {
  assertSpecBatch(batch); if (!edit || typeof edit !== 'object') throw new Error('Invalid batch edit')
  const instructions = edit.instructions === undefined ? batch.recipe.instructions : normalizeInstructions(edit.instructions)
  const changes = new Map((edit.sampleEdits ?? []).map(change => [change.moduleId, change.markdown]))
  if (changes.size !== (edit.sampleEdits?.length ?? 0) || [...changes.keys()].some(id => !batch.samples.includes(id))) throw new Error('Only the three calibration samples can be edited')
  const normalizedChanges = new Map<string, string>()
  for (const [id, markdown] of changes) {
    const item = batch.items.find(candidate => candidate.id === id)!
    if (!['sample-ready', 'approved'].includes(item.status)) throw new Error('The sample has no specification to edit yet')
    validateReviewedMarkdown(markdown, item); normalizedChanges.set(id, markdown.replace(/\r\n/g, '\n'))
  }
  const materialChange = instructions !== batch.recipe.instructions || [...normalizedChanges].some(([id, markdown]) => batch.items.find(item => item.id === id)?.approvedMarkdown !== markdown)
  if (!materialChange) return batch
  if (batch.items.some(item => item.status === 'applied')) throw new Error('Specifications were already written; samples and instructions can no longer be recalibrated')
  const items = batch.items.map(item => {
    if (batch.samples.includes(item.id)) {
      const approvedMarkdown = normalizedChanges.get(item.id) ?? item.approvedMarkdown
      return { ...item, ...(approvedMarkdown ? { approvedMarkdown } : {}), status: 'sample-ready' as const }
    }
    return { ...item, status: 'pending' as const, reason: undefined, draft: undefined, renderedMarkdown: undefined, renderedHash: undefined, generation: undefined }
  })
  return withSpecDigest({ ...batch, revision: batch.revision + 1, digest: '', recipe: { ...batch.recipe, instructions, approvedSamples: [], approvalRevision: undefined }, items, summary: summarizeSpecItems(items) })
}

export function approveSpecSamples(batch: SpecBatch): SpecBatch {
  assertSpecBatch(batch)
  if (batch.items.some(item => item.status === 'applied')) throw new Error('Specifications were already written; samples cannot be re-approved')
  if (!batch.samples.every(id => batch.items.find(item => item.id === id)?.status === 'sample-ready')) throw new Error('All three samples need a rendered specification that has been reviewed before approval')
  const approvedSamples = batch.samples.map(id => {
    const item = batch.items.find(candidate => candidate.id === id)!; const markdown = item.approvedMarkdown ?? item.renderedMarkdown
    if (!markdown) throw new Error('The sample has no specification yet')
    validateReviewedMarkdown(markdown, item); return { moduleId: id, markdown }
  }).sort((a, b) => a.moduleId.localeCompare(b.moduleId))
  const revision = batch.revision + 1
  const items = batch.items.map(item => batch.samples.includes(item.id)
    ? { ...item, status: 'approved' as const, approvedMarkdown: approvedSamples.find(sample => sample.moduleId === item.id)!.markdown, renderedMarkdown: approvedSamples.find(sample => sample.moduleId === item.id)!.markdown, renderedHash: renderedHash(approvedSamples.find(sample => sample.moduleId === item.id)!.markdown) }
    : item)
  return withSpecDigest({ ...batch, revision, digest: '', recipe: { ...batch.recipe, approvedSamples, approvalRevision: revision }, items, summary: summarizeSpecItems(items) })
}

export function recipeDigest(batch: Pick<SpecBatch, 'recipe'>): string { return hash(JSON.stringify(batch.recipe)) }

/**
 * The single approval gate shared by core, the local workbench, and the native
 * tools: the recipe must record all three current samples at this revision, and
 * each sample's approved Markdown must still match the recipe.
 */
export function hasCurrentSampleApproval(batch: SpecBatch): boolean {
  const approved = batch.recipe.approvedSamples.map(sample => sample.moduleId).sort()
  return batch.recipe.approvalRevision === batch.revision && approved.length === 3 && new Set(approved).size === 3 && approved.join('\u0000') === [...batch.samples].sort().join('\u0000') && batch.samples.every(id => { const item = batch.items.find(candidate => candidate.id === id); const example = batch.recipe.approvedSamples.find(sample => sample.moduleId === id); return (item?.status === 'approved' || item?.status === 'applied') && item.approvedMarkdown === example?.markdown })
}

export function assertSpecBatch(batch: unknown): asserts batch is SpecBatch {
  if (!batch || typeof batch !== 'object') throw new Error('Invalid specification batch')
  const value = batch as SpecBatch
  if (value.version !== 'm1' || typeof value.id !== 'string' || !/^[0-9a-f-]{16,64}$/i.test(value.id) || !Number.isInteger(value.revision) || value.revision < 1 || !/^[a-f0-9]{64}$/i.test(value.digest) || !Array.isArray(value.items) || value.items.length < 1 || value.items.length > 50 || !Array.isArray(value.samples) || value.samples.length !== 3 || new Set(value.samples).size !== 3 || value.samples.some(id => !value.items.some(item => item.id === id)) || !value.recipe || value.recipe.version !== 1 || !value.discovery || value.discovery.inScope !== value.items.length || !Number.isInteger(value.discovery.excludedTotal) || !Array.isArray(value.discovery.excluded)) throw new Error('Invalid specification batch')
  normalizeInstructions(value.recipe.instructions)
  if (value.environmentHash !== undefined && !/^[a-f0-9]{64}$/.test(value.environmentHash)) throw new Error('Invalid batch environment hash')
  if (value.recipe.guidance !== undefined) {
    const guide = value.recipe.guidance
    if (!guide || typeof guide.id !== 'string' || guide.id.length > 80 || typeof guide.name !== 'string' || guide.name.length > 80 || !/^[a-f0-9]{64}$/.test(guide.digest) || !Array.isArray(guide.examples) || guide.examples.length > 3 || guide.examples.some(example => !example || typeof example.moduleId !== 'string' || typeof example.markdown !== 'string' || example.markdown.length > 12_000)) throw new Error('Invalid batch style guidance')
  }
  for (const item of value.items) assertSpecModule(item)
  const approvedIds = value.recipe.approvedSamples.map(sample => sample.moduleId)
  if (approvedIds.length > 3 || new Set(approvedIds).size !== approvedIds.length || approvedIds.some(id => !value.samples.includes(id)) || (approvedIds.length === 0 && value.recipe.approvalRevision !== undefined) || (approvedIds.length > 0 && value.recipe.approvalRevision !== value.revision)) throw new Error('The batch approval record is invalid')
  for (const sample of value.recipe.approvedSamples) validateReviewedMarkdown(sample.markdown, value.items.find(item => item.id === sample.moduleId)!)
  const hasApprovalRecord = hasCurrentSampleApproval(value)
  if (value.items.some(item => item.status === 'approved' && (!value.samples.includes(item.id) || !item.approvedMarkdown)) || value.items.some(item => !value.samples.includes(item.id) && ['ready', 'applied'].includes(item.status) && (!hasApprovalRecord || item.generation?.recipeDigest !== recipeDigest(value)))) throw new Error('The batch skipped the sample approval workflow')
  if (withSpecDigest({ ...value, digest: '' }).digest !== value.digest) throw new Error('The batch review digest is invalid')
}

function assertSpecModule(item: SpecModule): void {
  if (!item || typeof item.id !== 'string' || typeof item.source !== 'string' || typeof item.relativePath !== 'string' || typeof item.language !== 'string' || typeof item.outputPath !== 'string' || !/^[a-f0-9]{64}$/i.test(item.sourceHash) || !['pending', 'sample-ready', 'approved', 'ready', 'applied', 'needs-review', 'rejected', 'failed'].includes(item.status) || !Array.isArray(item.evidence) || !item.evidence.length) throw new Error('Invalid specification module')
  if (item.draft) validateSpecDraft(item.draft, item)
  if (item.renderedMarkdown && (!item.renderedHash || renderedHash(item.renderedMarkdown) !== item.renderedHash)) throw new Error('The specification Markdown hash is invalid')
}
function validateMetadata(metadata: unknown): void { if (metadata === undefined) return; if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || Object.keys(metadata).length > 30 || Object.entries(metadata as Record<string, unknown>).some(([key, value]) => key.length > 80 || typeof value !== 'string' || value.length > 500)) throw new Error('Generation metadata is invalid (up to 30 short string entries)') }

async function generateOne(batch: SpecBatch, item: SpecModule, generator: SpecGenerator, stateRoot?: string): Promise<SpecModule> {
  try {
    const cached = stateRoot ? await loadCache(stateRoot, item, batch, generator.id) : undefined
    const response = cached ?? await generator.generate({ module: { id: item.id, relativePath: item.relativePath, language: item.language, sourceHash: item.sourceHash, evidence: item.evidence, facts: item.facts }, instructions: batch.recipe.instructions, approvedSamples: batch.recipe.approvedSamples })
    validateMetadata(response.metadata); validateSpecDraft(response.draft, item)
    const draft = response.draft; const markdown = renderSpecDraft(draft, item)
    if (stateRoot && !cached) await saveCache(stateRoot, item, batch, generator.id, response)
    return { ...item, draft, renderedMarkdown: markdown, renderedHash: renderedHash(markdown), status: batch.samples.includes(item.id) ? 'sample-ready' : 'ready', reason: undefined, generation: { generatorId: generator.id, sourceHash: item.sourceHash, recipeDigest: recipeDigest(batch), cached: Boolean(cached), ...(response.metadata ? { metadata: response.metadata } : {}) } }
  } catch (error: unknown) { return { ...item, status: 'needs-review', reason: (error instanceof Error ? error.message : 'Specification generation failed').slice(0, 300) } }
}
function cacheLeaf(item: SpecModule, batch: SpecBatch, generatorId: string): string { return `${hash(`${item.sourceHash}:${recipeDigest(batch)}:${generatorId}`)}.json` }
async function loadCache(stateRoot: string, item: SpecModule, batch: SpecBatch, generatorId: string): Promise<SpecGenerationResponse | undefined> {
  try {
    const data: unknown = JSON.parse(await readStateText(stateRoot, 'spec-cache', cacheLeaf(item, batch, generatorId)))
    if (!data || typeof data !== 'object') return undefined
    const response = data as SpecGenerationResponse
    validateSpecDraft(response.draft, item)
    validateMetadata(response.metadata)
    return response
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError || (error instanceof Error && /draft|metadata|evidence|module/i.test(error.message))) return undefined
    throw error
  }
}
async function saveCache(stateRoot: string, item: SpecModule, batch: SpecBatch, generatorId: string, response: SpecGenerationResponse): Promise<void> {
  await atomicWriteStateText(stateRoot, 'spec-cache', cacheLeaf(item, batch, generatorId), `${JSON.stringify(response)}\n`)
}
