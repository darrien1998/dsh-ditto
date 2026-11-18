# Roadmap

Ditto stays small, understandable, safe, DSH-native, and review-first. The roadmap is a list of things worth doing in that spirit, not a schedule.

## 0.1 — first public release

- Native DSH plugin with the `ditto` skill and 14 typed tools
- Code → Spec for TypeScript/JavaScript with evidence-cited Markdown, three-sample calibration, full preview, host-approval gate, safe apply, resume
- File organisation with reviewed copies and saved recipes
- One-line install (`dsh plugin --profile web add dsh-ditto`), `dsh-ditto doctor`, deterministic demo
- Tested against DSH 0.1.5-rc.1 / rc.2, canary against 0.1.6-alpha

## 0.2 — production file organisation

- 17 typed native tools: nine Code → Spec and eight file organisation
- Profile-owned external source/destination allowlists without widening relative paths, state, or Code → Spec
- Recipe v2: strict RE2 named captures, nested safe paths, item-level exceptions, and whole-rule revision
- Complete paged/exported manifests plus reviewed manifest, checksums, and literal-only SQL text sidecars
- Deterministic streamed ZIP delivery from the reviewed allowlist, with explicit classic-ZIP limits and exact-hash crash recovery
- Fail-closed host-approval `unavailable` handling with explicit profile-owner agent fallback
- Link-hardened state, cross-process mutation locks, v1 compatibility fixtures, and 174-file acceptance coverage

## 0.4 — current DSH and diagnostics

- DSH 0.2.2-rc.4 / Cordis 4.1 baseline, Node.js 24.9+, and the separate native executor
- 18 native tools including active-instance `ditto_doctor`; standalone `doctor --json`
- Java and Python adapters, mixed-language evidence/review/apply/resume, Python environment exclusions
- Cancellation checked before approval and after a delayed grant; invalid doctor folders and CLI options rejected
- Real-profile smoke requires successful active registration checks, not only a running process

## 0.5 — less repetitive agent work

- 23 native tools: bounded multi-module work, atomic draft submission and compact deltas
- Exact-context handles with explicit restoration after session reset or handoff
- Fingerprinted draft reuse as newly reviewed candidates, without transferring approvals
- Three built-in task guidance templates and saved approved examples
- Durable local efficiency counters and a deterministic transport benchmark in CI

## 0.6 — review quality and keyboard access

- Deterministic sample spread across folders/languages/structural shapes, with a regression fixture where the old heuristic chose only routes
- Keyboard sample navigation and approval focus in both review pages, localised hints, and input/composition/busy-state protections
- Product scope narrowed to the existing review workflow; see [PRODUCT_DECISIONS.md](PRODUCT_DECISIONS.md)

## Next — evidence from real work

Real-world Code → Spec examples and human review-quality measurements remain tracked in #9. Publish the model, corrections and method; synthetic transport results do not substitute for these.

## Deferred scope

C#/Go adapters, arbitrary renderer section sets/headings and a DSH-specific review panel are not planned for the current product. Existing adapters and templates remain supported. Batches above 50 modules and per-user defaults need evidence of demand before being scheduled.

## Not planned

Background folder watching, scheduled or unattended runs, shell or script recipes, executing generated code, automatic source modification, automatic git commits or pull requests, cloud backends, telemetry, model routing, API key management, an all-language parser, or a multi-agent orchestration layer. If Ditto needs any of these to be useful for you, it is probably the wrong tool, and that is fine.
