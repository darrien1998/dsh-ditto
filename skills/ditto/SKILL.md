---
name: ditto
description: Review-first batch work. Use when a request covers a whole folder or codebase, several similar files or modules, a repeated transformation, batch documentation or organisation, or any batch write that should be reviewed before it happens. Never for a single-file edit or an ordinary question.
whenToUse: Use when the user wants the same thing done to many files or modules and would otherwise have to supervise each one; typical triggers are "every module", "the whole folder", "all of these", "same format for each", "specs/docs for the codebase", or "organise these files". Skip it for one-file edits, normal Q&A, one-off trivial tasks, or when the user opts out of Ditto.
user-invocable: true
---

# Ditto — review a few, ditto the rest

Ditto turns "do the same thing to many files" into one reviewed batch:

discover → choose 3 representative samples → generate the samples → user reviews and edits them → explicit approval → full batch preview → exception review → apply → durable, resumable result.

The user does not need to say "Ditto" or know any tool name. Route on the shape of the work.

## Routing

Use Ditto when the request involves:

- an entire folder or repository, or several similar modules;
- a repeated transformation applied to many files;
- batch documentation (for example, specifications for every module);
- batch file organisation (renaming or grouping copies of files under one rule);
- any batch write the user wants to review before it happens.

Do not use Ditto when:

- the task edits or explains a single file;
- it is an ordinary question or a one-off trivial task;
- the user explicitly says not to use Ditto.

## Rules that always apply

- Nothing is batch-written before the user explicitly approves. Never call `ditto_spec_apply` or `ditto_apply` on your own initiative.
- Show the user what will be written before asking for approval: the three samples first, then the full preview with its exceptions.
- Never invent paths, line numbers, routes, parameters, errors, or behaviour. Every factual statement in a specification draft must cite an evidence id (`ev_…`) that Ditto returned for that module. Put anything unsupported or uncertain under `confirmations` as a question — never state it as a fact.
- A stale revision or digest means the batch changed: read `ditto_spec_status` or `ditto_status`, show the user what changed, and continue from the current identity. A changed source file needs a new batch.
- Ditto never executes or modifies the user's source files, writes only into a separate output folder, and never overwrites existing files. Say so when the user asks what will happen.
- Host approval `unavailable` (including a missing service/agent identity or policy `never`) denies by default. Never retry around or bypass it. Proceed as agent only when the profile explicitly enabled `approvalUnavailable: agent` **and** the reviewed preview was shown and approved conversationally; that fallback is not proof of human approval. Rejection and cancellation always stop.

## Diagnostics

Use `ditto_doctor` when a tool fails because of configuration, component compatibility, missing registrations, or approval availability. It inspects the active plugin and launches no subprocesses. Report failed checks and the configured roots; never change the approval policy to work around a denial.

## Workflow A — Code → Spec (TypeScript / JavaScript, Java, Python)

### Preferred bounded workflow (0.5)

- Optionally list or get `ditto_spec_template`; pass its `template_id` to `ditto_spec_create`. A saved template contains style guidance, never proof of source behaviour or approval of this batch.
- Call `ditto_spec_work` for the next group of complete evidence contexts. Draft only the returned modules, using their own evidence ids, then atomically submit them with `ditto_spec_submit_many` and the opaque `work_id`. The server supplies the phase, identity, counts, and next action.
- Retain the returned shared context. Only send `known_context: context_id` while the exact instructions/examples remain available in this model conversation. After compaction that removes them, a new session, or an agent handoff, omit it to restore full context. Never pretend that an identifier alone carries its content.
- If a module is deferred as too large, use `ditto_spec_module` evidence paging and `ditto_spec_submit` with `compact: true`. Never omit evidence to make a module fit. Increase `max_bytes` for large shared examples within the documented bound.
- Show the three rendered samples and explicitly obtain their approval with `ditto_spec_approve`, then continue work groups for remaining modules. Always show the complete final preview before applying with the existing approval gate.
- For a later run, explicitly identify the previous batch and call `ditto_spec_reuse` before sample approval, review the reused sample candidates, approve the new samples, then call reuse again for remaining modules. Changed/ambiguous items need fresh drafts. Old approval and output statuses never transfer.
- `ditto_spec_template` action `save` preserves approved instructions and examples as a versioned local template. Template changes require new review.
- At completion show `ditto_spec_report`: actual optimized-path calls, UTF-8 bytes and reused modules. These are not token, price, runtime, or semantic-quality measurements. No model API is called by Ditto.

### Fine-grained workflow and evidence paging

1. `ditto_spec_create` with the repository folder and a fresh output folder. It returns the batch identity and three sample module ids.
2. For each sample: `ditto_spec_queue` (phase `samples`) → `ditto_spec_module` for its evidence → write a JSON `SpecDraft` from that evidence only → `ditto_spec_submit`.
3. Show the three rendered samples (`ditto_spec_review`). Ask the user to edit or accept them. Save edits with `ditto_spec_revise_samples`.
4. Only after the user explicitly approves the samples, call `ditto_spec_approve`.
5. `ditto_spec_queue` (phase `remaining`) → for each module, `ditto_spec_module` → draft in the same style as the approved samples → `ditto_spec_submit`.
6. Present the full preview: every module, its output path, its status, and everything under "Needs confirmation". Ask the user to approve the batch.
7. Only after that approval, call `ditto_spec_apply`. Report the per-module results.

## Workflow B — File organisation (copies, never moves)

1. `ditto_preview` with the source folder, a new output folder, an optional naming pattern, and any sidecars/archive already known. Show the proposed names, exceptions, sidecar hashes, and archive destination.
2. When the rule itself is wrong for many files, fix it in one step with `ditto_revise_rule` instead of editing dozens of items one by one. Use `ditto_revise` only for individual exceptions the user asks for. Rule revision can replace reviewed sidecars (`manifest`, `checksums`, `sql-insert`) and set or remove the ZIP archive.
3. Report `diagnostics` back to the user: how many items are ready, how many are exceptions, and why. An item that cannot be named safely is an exception, never a silent skip.
4. Read the reviewed sidecar bytes with `ditto_artifact_review` before asking for approval, and export the whole mapping with `ditto_manifest` when the batch is too large to read page by page. Never present a sidecar you have not read.
5. Only after the user explicitly approves the displayed plan, call `ditto_apply`. Report the per-file results and the `deliverables` (output folder, sidecars, archive) so the user can open the result.
6. `ditto_recipe` can save the reviewed rule for the next batch.

External folders are reachable only when the profile owner listed them in `allowedSourceRoots` / `allowedDestinationRoots`; a relative path always stays inside the workspace. If a preview is refused for that reason, tell the user the exact configuration to add rather than copying data into the workspace.

## Resuming

Batches are durable. If a session was interrupted, `ditto_spec_status` or `ditto_status` returns the current revision, digest, and per-item outcomes; completed items are never redone or overwritten.
