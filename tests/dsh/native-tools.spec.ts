import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { afterEach, describe, expect, it } from 'vitest'
import { DshDitto, TOOL_NAMES, dittoSkill } from '../../src/dsh/index.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function host(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SkillRegistry, {})
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  await ctx.plugin(NativeExecutor, {})
  return ctx
}

describe('Ditto native tools on the published Cordis + ToolRuntime', () => {
  it('diagnoses the active host and reports approval availability', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-ditto-diagnostic-'))
    roots.push(root)
    const ctx = await host()
    try {
      ctx.provide('profileContext', { name: 'custom-profile', home: join(root, 'dsh-home') })
      await ctx.plugin(DshDitto, { workspaceRoot: root })
      const report = value(await call(ctx, 'ditto_doctor', {}))
      expect(report.ok).toBe(true)
      expect(report.checks).toEqual(expect.arrayContaining([expect.objectContaining({ label: '18 of 18 tools registered', status: 'ok' }), expect.objectContaining({ label: 'approval host', status: 'warn' })]))
      expect(report.checks).toContainEqual(expect.objectContaining({ label: expect.stringContaining('profile "custom-profile" is not initialised') }))
    } finally { await ctx.fiber.dispose() }
  })
  it('registers the bundled skill from SKILL.md and every catalogued tool, and removes them on unload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-ditto-routing-'))
    roots.push(root)
    const ctx = await host()
    const dittoTools = () => ctx.tools.schemas().map(tool => tool.name).filter(name => name.startsWith('ditto')).sort()
    const fiber = await ctx.plugin(DshDitto, { workspaceRoot: root, stateRoot: join(root, '.dsh-ditto-state') })

    const expected = dittoSkill()
    expect(await ctx.skills.list()).toContainEqual(expect.objectContaining({ name: 'ditto', source: 'bundled', invocation: { modelInvocable: true, userInvocable: true } }))
    expect(await ctx.skills.get('ditto')).toMatchObject({ description: expected.description, whenToUse: expected.whenToUse, content: expected.content })
    expect(dittoTools()).toEqual([...TOOL_NAMES].sort())
    expect(ctx.get('dshDitto')).toBeInstanceOf(DshDitto)

    await fiber.dispose()
    expect(dittoTools()).toEqual([])
    expect((await ctx.skills.list()).some(skill => skill.name === 'ditto')).toBe(false)
    expect(ctx.get('dshDitto')).toBeUndefined()

    const again = await ctx.plugin(DshDitto, { workspaceRoot: root, stateRoot: join(root, '.dsh-ditto-state') })
    expect(dittoTools()).toHaveLength(TOOL_NAMES.length)
    await again.dispose()
    await ctx.fiber.dispose()
  })

  it('registers through the real ToolRuntime, obeys pre-dispatch denials, and only copies after an exact review', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-ditto-native-'))
    roots.push(root)
    const source = join(root, 'incoming')
    const output = join(root, 'organized')
    const state = join(root, '.dsh-ditto-state')
    await mkdir(source)
    await writeFile(join(source, 'invoice.txt'), 'unchanged source', { encoding: 'utf8' })

    const ctx = await host()
    await ctx.plugin(DshDitto, { workspaceRoot: root, stateRoot: state, approval: 'agent', maxItems: 20, resultItems: 10 })

    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual(expect.arrayContaining([...TOOL_NAMES]))

    const preview = await call(ctx, 'ditto_preview', { source_root: source, destination_root: output, pattern: '2026-{stem}' })
    expect(preview.isError).toBe(false)
    const previewValue = value(preview)
    let plan = previewValue.plan as { id: string; revision: number; digest: string }
    expect(previewValue.items).toHaveLength(1)
    expect(await readFile(join(source, 'invoice.txt'), 'utf8')).toBe('unchanged source')

    const pageItem = (previewValue.items as Array<{ id: string }>)[0]!
    const revised = value(await call(ctx, 'ditto_revise', { plan_id: plan.id, revision: plan.revision, edits: [{ id: pageItem.id, destination: 'text/reviewed-invoice.txt' }] }))
    plan = revised.plan as typeof plan
    expect(plan.revision).toBe(2)
    expect(value(await call(ctx, 'ditto_status', { plan_id: plan.id, offset: 0, limit: 1 })).page).toMatchObject({ total: 1, returned: 1 })

    const savedRecipe = value(await call(ctx, 'ditto_recipe', { action: 'save', plan_id: plan.id, name: 'Invoices' }))
    const recipeId = (savedRecipe.recipe as { id: string }).id
    expect(value(await call(ctx, 'ditto_recipe', { action: 'list' })).recipes).toEqual(expect.arrayContaining([expect.objectContaining({ id: recipeId })]))
    expect((value(await call(ctx, 'ditto_recipe', { action: 'get', recipe_id: recipeId })).recipe as { id: string }).id).toBe(recipeId)

    const guard = ctx.tools.guard(exec => exec.name === 'ditto_apply' ? 'test guard denies copy' : undefined)
    const guarded = await call(ctx, 'ditto_apply', { plan_id: plan.id, revision: plan.revision, digest: plan.digest })
    expect(guarded.isError).toBe(true)
    await expect(readFile(join(output, 'text', 'reviewed-invoice.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    guard()

    const preExecute = ctx.on('tools/pre-execute', async (exec, next) => exec.name === 'ditto_apply' ? { kind: 'deny', reason: 'test pre-execute denies copy' } : next())
    const denied = await call(ctx, 'ditto_apply', { plan_id: plan.id, revision: plan.revision, digest: plan.digest })
    expect(denied.isError).toBe(true)
    await expect(readFile(join(output, 'text', 'reviewed-invoice.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    preExecute()

    const stale = await call(ctx, 'ditto_apply', { plan_id: plan.id, revision: 1, digest: plan.digest })
    expect(stale.isError).toBe(true)

    const applied = await call(ctx, 'ditto_apply', { plan_id: plan.id, revision: plan.revision, digest: plan.digest })
    expect(applied.isError).toBe(false)
    expect((value(applied).result as { approval: string }).approval).toBe('agent')
    expect(await readFile(join(output, 'text', 'reviewed-invoice.txt'), 'utf8')).toBe('unchanged source')
    expect(await readFile(join(source, 'invoice.txt'), 'utf8')).toBe('unchanged source')

    // State lives beside the input. A later preview therefore sees only the real source.
    const again = value(await call(ctx, 'ditto_preview', { source_root: source, destination_root: join(root, 'organized-again') }))
    expect(again.page).toMatchObject({ total: 1 })

    const escaped = await call(ctx, 'ditto_preview', { source_root: join(root, '..'), destination_root: join(root, 'x') })
    expect(escaped.isError).toBe(true)
    if (process.platform === 'win32') {
      // A junction inside the workspace that points outside is resolved before the boundary check, so it cannot smuggle writes out.
      const outside = await mkdtemp(join(tmpdir(), 'dsh-ditto-outside-')); roots.push(outside)
      await symlink(outside, join(root, 'escape-link'), 'junction')
      const viaJunction = await call(ctx, 'ditto_preview', { source_root: source, destination_root: join(root, 'escape-link', 'out') })
      expect(viaJunction.isError).toBe(true)
      expect(viaJunction.isError && viaJunction.error.message).toContain('inside the Ditto workspace')
    }
    await ctx.fiber.dispose()
  })

  it('runs the agent-driven evidence/draft loop through the real native runtime and keeps apply behind guards', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-ditto-spec-native-'))
    roots.push(root)
    const source = join(root, 'source')
    const output = join(root, 'specifications')
    const state = join(root, '.dsh-ditto')
    await mkdir(source)
    for (let index = 1; index <= 12; index++) await writeFile(join(source, `module-${index}.ts`), `export function module${index}(value: string) { return value }\n`, 'utf8')

    const ctx = await host()
    await ctx.plugin(DshDitto, { workspaceRoot: root, stateRoot: state, approval: 'agent', resultItems: 20, evidenceItems: 4 })

    let batch = (value(await call(ctx, 'ditto_spec_create', { source_root: source, output_root: output, instructions: 'Write in plain English.' })).batch as { id: string; revision: number; digest: string; samples: string[] })
    expect(batch.samples).toHaveLength(3)
    const initialStatus = value(await call(ctx, 'ditto_spec_status', { batch_id: batch.id, offset: 0, limit: 1 }))
    expect((initialStatus.batch as { discovery: { inScope: number; excludedTotal: number } }).discovery).toMatchObject({ inScope: 12 })
    expect((initialStatus.items as Array<{ language: string; confirmations: number }>)[0]).toMatchObject({ language: 'typescript', confirmations: 0 })
    const sampleQueue = value(await call(ctx, 'ditto_spec_queue', { batch_id: batch.id, phase: 'samples' }))
    expect(sampleQueue.page).toMatchObject({ total: 3 })
    await expectCallError(ctx, 'ditto_spec_submit', {
      batch_id: batch.id, revision: batch.revision, digest: batch.digest, module_id: batch.samples[0],
      draft: draft(batch.samples[0]!, 'ev_000000000000000000000000'),
    })

    for (const moduleId of batch.samples) {
      const context = value(await call(ctx, 'ditto_spec_module', { batch_id: batch.id, module_id: moduleId }))
      const evidenceId = evidenceIdFrom(context)
      const submitted = value(await call(ctx, 'ditto_spec_submit', { batch_id: batch.id, revision: batch.revision, digest: batch.digest, module_id: moduleId, draft: draft(moduleId, evidenceId, moduleId === batch.samples[2]) }))
      batch = submitted.batch as typeof batch
    }
    const review = value(await call(ctx, 'ditto_spec_review', { batch_id: batch.id, module_id: batch.samples[2] }))
    expect((review.module as { confirmations: number }).confirmations).toBe(1)
    const reviewedMarkdown = ((value(await call(ctx, 'ditto_spec_review', { batch_id: batch.id, module_id: batch.samples[0] }))).module as { markdown: string }).markdown
    batch = (value(await call(ctx, 'ditto_spec_revise_samples', { batch_id: batch.id, revision: batch.revision, digest: batch.digest, sample_edits: [{ module_id: batch.samples[0], markdown: reviewedMarkdown }], instructions: 'Write in plain English.' })).batch as typeof batch)
    await expectCallError(ctx, 'ditto_spec_queue', { batch_id: batch.id, phase: 'remaining' })

    batch = (value(await call(ctx, 'ditto_spec_approve', { batch_id: batch.id, revision: batch.revision, digest: batch.digest })).batch as typeof batch)
    expect(batch.revision).toBe(3)
    const remaining = value(await call(ctx, 'ditto_spec_queue', { batch_id: batch.id, phase: 'remaining', limit: 20 }))
    const remainingIds = (remaining.items as Array<{ id: string }>).map(item => item.id)
    expect(remainingIds).toHaveLength(9)
    for (const moduleId of remainingIds) {
      const context = value(await call(ctx, 'ditto_spec_module', { batch_id: batch.id, module_id: moduleId, evidence_limit: 4 }))
      expect((context.request as { approvedSamples: unknown[] }).approvedSamples).toHaveLength(3)
      const submitted = value(await call(ctx, 'ditto_spec_submit', { batch_id: batch.id, revision: batch.revision, digest: batch.digest, module_id: moduleId, draft: draft(moduleId, evidenceIdFrom(context)) }))
      batch = submitted.batch as typeof batch
    }

    const guard = ctx.tools.guard(exec => exec.name === 'ditto_spec_apply' ? 'test guard denies specification writes' : undefined)
    await expectCallError(ctx, 'ditto_spec_apply', { batch_id: batch.id, revision: batch.revision, digest: batch.digest })
    await expect(readFile(join(output, 'module-1.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    guard()

    const preExecute = ctx.on('tools/pre-execute', async (exec, next) => exec.name === 'ditto_spec_apply' ? { kind: 'deny', reason: 'test pre-execute denies specification writes' } : next())
    await expectCallError(ctx, 'ditto_spec_apply', { batch_id: batch.id, revision: batch.revision, digest: batch.digest })
    await expect(readFile(join(output, 'module-1.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    preExecute()

    const applied = value(await call(ctx, 'ditto_spec_apply', { batch_id: batch.id, revision: batch.revision, digest: batch.digest }))
    expect((applied.result as { summary: { applied: number }; approval: string })).toMatchObject({ summary: expect.objectContaining({ applied: 12 }), approval: 'agent' })
    expect(await readFile(join(output, 'module-1.md'), 'utf8')).toContain('# Module module_')
    expect(await readFile(join(source, 'module-1.ts'), 'utf8')).toBe('export function module1(value: string) { return value }\n')
    await ctx.fiber.dispose()
  })

  it('excludes durable state when a source folder contains it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-ditto-native-'))
    roots.push(root)
    const source = join(root, 'incoming')
    const state = join(source, '.dsh-ditto-state')
    await mkdir(state, { recursive: true })
    await writeFile(join(source, 'one.txt'), 'one', { encoding: 'utf8' })
    await writeFile(join(state, 'old-plan.json'), 'not a source file', { encoding: 'utf8' })
    const ctx = await host()
    await ctx.plugin(DshDitto, { workspaceRoot: root, stateRoot: state })
    const result = value(await call(ctx, 'ditto_preview', { source_root: source, destination_root: join(root, 'output') }))
    expect(result.page).toMatchObject({ total: 1 })
    await ctx.fiber.dispose()
  })
})

let callNumber = 0
async function call(ctx: Context, name: string, arguments_: unknown) {
  const batch = await ctx.tools.execute({ calls: [{ type: 'tool-call', id: `native-${++callNumber}` as never, name, arguments: JSON.stringify(arguments_) }], signal: new AbortController().signal })
  return batch.results[0]!.result
}

function value(result: ToolExecutionResult): Record<string, unknown> {
  if (result.isError) throw new Error(result.error.message)
  return result.value as Record<string, unknown>
}

function draft(moduleId: string, evidenceId: string, withQuestion = false) {
  return { version: 1, moduleId, title: { text: `Module ${moduleId}`, citations: [evidenceId] }, purpose: { text: 'Exports one function.', citations: [evidenceId] }, ...(withQuestion ? { confirmations: [{ question: 'Is the return value ever transformed?', relatedEvidenceIds: [evidenceId] }] } : {}) }
}

function evidenceIdFrom(context: Record<string, unknown>): string {
  const request = context.request as { module: { evidence: Array<{ id: string }> } }
  return request.module.evidence[0]!.id
}

async function expectCallError(ctx: Context, name: string, arguments_: unknown): Promise<void> {
  expect((await call(ctx, name, arguments_)).isError).toBe(true)
}
