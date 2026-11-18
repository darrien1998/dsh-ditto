import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import DshDitto from '../src/dsh/index.js'
import { dittoVersion } from '../src/compat.js'

/** Transport benchmark with identical deterministic fixture drafts; never a model quality benchmark. */
export async function runEfficiencyBenchmark() {
  const root = await mkdtemp(join(tmpdir(), 'ditto-efficiency-'))
  const ctx = new Context()
  try {
    const source = join(root, 'source'); await mkdir(source)
    const sources = Array.from({ length: 30 }, (_, index) => [`m${String(index).padStart(2, '0')}.ts`, `export function run${index}() { return ${index}; }\n`] as const)
    for (const [name, text] of sources) await writeFile(join(source, name), text)
    await ctx.plugin(SkillRegistry, {}); await ctx.plugin(SystemPrompt, {}); await ctx.plugin(Tools, {}); await ctx.plugin(NativeExecutor, {})
    await ctx.plugin(DshDitto, { workspaceRoot: root, stateRoot: '.state', approval: 'agent' })
    let sequence = 0; let calls = 0; let responseBytes = 0
    const call = async (name: string, args: unknown): Promise<any> => {
      const result = (await ctx.tools.execute({ calls: [{ type: 'tool-call', id: `efficiency-${++sequence}` as never, name, arguments: JSON.stringify(args) }], signal: new AbortController().signal })).results[0]!.result
      if (result.isError) throw new Error(result.error.message)
      calls++; responseBytes += Buffer.byteLength(JSON.stringify(result.value))
      return result.value
    }
    const draft = (module: any) => ({ version: 1, moduleId: module.id, purpose: { text: `Documents ${module.relativePath}.`, citations: [module.evidence[0].id] }, responsibilities: [{ text: 'Contains the declaration shown in the source evidence.', citations: [module.evidence[0].id] }] })
    const phases = ['samples', 'remaining'] as const
    const results: Record<string, { toolCalls: number; responseBytes: number }> = {}
    for (const optimized of [false, true]) {
      calls = 0; responseBytes = 0
      const kind = optimized ? 'optimized' : 'singleModule'
      let batch = (await call('ditto_spec_create', { source_root: source, output_root: join(root, kind) })).batch
      let knownContext: string | undefined
      for (const phase of phases) {
        if (optimized) {
          while (true) {
            const work = await call('ditto_spec_work', { batch_id: batch.id, known_context: knownContext })
            knownContext = work.context_id
            if (!work.modules.length) break
            const submitted = await call('ditto_spec_submit_many', { work_id: work.work_id, drafts: work.modules.map((module: any) => ({ module_id: module.id, draft: draft(module) })) })
            batch = submitted.batch
            if (submitted.next !== 'ditto_spec_work') break
          }
        } else {
          const queued: any[] = []; let offset: number | undefined = 0
          do { const queue = await call('ditto_spec_queue', { batch_id: batch.id, phase, offset }); queued.push(...queue.items); offset = queue.page.nextOffset } while (offset !== undefined)
          for (const item of queued) {
            const context = await call('ditto_spec_module', { batch_id: batch.id, module_id: item.id })
            batch = (await call('ditto_spec_submit', { batch_id: batch.id, revision: context.batch.revision, digest: context.batch.digest, module_id: item.id, draft: draft(context.request.module) })).batch
          }
        }
        if (phase === 'samples') {
          const current = await ctx.get('dshDitto').specStatus(batch.id)
          for (const module_id of current.samples) await call('ditto_spec_review', { batch_id: batch.id, module_id })
          batch = (await call('ditto_spec_approve', { batch_id: batch.id, revision: batch.revision, digest: batch.digest })).batch
        }
      }
      let previewOffset: number | undefined = 0
      do {
        const preview = await call('ditto_spec_status', { batch_id: batch.id, offset: previewOffset })
        batch = preview.batch; previewOffset = preview.page.nextOffset
      } while (previewOffset !== undefined)
      await call('ditto_spec_apply', { batch_id: batch.id, revision: batch.revision, digest: batch.digest })
      results[kind] = { toolCalls: calls, responseBytes }
    }
    const identicalOutputs = (await Promise.all(sources.map(async ([name]) => (await readFile(join(root, 'singleModule', name.replace('.ts', '.md')), 'utf8')) === (await readFile(join(root, 'optimized', name.replace('.ts', '.md')), 'utf8'))))).every(Boolean)
    const sourceFilesUnchanged = (await Promise.all(sources.map(async ([name, text]) => await readFile(join(source, name), 'utf8') === text))).every(Boolean)
    if (!identicalOutputs || !sourceFilesUnchanged || results.optimized!.toolCalls >= results.singleModule!.toolCalls || results.optimized!.responseBytes >= results.singleModule!.responseBytes) throw new Error('Efficiency fixture failed equivalence, integrity, or transport reduction checks')
    return { version: dittoVersion(), fixture: '30 synthetic independent one-function TypeScript modules', modelCalls: 0, qualityMeasured: false, metrics: results, comparison: { identicalOutputs, sourceFilesUnchanged, fewerToolCalls: results.singleModule!.toolCalls - results.optimized!.toolCalls, fewerResponseBytes: results.singleModule!.responseBytes - results.optimized!.responseBytes }, limitations: 'Measures actual native tool value JSON UTF-8 bytes and calls on this fixture, not provider input/output tokens, prefix caching, prices, human review time, or model semantic accuracy. Both paths use the current tool catalog. Approval is simulated only for synthetic fixture data.' }
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runEfficiencyBenchmark().then(async result => {
    const output = process.argv.indexOf('--output')
    if (output >= 0) { const file = process.argv[output + 1]; if (!file) throw new Error('--output requires a path'); await writeFile(file, JSON.stringify(result, null, 2) + '\n') }
    console.log(JSON.stringify(result, null, 2))
  }).catch(error => { console.error(error); process.exitCode = 1 })
}
