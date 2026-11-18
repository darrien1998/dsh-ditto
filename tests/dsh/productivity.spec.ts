import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { afterEach, describe, expect, it } from 'vitest'
import DshDitto from '../../src/dsh/index.js'
import { dependencyIdentity, hasCurrentSampleApproval, type SpecBatch } from '../../src/spec/index.js'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function setup(count = 8) {
  const root = await mkdtemp(join(tmpdir(), 'ditto-productivity-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source'); await mkdir(source)
  for (let index = 0; index < count; index++) await writeFile(join(source, `m${String(index).padStart(2, '0')}.ts`), `export function run${index}() { return ${index}; }\n`)
  const ctx = new Context(); cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(SkillRegistry, {}); await ctx.plugin(SystemPrompt, {}); await ctx.plugin(Tools, {}); await ctx.plugin(NativeExecutor, {})
  await ctx.plugin(DshDitto, { workspaceRoot: root, stateRoot: '.state', approval: 'agent' })
  const service = ctx.get('dshDitto')
  const create = (folder: string, templateId?: string) => service.createSpec({ sourceRoot: source, outputRoot: join(root, folder), templateId })
  return { root, source, ctx, service, create }
}

function drafts(work: Awaited<ReturnType<DshDitto['productivity']['work']>>) {
  return work.modules.map(module => {
    const item = module as unknown as { id: string; relativePath: string; evidence: Array<{ id: string }> }
    return { moduleId: item.id, draft: { version: 1, moduleId: item.id, purpose: { text: `Documents ${item.relativePath}.`, citations: [item.evidence[0]!.id] } } }
  })
}

async function complete(service: DshDitto, original: SpecBatch) {
  let batch = original
  for (const phase of ['samples', 'remaining']) {
    while (true) {
      const work = await service.productivity.work(batch.id)
      if (!work.modules.length) break
      await service.productivity.submit(work.work_id, drafts(work))
    }
    batch = await service.specStatus(batch.id)
    if (phase === 'samples') batch = await service.approveSpec(batch.id, batch.revision, batch.digest)
  }
  return service.specStatus(batch.id)
}

describe('bounded native specification workflow', () => {
  it('dispatches real work/submit batches, shares context by exact identity, and returns compact deltas', async () => {
    const { create, ctx, service, root } = await setup()
    const batch = await create('out')
    const call = async (name: string, args: unknown) => {
      const result = (await ctx.tools.execute({ calls: [{ type: 'tool-call', id: 'productivity-call' as never, name, arguments: JSON.stringify(args) }], signal: new AbortController().signal })).results[0]!.result
      if (result.isError) throw new Error(result.error.message)
      return result.value as any
    }
    const work = await call('ditto_spec_work', { batch_id: batch.id })
    expect(work.modules).toHaveLength(3); expect(work.context).toBeDefined()
    expect(Buffer.byteLength(JSON.stringify(work))).toBe(work.contextBytes)
    const submitted = await call('ditto_spec_submit_many', { work_id: work.work_id, drafts: drafts(work).map(entry => ({ module_id: entry.moduleId, draft: entry.draft })) })
    expect(submitted.changed).toHaveLength(3); expect(submitted.items).toBeUndefined()
    expect(submitted.next).toBe('review_samples_then_ditto_spec_approve')
    const samples = await service.specStatus(batch.id)
    await service.approveSpec(samples.id, samples.revision, samples.digest)
    const remaining = await service.productivity.work(batch.id)
    expect(remaining.context?.approvedSamples).toHaveLength(3)
    const compact = await service.productivity.work(batch.id, { knownContext: remaining.context_id })
    expect(compact.context).toBeUndefined()
    const restored = await service.productivity.work(batch.id, { knownContext: 'wrong-or-reset-context' })
    expect(restored.context).toEqual(remaining.context)
    const report = await call('ditto_spec_report', { batch_id: batch.id })
    expect(report.optimizedPath.contextBytesOmitted).toBeGreaterThan(0)
    expect(report.measurement.tokens).toBeNull(); expect(report.measurement.modelQualityMeasured).toBe(false)
    expect(await readdir(root)).not.toContain('out')
  })

  it('rolls back every draft on an invalid entry, rejects duplicates/unrelated modules, and refuses stale receipts', async () => {
    const { create, service } = await setup()
    const batch = await create('out')
    const work = await service.productivity.work(batch.id)
    const entries = drafts(work)
    const invalid = structuredClone(entries); (invalid[1]!.draft.purpose.citations as string[]) = ['ev_000000000000000000000000']
    await expect(service.productivity.submit(work.work_id, invalid)).rejects.toThrow('evidence')
    expect((await service.specStatus(batch.id)).digest).toBe(batch.digest)
    await expect(service.productivity.submit(work.work_id, [entries[0]!, entries[0]!])).rejects.toThrow('distinct')
    await expect(service.productivity.submit(work.work_id, [{ ...entries[0]!, moduleId: 'other' }])).rejects.toThrow('receipt')
    await service.productivity.submit(work.work_id, entries)
    await expect(service.productivity.submit(work.work_id, entries)).rejects.toThrow('stale')
  })

  it('enforces byte limits and explicitly defers oversized complete evidence to paging', async () => {
    const { source, create, service } = await setup()
    await writeFile(join(source, 'm00.ts'), 'export const huge = 1;\n' + '// lengthy text\n'.repeat(1000))
    const batch = await create('out')
    const work = await service.productivity.work(batch.id, { maxBytes: 4000 })
    expect(Buffer.byteLength(JSON.stringify(work))).toBeLessThanOrEqual(4000)
    expect(work.modules).toHaveLength(0); expect(work.deferred).toHaveLength(1)
    expect(work.next).toBe('ditto_spec_module')
    await expect(service.productivity.work(batch.id, { maxBytes: 100 })).rejects.toThrow('max_bytes')
    await expect(service.productivity.work(batch.id, { maxModules: 6 })).rejects.toThrow('max_modules')
  })

  it('retains metrics after a new plugin mount', async () => {
    const { create, service, root } = await setup()
    const batch = await create('out'); await service.productivity.work(batch.id)
    const ctx = new Context(); cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(SkillRegistry, {}); await ctx.plugin(SystemPrompt, {}); await ctx.plugin(Tools, {})
    await ctx.plugin(DshDitto, { workspaceRoot: root, stateRoot: '.state' })
    expect((await ctx.get('dshDitto').productivity.report(batch.id)).optimizedPath.workCalls).toBe(1)
  })
})

describe('reviewed reuse and task templates', () => {
  it('rejects review and apply if the dependency environment changes after reuse', async () => {
    const { create, service, root } = await setup()
    const prior = await complete(service, await create('first'))
    let batch = await create('second')
    await service.productivity.reuse(batch.id, batch.revision, batch.digest, prior.id)
    batch = await service.specStatus(batch.id)
    await writeFile(join(root, 'package.json'), '{"changed":true}')
    await expect(service.reviewSpecApply(batch.id, batch.revision, batch.digest)).rejects.toThrow('environment changed')
    await expect(service.applySpec(batch.id, batch.revision, batch.digest)).rejects.toThrow('environment changed')
  })

  it('reuses unchanged candidates across batches, never transfers approval, and regenerates only changed held-out content', async () => {
    const { create, service, source } = await setup()
    const prior = await complete(service, await create('first'))
    const target = prior.items.find(item => !prior.samples.includes(item.id))!
    await writeFile(join(source, target.relativePath), 'export function changed() { return 99; }\n')
    let next = await create('second')
    const samples = await service.productivity.reuse(next.id, next.revision, next.digest, prior.id)
    expect(samples.reused).toBe(3)
    next = await service.specStatus(next.id)
    expect(hasCurrentSampleApproval(next)).toBe(false)
    await expect(service.applySpec(next.id, next.revision, next.digest)).rejects.toThrow('preview')
    next = await service.approveSpec(next.id, next.revision, next.digest)
    const remaining = await service.productivity.reuse(next.id, next.revision, next.digest, prior.id)
    expect(remaining.reused).toBe(4); expect(remaining.skipped).toHaveLength(1)
    const work = await service.productivity.work(next.id)
    expect(work.modules).toHaveLength(1)
    await service.productivity.submit(work.work_id, drafts(work))
    next = await service.specStatus(next.id)
    const result = await service.applySpec(next.id, next.revision, next.digest)
    expect(result.summary.applied).toBe(8)
    expect((await service.productivity.report(next.id)).reuse.modules).toBe(7)
  })

  it('invalidates reuse on dependency manifests, instruction changes, or a source edited after discovery', async () => {
    const { create, service, root, source } = await setup()
    const prior = await complete(service, await create('first'))
    const different = await create('different-instructions')
    const revised = await service.reviseSpec(different.id, different.revision, different.digest, { instructions: 'Different task instructions' })
    await expect(service.productivity.reuse(revised.id, revised.revision, revised.digest, prior.id)).rejects.toThrow('instructions')
    const next = await create('second')
    await writeFile(join(source, 'm07.ts'), 'changed after discovery')
    await expect(service.productivity.reuse(next.id, next.revision, next.digest, prior.id)).rejects.toThrow('source changed')
    await writeFile(join(root, 'package-lock.json'), '{"new":true}')
    await expect(service.productivity.reuse(next.id, next.revision, next.digest, prior.id)).rejects.toThrow('environment changed')
    const third = await create('third')
    await expect(service.productivity.reuse(third.id, third.revision, third.digest, prior.id)).rejects.toThrow('environment changed')
  })

  it('tracks transitive local imports and refuses dynamic or unresolved local dependencies', async () => {
    const { source, create } = await setup()
    await writeFile(join(source, 'm04.ts'), "import { value } from './m05'; export const one = value;\n")
    await writeFile(join(source, 'm05.ts'), "import { value } from './m07'; export { value };\n")
    const before = await create('one')
    const item = before.items.find(item => item.relativePath === 'm04.ts')!
    await writeFile(join(source, 'm07.ts'), 'export const value = 999;\n')
    const after = await create('two')
    expect(dependencyIdentity(before, item)).not.toBe(dependencyIdentity(after, after.items.find(candidate => candidate.id === item.id)!))
    await writeFile(join(source, 'm04.ts'), "import { x } from './missing'; export { x };\n")
    const missing = await create('three')
    expect(dependencyIdentity(missing, missing.items.find(item => item.relativePath === 'm04.ts')!)).toBeUndefined()
    await writeFile(join(source, 'm04.ts'), 'export const x = require(process.env.MODULE);\n')
    const dynamic = await create('four')
    expect(dependencyIdentity(dynamic, dynamic.items.find(item => item.relativePath === 'm04.ts')!)).toBeUndefined()
  })

  it('saves versioned approved examples as guidance without approving a new batch, and rejects tampering', async () => {
    const { create, service, root } = await setup()
    let batch = await create('first', 'api-reference')
    await expect(service.productivity.template('save', { batchId: batch.id, name: 'API style' })).rejects.toThrow('Approve')
    batch = await complete(service, batch)
    const saved = await service.productivity.template('save', { batchId: batch.id, name: 'API style' }) as { template: { id: string } }
    const next = await create('second', saved.template.id)
    const work = await service.productivity.work(next.id)
    expect(work.context?.template?.examples).toHaveLength(3)
    expect(hasCurrentSampleApproval(next)).toBe(false)
    const path = join(root, '.state', 'spec-templates', saved.template.id + '.json')
    const json = JSON.parse(await readFile(path, 'utf8')); json.instructions = 'tampered'
    await writeFile(path, JSON.stringify(json))
    await expect(service.productivity.getTemplate(saved.template.id)).rejects.toThrow('integrity')
  })
})
