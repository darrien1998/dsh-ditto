# Less repeated agent work

Ditto 0.5 moves deterministic bookkeeping into native tools. It does not call a model or choose one.

## Preferred workflow

1. Optionally list `ditto_spec_template`; create a batch with `template_id` and task instructions.
2. Call `ditto_spec_work` with `batch_id`. Default: up to three complete modules within 32,000 response bytes. Bounds: 1–5 modules and 4,000–192,000 bytes.
3. Read the evidence and draft one structured specification per returned module. Submit with `ditto_spec_submit_many`, `work_id`, and `drafts: [{ module_id, draft }]`. Validation is atomic: one invalid draft saves none. Receipts bind module ids and the current batch identity; competing submissions make old receipts stale.
4. Review all three samples and approve the exact revision/digest. Continue work/submit-many for remaining modules.
5. Page through the complete preview and review rendered Markdown, then approve apply. Existing approval and source/hash/no-overwrite checks still apply.

Pass `known_context` only when the exact returned `context_id` content remains available in the current conversation. The id is a comparison handle, not model memory. After context loss, compaction or a handoff, omit it to restore shared instructions, guidance and approved examples. A changed recipe automatically returns new context. Evidence is never silently truncated: oversized modules return a deferred id with instructions to use `ditto_spec_module` evidence paging and single submission.

Existing queue/module/submit tools remain available. Single submission optionally accepts `compact: true`; defaults remain compatible.

## Incremental draft reuse

Create a new batch for the same source folder, then call `ditto_spec_reuse` with its current identity and `source_batch_id`. Reused samples are candidates for fresh review. Approve those samples in the new batch, then call reuse again for remaining modules. Saving or reusing content never grants approval.

Reuse requires matching instructions/template, recorded workspace dependency/config manifests and current source hashes. Remaining drafts also require identical approved examples. The text dependency analysis follows discovered local imports transitively; unresolved or ambiguous imports and recognized dynamic loading disable reuse. Python and Java additionally fingerprint all discovered modules of their language. Known root manifests are capped at 2 MB and may not be linked. Applying reused drafts rechecks the recorded environment.

This is a conservative text-based cache boundary, not a compiler, runtime dependency proof or semantic correctness guarantee. Unrecorded configuration, external runtime state and model assumptions still need review. Old batches without environment fingerprints cannot be reused; create fresh drafts. Guidance examples are style references, never evidence for another module. Saved templates are local, integrity-checked snapshots of instructions and three approved examples.

## Measured transport overhead

Run `npm run benchmark:efficiency`. [Recorded result](efficiency-result.json): 30 synthetic independent one-function TypeScript modules, actual native executor, deterministic identical drafts, sample review, approval, complete paged preview and apply on both paths.

| Path | Tool calls | Response JSON UTF-8 bytes |
|---|---:|---:|
| Single-module queue/module/submit | 71 | 251,651 |
| Work/submit-many with retained context | 28 | 54,549 |

The fixture asserts identical output Markdown, unchanged source bytes, fewer calls and fewer response bytes. Temporary path lengths can slightly change byte totals. Both paths use the current tool catalog; this is not a historical version comparison. CI runs the same check on Windows/Ubuntu and Node 24/26.

No models or API keys are used. These figures do not measure provider tokens, prompt caching, prices, latency, human review effort or semantic accuracy. Approval is simulated only for synthetic fixtures.

`ditto_spec_report` persists counters for work/submit-many responses and reused modules under local state. Legacy calls and review time are outside its scope; token/cost fields are null. Compare real workloads with the method in [EVALUATION.md](EVALUATION.md) before making broader claims.
