# Safety by design

Version 0.6 keyboard controls use the existing approval buttons and server routes. `tests/ui/keyboard.test.ts` executes both shipped client scripts and checks sample navigation, typing/composition/repeat exclusions, disabled/busy actions, no submission on focus, and unchanged revision/digest/CSRF requests on activation. `tests/spec/sample-selection.test.ts` checks role coverage, near-duplicate avoidance and order-independent selection; persisted sample ids are not recalculated.

Version 0.5 productivity gates are covered by `tests/dsh/productivity.spec.ts`: complete evidence byte budgets, context restoration, atomic multi-draft rollback, duplicate/unrelated/stale receipts, durable counters, source/dependency/environment/instruction invalidation, fresh approval after reuse, environment recheck before apply, and template integrity. Reuse is a text-based draft cache, not semantic verification; see [EFFICIENCY.md](EFFICIENCY.md).

**Your source stays untouched. Nothing is batch-written before approval. Ditto does not execute source code or SQL and does not store model API keys.**

These guarantees are enforced in code and covered by `npm test` plus the real-host smokes. Please report any bypass through [SECURITY.md](../SECURITY.md).

## Guarantees and where they live

| Guarantee | Enforced in | Covered by |
|---|---|---|
| Preview writes no source/output bytes; it saves review metadata only under `stateRoot` | `createPlan`, `createSpecBatch`, service preview methods | `tests/core/m0.test.ts`; `tests/dsh/native-tools.spec.ts` |
| Sources are read-only: never executed, imported, modified, moved, deleted, or used as SQL | spec preparation reads text; file apply copies bytes; SQL renderer emits text only | `tests/spec/m1.test.ts`; `tests/dsh/v02-roots-rules.spec.ts` 174-file source comparison |
| Source and output trees must be separate in both directions; neither may violate the state boundary | `createPlan`, `createSpecBatch`, `checkedFileRoots`, `checkedPersistedPlanRoots` | `tests/core/boundaries.test.ts`; `tests/dsh/v02-roots-rules.spec.ts` |
| File organisation may use only profile-owned role allowlists; relative paths, state, and Code → Spec remain workspace-bound | `resolveRoleRoot`, `checkedFileRoots`, `checkedRoots`, persisted-root revalidation | `tests/dsh/v02-roots-rules.spec.ts` external-root, role, revoked-root, and spec-isolation cases |
| Existing destinations, sidecars, and archives are never overwritten or silently adopted | `COPYFILE_EXCL`/`wx`, durable intent checks, exact-hash adoption | `tests/core/m0.test.ts` non-overwrite, interrupted-copy/sidecar/archive, unrelated archive cases |
| Source and output hashes are rechecked before, during, and after copy | `applyItem`, spec `preflight`, archive input inspection | `tests/core/m0.test.ts`; `tests/spec/m1.test.ts` |
| Apply and review require the exact persisted id/revision/digest; stale identities are rejected **before** approval prompts | `reviewApply`, `reviewSpecApply`, `applyPlan`, `applySpecBatch` | `tests/dsh/native-tools.spec.ts`; `tests/dsh/v02-roots-rules.spec.ts` stale artifact review |
| Persisted summaries are not trusted; summary/diagnostics are derived from item/artifact state | `withDigest`, `summarize`, `diagnose`, storage load | `tests/core/m0.test.ts`; plugin approval tests |
| Path traversal, absolute paths, drive/UNC escapes, Windows device names, trailing dots/spaces, and extension changes are rejected | `safeRelative`, root-aware `assertNoLinkAncestor`, `validateDestinationExtension` | `tests/core/m0.test.ts`; Windows CI; `tests/dsh/v02-roots-rules.spec.ts` |
| State root, categories, locks, temporary files, and leaves cannot be redirected through links/junctions | `stateCategoryPath`, `stateLeafPath`, `atomicWriteStateText`, `withStateLock` | `tests/dsh/v02-roots-rules.spec.ts` durable-state link cases; `tests/core/m0.test.ts` lock serialization |
| RE2 matching is linear-time; lookarounds, backreferences, alternation, nested quantifiers, unsafe captures, and oversized inputs fail closed | `validateMatch`, `re2-wasm`, capture/template validation | `tests/core/m0.test.ts`; `tests/dsh/v02-roots-rules.spec.ts` |
| Exact, case-insensitive, and ancestor/descendant collisions across files, sidecars, and archive are rejected | `withCollisionExceptions`, `assertNoArtifactCollisions` | `tests/core/m0.test.ts`; `tests/dsh/v02-roots-rules.spec.ts` |
| Exceptions remain visible in diagnostics and the complete manifest and are never written; valid items still apply | proposal disposition in the digest; manifest renderer | `tests/core/m0.test.ts`; 174-file and manifest tests |
| Sidecar bytes, renderer identity, paths, and hashes are reviewed; apply rerenders and verifies them | `renderArtifacts`, `reviewArtifact`, plan digest | `tests/core/artifacts.test.ts`; `tests/dsh/v02-roots-rules.spec.ts` |
| SQL sidecars permit validated identifiers and escaped literal templates only; no raw statement templates, comments, commands, connection, or execution | `validateSidecar`, `renderSql` | `tests/core/artifacts.test.ts`; SQL rejection/integration tests |
| CSV neutralises `=`, `+`, `-`, `@`, tab, and CR formula prefixes; Markdown escapes active table/markup characters | `csvCell`, `markdownCell` | `tests/core/artifacts.test.ts` |
| ZIP contains exactly reviewed successful outputs, never walks the destination, never includes itself, and is streamed deterministically | `prepareReviewedArchive`, `writeZipFile` | `tests/dsh/v02-roots-rules.spec.ts` exact central-directory checks, including 174 files |
| Classic ZIP limits are explicit: ≤65,535 entries, each entry/offset/archive below 4 GiB; unsupported Zip64-sized batches fail closed | `inspectZipFile`, `writeZipFile` | ZIP limit checks in the core writer |
| Crash recovery adopts only an exact copy/sidecar/archive hash backed by a persisted intent; unrelated same-content output still fails | `copyIntent`, artifact `applying`, `archiveState` | `tests/core/m0.test.ts` durable interrupted-output cases |
| Mutations are serialised across callers and DSH processes sharing one `stateRoot` | in-process queues plus atomic `withStateLock` directories | `tests/core/m0.test.ts` durable state-lock serialization |
| Every specification fact cites returned evidence; unsupported claims become questions | draft/Markdown validation and deterministic renderer | `tests/spec/m1.test.ts`; `tests/dsh/native-tools.spec.ts` |
| Editing samples/instructions invalidates approval and held-out drafts; written batches cannot be recalibrated | spec state machine | `tests/spec/m1.test.ts` |
| With `approval: host`, only `allowed-once` proceeds. `rejected`/`cancelled` always deny; missing service/agent and `unavailable` deny unless the profile explicitly sets `approvalUnavailable: agent` | `requireHumanApproval` | `tests/dsh/plugin-contract.test.ts` |
| Host guards and `tools/pre-execute` denials prevent writes | DSH ToolRuntime pipeline | `tests/dsh/native-tools.spec.ts` |
| No model calls, credentials, telemetry, or network beyond DSH and loopback review pages | no model client; loopback bind; static checks | `tests/core/boundaries.test.ts` |

## What Ditto stores locally

Under `stateRoot` (default `.dsh-ditto` inside `workspaceRoot`), Ditto stores plans, recipes, exported review manifests, cross-process lock records, spec batches (including evidence and rendered Markdown), and the deterministic draft cache. It stores no credentials, environment variables, or conversation transcripts. Delete the folder to forget the durable state.

## Threat-model boundary

- **Semantic correctness:** a citation points to real source lines; it does not prove the interpretation. Review samples and confirmations.
- **Host permissions:** Ditto's roots and approval gates add checks; they do not replace the DSH sandbox or OS ACLs.
- **Hostile privileged local mutation:** Ditto repeatedly rejects links and verifies hashes, but Node does not expose portable handle-relative `openat` operations. An administrator able to replace checked directories between individual filesystem syscalls is outside the guarantee; isolate `workspaceRoot`, authorised external roots, and `stateRoot` with OS permissions.
- **Confidentiality at rest:** state is validated plain JSON/text, not encrypted.

## Reporting

Report any way to escape an output root, overwrite a file, bypass approval, execute source/SQL, or adopt an unreviewed deliverable through [SECURITY.md](../SECURITY.md).

## 0.4 diagnostic and cancellation gates

- `requireHumanApproval` checks cancellation before any mode/fallback and again after the host resolves. A delayed grant cannot revive a cancelled invocation (`tests/dsh/plugin-contract.test.ts`).
- Doctor uses the same configuration validator as the plugin before probing state. Invalid profile names and state outside the workspace fail (`tests/cli/demo-and-doctor.test.ts`).
- Native `ditto_doctor` launches no subprocesses and checks the active tool and skill registrations. It removes its temporary writability probe immediately (`tests/dsh/native-tools.spec.ts`).
- Python is read as text. Comments and strings do not create structural declarations; mixed Python/Java/TypeScript batches pass the existing evidence, approval, apply, and resume gates without executing sources (`tests/spec/python-language.test.ts`). Structural facts remain approximate hints, not evidence-backed semantic claims.
