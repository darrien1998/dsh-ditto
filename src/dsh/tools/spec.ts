import { defineTool } from '@deepseek-ai/dsh-tools'
import { countConfirmations, hasCurrentSampleApproval } from '../../core/index.js'
import { contextIdentity } from '../../spec/productivity.js'
import type { DshDitto } from '../service.js'
import { checkNotAborted, json, jsonOutput, requireHumanApproval } from './shared.js'

/** Native tools for the reviewed code-to-spec workflow: create → samples → review → approve → remaining → apply. */
export function specTools(service: DshDitto) {
  return [createTool(service), queueTool(service), moduleTool(service), submitTool(service), reviewTool(service), reviseSamplesTool(service), approveTool(service), applyTool(service), statusTool(service)]
}

function createTool(service: DshDitto) {
  return defineTool({
    name: 'ditto_spec_create',
    description: 'Start a reviewed specification batch for TypeScript/JavaScript, Java, or Python. Reads source text and writes metadata only. Optionally select a saved or built-in template. Next call ditto_spec_work for a bounded group and ditto_spec_submit_many for atomic drafts. Existing queue/module/submit tools remain available for fine-grained evidence paging. The DSH agent writes drafts; Ditto never calls a model itself.',
    parameters: {
      source_root: { type: 'string', required: true, description: 'Existing repository folder inside the Ditto workspace. It is read-only.' },
      output_root: { type: 'string', required: true, description: 'Fresh separate output folder inside the Ditto workspace. Markdown specifications are written here only by ditto_spec_apply.' },
      instructions: { type: 'string', description: 'Optional user-approved batch guidance, up to 8,000 characters. It is included in every draft request and has no executable meaning.' },
      template_id: { type: 'string', description: 'Optional built-in or saved task template id from ditto_spec_template.' },
    },
    output: jsonOutput,
    async execute(args, exec) {
      checkNotAborted(exec.signal)
      return json(service.specView(await service.createSpec({ sourceRoot: args.source_root, outputRoot: args.output_root, instructions: args.instructions, templateId: args.template_id }), 0))
    },
  })
}

function queueTool(service: DshDitto) {
  return defineTool({
    name: 'ditto_spec_queue',
    description: 'List bounded pending modules for one specification phase, without changing files. Use phase=samples until all three samples have an explicit ditto_spec_approve approval for the current revision; only then use phase=remaining. Any material ditto_spec_revise_samples edit clears that approval and locks remaining again. Returns module ids, proposed Markdown paths, structural facts, and a nextOffset for paging. Call ditto_spec_module for one module before drafting it. If the batch identity is stale, call ditto_spec_status and continue from its current revision and digest.',
    parameters: {
      batch_id: { type: 'string', required: true, description: 'Batch id returned by ditto_spec_create or ditto_spec_status.' },
      phase: { type: 'string', required: true, enum: ['samples', 'remaining'], description: 'samples lists the three calibration examples. remaining becomes available only after all samples were approved.' },
      offset: { type: 'integer', description: 'Zero-based offset within this phase; default 0. Pass nextOffset to read the next page.' },
      limit: { type: 'integer', description: 'Maximum returned module records; default and maximum come from profile configuration.' },
    },
    output: jsonOutput,
    async execute(args, exec) {
      checkNotAborted(exec.signal)
      const batch = await service.specStatus(args.batch_id)
      const limit = args.limit ?? service.config.resultItems
      const offset = args.offset ?? 0
      service.checkPage(offset, limit)
      if (args.phase === 'remaining' && !hasCurrentSampleApproval(batch)) throw new Error('Remaining modules are locked until ditto_spec_approve approves all three samples for the current revision; after any sample or instruction edit, review and approve again')
      const matching = batch.items.filter(item => args.phase === 'samples' ? batch.samples.includes(item.id) && ['pending', 'needs-review'].includes(item.status) : !batch.samples.includes(item.id) && ['pending', 'needs-review'].includes(item.status))
      const entries = matching.slice(offset, offset + limit).map(item => ({ id: item.id, relativePath: item.relativePath, language: item.language, outputPath: item.outputPath, status: item.status, facts: item.facts, evidenceCount: item.evidence.length }))
      return json({ batch: { id: batch.id, revision: batch.revision, digest: batch.digest }, phase: args.phase, items: entries, page: { offset, returned: entries.length, total: matching.length, ...(offset + entries.length < matching.length ? { nextOffset: offset + entries.length } : {}) } })
    },
  })
}

function moduleTool(service: DshDitto) {
  return defineTool({
    name: 'ditto_spec_module',
    description: 'Get the bounded drafting context for one pending module. Use an id from ditto_spec_queue. It returns real line-numbered evidence and deterministic facts, plus the approved current-revision sample specifications for remaining modules. Generate only a JSON SpecDraft whose moduleId matches this module and whose every factual field cites returned ev_ ids. Page evidence with nextEvidenceOffset; do not infer facts from evidence that was not returned. Remaining modules stay locked until ditto_spec_approve, and lock again after any material sample or instruction edit. Submit the completed JSON through ditto_spec_submit. This tool never calls a model provider itself.',
    parameters: {
      batch_id: { type: 'string', required: true, description: 'Batch id returned by ditto_spec_create or ditto_spec_status.' },
      module_id: { type: 'string', required: true, description: 'A pending module id returned by ditto_spec_queue.' },
      evidence_offset: { type: 'integer', description: 'Zero-based evidence-chunk offset; default 0. Pass nextEvidenceOffset to continue.' },
      evidence_limit: { type: 'integer', description: 'Evidence chunks to return; default and maximum come from profile configuration.' },
      known_context: { type: 'string', description: 'Optional context_id already read and still available in this conversation; omits repeated examples only on exact match.' },
    },
    output: jsonOutput,
    async execute(args, exec) {
      checkNotAborted(exec.signal)
      const batch = await service.specStatus(args.batch_id)
      const item = batch.items.find(candidate => candidate.id === args.module_id)
      if (!item || !['pending', 'needs-review'].includes(item.status)) throw new Error('The requested module is not pending a structured draft')
      const isSample = batch.samples.includes(item.id)
      if (!isSample && !hasCurrentSampleApproval(batch)) throw new Error('This remaining module is locked. Review and call ditto_spec_approve for all three current-revision samples before requesting it')
      const offset = args.evidence_offset ?? 0; const limit = args.evidence_limit ?? service.config.evidenceItems
      if (!Number.isInteger(offset) || offset < 0) throw new Error('evidence_offset must be a non-negative integer')
      if (!Number.isInteger(limit) || limit < 1 || limit > service.config.evidenceItems) throw new Error(`evidence_limit must be an integer from 1 to ${service.config.evidenceItems}`)
      const evidence = item.evidence.slice(offset, offset + limit)
      return json({
        batch: { id: batch.id, revision: batch.revision, digest: batch.digest },
        request: {
          module: { id: item.id, relativePath: item.relativePath, language: item.language, sourceHash: item.sourceHash, outputPath: item.outputPath, facts: item.facts, evidence },
          instructions: batch.recipe.instructions,
          ...(args.known_context === contextIdentity(batch) ? {} : { template: batch.recipe.guidance ?? null }),
          approvedSamples: isSample || args.known_context === contextIdentity(batch) ? [] : approvedSamples(batch.recipe.approvedSamples),
          draftContract: { version: 1, moduleId: item.id, requiredRule: 'Every factual field needs one or more evidence ids returned for this module. Unsupported or uncertain statements belong in confirmations as questions; related evidence ids are optional.' },
        },
        evidencePage: { offset, returned: evidence.length, total: item.evidence.length, ...(offset + evidence.length < item.evidence.length ? { nextEvidenceOffset: offset + evidence.length } : {}) },
      })
    },
  })
}

function submitTool(service: DshDitto) {
  return defineTool({
    name: 'ditto_spec_submit',
    description: 'Validate and persist exactly one agent-produced structured draft. It accepts JSON only, never Markdown or output paths. The draft must use version=1, exactly match module_id, and cite valid evidence ids from ditto_spec_module for factual claims. confirmations are questions and may have relatedEvidenceIds. Invalid citations, unsupported fields, or a stale batch identity are rejected before any Markdown file is written. On error, call ditto_spec_status; for evidence errors, retrieve the module again and repair the JSON. Successful sample drafts become sample-ready; successful remaining drafts become ready for review/apply.',
    parameters: {
      batch_id: { type: 'string', required: true, description: 'Batch id from the latest ditto_spec_status, ditto_spec_queue, or ditto_spec_module result.' },
      revision: { type: 'integer', required: true, description: 'Exact latest batch revision. On mismatch, call ditto_spec_status.' },
      digest: { type: 'string', required: true, description: 'Exact latest batch digest. On mismatch, call ditto_spec_status.' },
      module_id: { type: 'string', required: true, description: 'Pending module id from ditto_spec_queue.' },
      draft: { type: 'json', required: true, description: 'One JSON SpecDraft. title, purpose, responsibilities, publicApi, dependencies, and errors use text plus citations. confirmations use question plus optional relatedEvidenceIds. Never include a path, Markdown, HTML, script, or command.' },
      metadata: { type: 'object', additionalProperties: true, description: 'Optional bounded string-only audit metadata about this draft (for example the model name). Do not include credentials or provider secrets.' },
      compact: { type: 'boolean', description: 'Return only the changed module, counts and next action rather than a full status page.' },
    },
    output: jsonOutput,
    async execute(args, exec) {
      checkNotAborted(exec.signal)
      const batch = await service.submitSpec(args.batch_id, args.revision, args.digest, args.module_id, args.draft, args.metadata as Record<string, string> | undefined)
      return json(args.compact ? service.productivity.delta(batch, [args.module_id]) : service.specView(batch, 0))
    },
  })
}

function reviewTool(service: DshDitto) {
  return defineTool({
    name: 'ditto_spec_review',
    description: 'Read one rendered Markdown specification for user review without writing files. Use it after ditto_spec_submit for a sample before ditto_spec_approve, and for any ready module before ditto_spec_apply. It returns renderer-owned Markdown, its planned output path, the evidence it cites, and how many "Needs confirmation" questions it contains. For a calibration sample, save the user\'s edits with ditto_spec_revise_samples before approval.',
    parameters: {
      batch_id: { type: 'string', required: true, description: 'Batch id returned by ditto_spec_create or ditto_spec_status.' },
      module_id: { type: 'string', required: true, description: 'A generated module id from ditto_spec_queue or ditto_spec_status.' },
    },
    output: jsonOutput,
    async execute(args, exec) {
      checkNotAborted(exec.signal)
      const batch = await service.specStatus(args.batch_id)
      const item = batch.items.find(candidate => candidate.id === args.module_id)
      if (!item || !item.renderedMarkdown) throw new Error('The requested module has no validated rendered specification to review')
      const confirmations = countConfirmations(item.approvedMarkdown ?? item.renderedMarkdown)
      return json({ batch: { id: batch.id, revision: batch.revision, digest: batch.digest }, module: { id: item.id, relativePath: item.relativePath, language: item.language, outputPath: item.outputPath, status: item.status, markdown: item.approvedMarkdown ?? item.renderedMarkdown, renderedHash: item.renderedHash, confirmations, evidence: item.evidence.map(chunk => ({ id: chunk.id, relativePath: chunk.relativePath, startLine: chunk.startLine, endLine: chunk.endLine })) } })
    },
  })
}

function reviseSamplesTool(service: DshDitto) {
  return defineTool({
    name: 'ditto_spec_revise_samples',
    description: 'Persist user-reviewed Markdown edits for zero to three calibration samples, and optionally replace the batch instructions. A material edit changes the recipe revision, clears the prior approval, invalidates held-out drafts, and locks remaining generation until a new ditto_spec_approve. It never writes output specifications. Every factual Markdown line must keep a valid [ev_…] citation for that sample. Only submit edits the user actually requested or approved. Afterwards, review the returned identity and call ditto_spec_approve when all three samples are ready.',
    parameters: {
      batch_id: { type: 'string', required: true, description: 'Batch id returned by ditto_spec_create or ditto_spec_status.' },
      revision: { type: 'integer', required: true, description: 'Exact latest batch revision.' },
      digest: { type: 'string', required: true, description: 'Exact latest batch digest.' },
      sample_edits: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { module_id: { type: 'string', required: true, description: 'One of the three sample module ids.' }, markdown: { type: 'string', required: true, description: 'User-reviewed Markdown for that sample. Preserve valid [ev_…] evidence citations on each factual line.' } } }, description: 'Optional edits for distinct calibration samples. Omit or use an empty list to change only the instructions.' },
      instructions: { type: 'string', description: 'Optional replacement user-approved batch guidance, up to 8,000 characters.' },
    },
    output: jsonOutput,
    async execute(args, exec) {
      checkNotAborted(exec.signal)
      const sampleEdits = args.sample_edits?.map(edit => ({ moduleId: edit.module_id, markdown: edit.markdown }))
      return json(service.specView(await service.reviseSpec(args.batch_id, args.revision, args.digest, { sampleEdits, instructions: args.instructions }), 0))
    },
  })
}

function approveTool(service: DshDitto) {
  return defineTool({
    name: 'ditto_spec_approve',
    description: 'Record approval of all three displayed calibration samples as a versioned, non-executable recipe. Call this only after the user has reviewed the rendered sample Markdown and explicitly approved it. It does not write Markdown outputs. It changes the batch revision and digest; use the returned identity when obtaining and submitting the remaining modules. If a sample needs editing, save the user\'s edits with ditto_spec_revise_samples before approval rather than inventing an unreviewed replacement here.',
    parameters: {
      batch_id: { type: 'string', required: true, description: 'Batch id returned by ditto_spec_create or ditto_spec_status.' },
      revision: { type: 'integer', required: true, description: 'Exact latest batch revision.' },
      digest: { type: 'string', required: true, description: 'Exact latest batch digest.' },
    },
    output: jsonOutput,
    async execute(args, exec) {
      checkNotAborted(exec.signal)
      return json(service.specView(await service.approveSpec(args.batch_id, args.revision, args.digest), 0))
    },
  })
}

function applyTool(service: DshDitto) {
  return defineTool({
    name: 'ditto_spec_apply',
    description: 'Write the reviewed Markdown specifications into the batch output root using the exact displayed revision and digest. Call it only after the user approves the full batch preview; when the DSH host has an approval service, the host asks the user once more before anything is written. It rechecks every source hash, prevents traversal, symlink escapes, collisions, and overwrites, and records actual per-module outcomes for resume. It never edits source files. If rejected as stale, call ditto_spec_status and obtain renewed user review; if a source changed, create a new batch.',
    parameters: {
      batch_id: { type: 'string', required: true, description: 'Batch id returned by ditto_spec_create or ditto_spec_status.' },
      revision: { type: 'integer', required: true, description: 'Exact reviewed batch revision.' },
      digest: { type: 'string', required: true, description: 'Exact reviewed batch digest.' },
    },
    output: jsonOutput,
    async execute(args, exec) {
      checkNotAborted(exec.signal)
      // Refuse a stale identity before presenting any approval prompt.
      const batch = await service.reviewSpecApply(args.batch_id, args.revision, args.digest)
      const pending = batch.items.filter(item => ['ready', 'approved'].includes(item.status)).length
      const approval = await requireHumanApproval({ ctx: service.host, mode: service.config.approval, unavailable: service.config.approvalUnavailable, exec, toolName: 'ditto_spec_apply', reason: `Write ${pending} reviewed Markdown specifications into ${batch.outputRoot} (batch ${batch.id}, revision ${batch.revision}). Source files are never modified.` })
      checkNotAborted(exec.signal)
      const result = await service.applySpec(args.batch_id, args.revision, args.digest)
      checkNotAborted(exec.signal)
      return json({ result: { batchId: result.batchId, revision: result.revision, digest: result.digest, summary: result.summary, approval }, ...service.specView(await service.specStatus(args.batch_id), 0) })
    },
  })
}

function statusTool(service: DshDitto) {
  return defineTool({
    name: 'ditto_spec_status',
    description: 'Read one durable specification batch without changing files. Returns actual per-module statuses, discovery/exclusion accounting, and a bounded page with nextOffset. Use it after any stale, validation, or interrupted-apply error to recover the current revision and digest before retrying.',
    parameters: {
      batch_id: { type: 'string', required: true, description: 'Batch id returned by ditto_spec_create.' },
      offset: { type: 'integer', description: 'Zero-based module offset; default 0. Pass nextOffset to continue.' },
      limit: { type: 'integer', description: 'Module count; default and maximum come from profile configuration.' },
    },
    output: jsonOutput,
    async execute(args, exec) {
      checkNotAborted(exec.signal)
      return json(service.specView(await service.specStatus(args.batch_id), args.offset ?? 0, args.limit ?? service.config.resultItems))
    },
  })
}

/** Core validates the three approved samples against the shared 12k bound. Never truncate reviewed content here. */
function approvedSamples(samples: Array<{ moduleId: string; markdown: string }>): Array<{ moduleId: string; markdown: string }> {
  if (samples.length > 3 || samples.some(sample => sample.markdown.length > 12_000)) throw new Error('An approved sample exceeds the supported native-tool context bound; reload batch status and revise the sample')
  return samples.map(sample => ({ moduleId: sample.moduleId, markdown: sample.markdown }))
}
