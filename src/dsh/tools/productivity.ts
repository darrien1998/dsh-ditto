import { defineTool } from '@deepseek-ai/dsh-tools'
import type { DshDitto } from '../service.js'
import { checkNotAborted, json, jsonOutput } from './shared.js'

/** High-level bounded workflow; every write approval stays on the existing apply tools. */
export function productivityTools(service: DshDitto) {
  return [
    defineTool({
      name: 'ditto_spec_work',
      description: 'Get the next bounded group of complete module evidence (one to five modules) and an opaque work_id for atomic submission. Phase and next action are server-owned. Shared instructions and approved examples are included unless known_context exactly matches context_id and that context is still present in THIS model conversation. Omit known_context after a new session, context reset, or agent handoff. Oversized modules explicitly require ditto_spec_module evidence paging; never infer unseen source. Writes only a work receipt and observational counters.',
      parameters: { batch_id: { type: 'string', required: true }, max_modules: { type: 'integer', description: '1 to 5; default 3.' }, max_bytes: { type: 'integer', description: 'UTF-8 JSON response budget, 4000 to 192000; default 32000.' }, known_context: { type: 'string', description: 'Previously read context_id, only while its exact context remains available in this conversation.' } },
      output: jsonOutput,
      async execute(args, exec) { checkNotAborted(exec.signal); return json(await service.productivity.work(args.batch_id, { maxModules: args.max_modules, maxBytes: args.max_bytes, knownContext: args.known_context })) },
    }),
    defineTool({
      name: 'ditto_spec_submit_many',
      description: 'Atomically validate one to five structured drafts using the work_id from ditto_spec_work. Every module must belong to that exact receipt; a stale or partially invalid submission changes no draft. Returns only changed items, counts, and the next action. No source or Markdown files are written. After success get a new work receipt; do not reuse a stale work_id.',
      parameters: { work_id: { type: 'string', required: true }, drafts: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { module_id: { type: 'string', required: true }, draft: { type: 'json', required: true }, metadata: { type: 'object', additionalProperties: true } } } } },
      output: jsonOutput,
      async execute(args, exec) { checkNotAborted(exec.signal); return json(await service.productivity.submit(args.work_id, args.drafts.map(entry => ({ moduleId: entry.module_id, draft: entry.draft, metadata: entry.metadata as Record<string, string> | undefined })))) },
    }),
    defineTool({
      name: 'ditto_spec_reuse',
      description: 'Reuse valid reviewed drafts from an explicit previous batch of the same source folder. Checks current source hashes, dependency manifests, static local dependency closure, instructions, template, and approved sample identity. Before sample approval it reuses only samples as NEW review candidates; call it again after renewed sample approval for remaining modules. Never transfers approval or output outcomes. Returns reused and skipped items; changed or ambiguous modules need new drafts.',
      parameters: { batch_id: { type: 'string', required: true }, revision: { type: 'integer', required: true }, digest: { type: 'string', required: true }, source_batch_id: { type: 'string', required: true } },
      output: jsonOutput,
      async execute(args, exec) { checkNotAborted(exec.signal); return json(await service.productivity.reuse(args.batch_id, args.revision, args.digest, args.source_batch_id)) },
    }),
    defineTool({
      name: 'ditto_spec_report',
      description: 'Read durable optimized-path tool-call counts, exact UTF-8 response bytes, omitted repeated context bytes, reuse coverage, and batch outcomes. Counters cover work/submit_many only. Tokens, prices, time saved, and model quality are not measured and are never invented. Launches no model or network calls.',
      parameters: { batch_id: { type: 'string', required: true } }, output: jsonOutput,
      async execute(args, exec) { checkNotAborted(exec.signal); return json(await service.productivity.report(args.batch_id)) },
    }),
    defineTool({
      name: 'ditto_spec_template',
      description: 'List/get built-in or saved task templates, or save current approved sample instructions and examples as a versioned local template. Built-ins: overview, api-reference, behavior-before-refactor. Pass template_id to ditto_spec_create to reuse guidance in a new batch. Style examples never supply source evidence, and every new batch still requires sample and final-preview approval.',
      parameters: { action: { type: 'string', required: true, enum: ['list', 'get', 'save'] }, template_id: { type: 'string' }, batch_id: { type: 'string', description: 'Current sample-approved batch for save.' }, name: { type: 'string', description: 'Plain-text saved template name, 1 to 80 characters.' } }, output: jsonOutput,
      async execute(args, exec) { checkNotAborted(exec.signal); return json(await service.productivity.template(args.action, { id: args.template_id, batchId: args.batch_id, name: args.name })) },
    }),
  ]
}
