import { randomUUID } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { stableDigest } from '../core/recipe.js'
import { atomicWriteStateText, listStateLeaves, readStateText } from '../core/state-paths.js'
import { assertNoLinkAncestor } from '../core/paths.js'
import { contextIdentity, environmentHash, hash, hasCurrentSampleApproval, normalizeInstructions, reuseSpecDrafts, saveSpecBatch, specIdentity, specProgress, submitSpecDrafts, type SpecBatch, type SpecGuidance } from '../spec/index.js'
import type { DshDitto } from './service.js'
import { withMutation } from './tools/shared.js'

interface WorkReceipt { version: 1; id: string; batchId: string; revision: number; digest: string; moduleIds: string[] }
interface TaskTemplate { version: 1; id: string; name: string; instructions: string; examples: SpecGuidance['examples']; digest: string }
interface Metrics { version: 1; workCalls: number; submitCalls: number; modulesDelivered: number; draftsSubmitted: number; contextBytesDelivered: number; contextBytesOmitted: number }
const emptyMetrics = (): Metrics => ({ version: 1, workCalls: 0, submitCalls: 0, modulesDelivered: 0, draftsSubmitted: 0, contextBytesDelivered: 0, contextBytesOmitted: 0 })
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8')
const ID = /^[0-9a-f-]{16,64}$/i
const BUILTINS = [
  { id: 'overview', name: 'Module overview', instructions: 'Write a concise module overview: purpose, responsibilities, public API and dependencies. Put unsupported behaviour under confirmations.' },
  { id: 'api-reference', name: 'API reference', instructions: 'Focus on the source-visible public API, parameter names, types where visible, and explicit errors. Cite each factual API entry; do not infer runtime contracts.' },
  { id: 'behavior-before-refactor', name: 'Behaviour before refactor', instructions: 'Document source-visible behaviour, explicit branches and edge cases before a refactor. Separate uncertain runtime assumptions into confirmations; never claim that tests or execution were performed.' },
].map(entry => ({ ...entry, version: 1 as const, examples: [], digest: stableDigest({ ...entry, examples: [] }) }))

/** Native workflow orchestration. Receipts, metrics, and templates are local state, never write approvals. */
export class SpecProductivity {
  constructor(private readonly service: DshDitto) {}
  private get root() { return this.service.config.stateRoot }

  delta(batch: SpecBatch, ids: string[] = []) {
    const progress = specProgress(batch)
    return { batch: specIdentity(batch), phase: progress.phase, summary: batch.summary, changed: batch.items.filter(item => ids.includes(item.id)).map(item => ({ id: item.id, relativePath: item.relativePath, status: item.status, confirmations: item.draft?.confirmations?.length ?? 0 })), next: progress.next }
  }

  async work(batchId: string, input: { maxModules?: number; maxBytes?: number; knownContext?: string } = {}) {
    const max = input.maxModules ?? 3; const budget = input.maxBytes ?? 32_000
    if (!Number.isInteger(max) || max < 1 || max > 5 || !Number.isInteger(budget) || budget < 4_000 || budget > 192_000) throw new Error('Use max_modules from 1 to 5 and max_bytes from 4000 to 192000')
    return withMutation(this.root, `spec:${batchId}`, async () => {
      const batch = await this.service.specStatus(batchId)
      const progress = specProgress(batch)
      const contextId = contextIdentity(batch)
      const shared = { instructions: batch.recipe.instructions, template: batch.recipe.guidance ?? null, approvedSamples: batch.recipe.approvedSamples, draftContract: 'Submit JSON SpecDraft version 1. Every factual field cites evidence ids from its own module. Put uncertainty under confirmations. Style examples never supply evidence for another module.' }
      const output = { ...this.delta(batch), work_id: randomUUID(), context_id: contextId, ...(input.knownContext === contextId ? {} : { context: shared }), modules: [] as Array<Record<string, unknown>>, deferred: [] as Array<{ id: string; reason: string }>, contextBytes: 0 }
      if (bytes(output) > budget) throw new Error('The shared review context exceeds max_bytes; increase the budget or retrieve reviewed samples separately')
      for (const item of progress.pending) {
        if (output.modules.length >= max) break
        const module = { id: item.id, relativePath: item.relativePath, language: item.language, outputPath: item.outputPath, facts: item.facts, evidence: item.evidence, draftSeed: { version: 1, moduleId: item.id, title: { text: item.relativePath, citations: [item.evidence[0]!.id] } } }
        const candidate = { ...output, modules: [...output.modules, module] }
        // Reserve room for the byte counter and an oversized-module instruction.
        if (bytes(candidate) + 350 > budget) {
          if (!output.modules.length) { output.next = 'ditto_spec_module'; output.deferred.push({ id: item.id, reason: 'Complete evidence exceeds this work budget; use ditto_spec_module with evidence paging, then ditto_spec_submit' }); break }
          continue
        }
        output.modules.push(module)
      }
      if (output.modules.length) {
        const receipt: WorkReceipt = { version: 1, id: output.work_id, batchId, revision: batch.revision, digest: batch.digest, moduleIds: output.modules.map(item => item.id as string) }
        await atomicWriteStateText(this.root, 'spec-work', `${receipt.id}.json`, JSON.stringify(receipt))
      }
      for (let attempt = 0; attempt < 5 && output.contextBytes !== bytes(output); attempt++) output.contextBytes = bytes(output)
      if (bytes(output) > budget) throw new Error('Work context exceeds max_bytes; increase the budget')
      await this.record(batchId, { workCalls: 1, modulesDelivered: output.modules.length, contextBytesDelivered: bytes(output), contextBytesOmitted: input.knownContext === contextId ? bytes(shared) : 0 })
      return output
    })
  }

  async submit(workId: string, drafts: Array<{ moduleId: string; draft: unknown; metadata?: Record<string, string> }>) {
    if (!ID.test(workId)) throw new Error('Invalid work_id')
    const receipt = JSON.parse(await readStateText(this.root, 'spec-work', `${workId}.json`)) as WorkReceipt
    if (receipt.version !== 1 || receipt.id !== workId || !ID.test(receipt.batchId) || !Array.isArray(receipt.moduleIds) || receipt.moduleIds.length > 5) throw new Error('Invalid work receipt')
    return withMutation(this.root, `spec:${receipt.batchId}`, async () => {
      const batch = await this.service.specStatus(receipt.batchId)
      if (batch.revision !== receipt.revision || batch.digest !== receipt.digest) throw new Error('The work receipt is stale; call ditto_spec_work again for the current batch')
      if (!Array.isArray(drafts) || drafts.some(entry => !entry || !receipt.moduleIds.includes(entry.moduleId))) throw new Error('Only modules from this work receipt may be submitted')
      const next = submitSpecDrafts(batch, drafts)
      await saveSpecBatch(next, this.root)
      const result = this.delta(next, drafts.map(entry => entry.moduleId))
      await this.record(batch.id, { submitCalls: 1, draftsSubmitted: drafts.length, contextBytesDelivered: bytes(result) })
      return result
    })
  }

  async reuse(batchId: string, revision: number, digest: string, sourceBatchId: string) {
    return withMutation(this.root, `spec:${batchId}`, async () => {
      const batch = await this.service.specStatus(batchId)
      if (batch.revision !== revision || batch.digest !== digest) throw new Error('The batch changed; call ditto_spec_status before reusing drafts')
      const prior = await this.service.specStatus(sourceBatchId)
      if (batch.environmentHash !== await environmentHash(this.service.config.workspaceRoot)) throw new Error('Dependency environment changed since discovery; create a new batch')
      // Re-read the current snapshot, not the old output. Changed sources must be rediscovered.
      for (const item of batch.items) {
        await assertNoLinkAncestor(item.source, 'Source links cannot be reused')
        const info = await lstat(item.source)
        if (!info.isFile() || info.isSymbolicLink() || info.size > 1_048_576) throw new Error('A source changed since discovery; create a new batch before reuse')
        if (hash(await readFile(item.source)) !== item.sourceHash) throw new Error('A source changed since discovery; create a new batch before reuse')
      }
      const reused = reuseSpecDrafts(batch, prior)
      await saveSpecBatch(reused.batch, this.root)
      return { ...this.delta(reused.batch, reused.reused), reused: reused.reused.length, skipped: reused.skipped, approvalTransferred: false }
    })
  }

  async report(batchId: string) {
    const batch = await this.service.specStatus(batchId)
    const metrics = await this.metrics(batchId)
    const reused = batch.items.filter(item => item.generation?.generatorId === 'dsh-reuse').length
    return { batch: specIdentity(batch), summary: batch.summary, optimizedPath: metrics, reuse: { modules: reused, total: batch.items.length, sourceBatchIds: [...new Set(batch.items.flatMap(item => item.generation?.generatorId === 'dsh-reuse' ? [item.generation.metadata?.sourceBatchId] : []))] }, measurement: { unit: 'UTF-8 bytes of optimized tool JSON responses', tokens: null, cost: null, scope: 'ditto_spec_work and ditto_spec_submit_many only; legacy calls and human review time are not measured', modelQualityMeasured: false }, next: specProgress(batch).next }
  }

  async template(action: 'list' | 'get' | 'save', input: { id?: string; batchId?: string; name?: string } = {}) {
    if (action === 'get') return { template: await this.getTemplate(input.id ?? '') }
    if (action === 'save') {
      const batch = await this.service.specStatus(input.batchId ?? '')
      if (!hasCurrentSampleApproval(batch)) throw new Error('Approve the current samples before saving a task template')
      if (typeof input.name !== 'string' || input.name.trim().length < 1 || input.name.length > 80 || /[\u0000-\u001f]/.test(input.name)) throw new Error('A task template needs a plain-text name of 1 to 80 characters')
      const body = { version: 1 as const, id: randomUUID(), name: input.name.trim(), instructions: batch.recipe.instructions, examples: batch.recipe.approvedSamples }
      const template = { ...body, digest: stableDigest(body) }
      await atomicWriteStateText(this.root, 'spec-templates', `${template.id}.json`, JSON.stringify(template))
      return { template }
    }
    if (action !== 'list') throw new Error('Template action must be list, get, or save')
    let leaves: string[] = []
    try { leaves = await listStateLeaves(this.root, 'spec-templates') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const ids = leaves.filter(name => /^[0-9a-f-]{16,64}\.json$/i.test(name)).sort()
    if (ids.length > 100) throw new Error('More than 100 saved templates; retrieve one by id')
    const templates = [...BUILTINS, ...await Promise.all(ids.map(name => this.getTemplate(name.slice(0, -5))))]
    return { templates: templates.map(({ id, name, digest, examples }) => ({ id, name, digest, examples: examples.length })) }
  }

  async getTemplate(id: string): Promise<TaskTemplate> {
    const builtin = BUILTINS.find(template => template.id === id)
    if (builtin) return builtin
    if (!ID.test(id)) throw new Error('Unknown task template id')
    const template = JSON.parse(await readStateText(this.root, 'spec-templates', `${id}.json`)) as TaskTemplate
    const { digest, ...body } = template
    if (template.version !== 1 || template.id !== id || typeof template.name !== 'string' || template.name.length > 80 || !Array.isArray(template.examples) || template.examples.length > 3 || template.examples.some(example => typeof example?.moduleId !== 'string' || typeof example.markdown !== 'string' || example.markdown.length > 12_000) || digest !== stableDigest(body)) throw new Error('Saved task template failed integrity validation')
    normalizeInstructions(template.instructions)
    return template
  }

  private async metrics(batchId: string): Promise<Metrics> {
    try {
      const value = JSON.parse(await readStateText(this.root, 'spec-metrics', `${batchId}.json`)) as Metrics
      if (value.version !== 1 || Object.keys(emptyMetrics()).some(key => !Number.isSafeInteger(value[key as keyof Metrics]) || value[key as keyof Metrics] < 0)) throw new Error('Invalid saved productivity metrics')
      return value
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyMetrics(); throw error }
  }
  private async record(batchId: string, delta: Partial<Omit<Metrics, 'version'>>) {
    const metrics = await this.metrics(batchId)
    for (const [key, value] of Object.entries(delta)) metrics[key as keyof Omit<Metrics, 'version'>] += value
    await atomicWriteStateText(this.root, 'spec-metrics', `${batchId}.json`, JSON.stringify(metrics))
  }
}
