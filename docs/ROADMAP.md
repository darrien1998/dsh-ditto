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

## Next — help wanted

These are scoped so a contributor can take one without touching the safety core. Look for the matching labels in the issue tracker.

| Area | Item | Label |
|---|---|---|
| Language adapters | C#, Go — one file each behind the `LanguageAdapter` seam | `language adapter`, `good first issue` |
| Spec templates | User-selectable section sets and headings (for example an "API reference" template or a "behaviour before refactor" template), validated the same way as today | `enhancement` |
| Sample selection | Better spread than "most exports / most imports / smallest" — for example by folder, by framework role, or by duplication | `enhancement`, `help wanted` |
| DSH Web | A native review panel in the DSH web UI instead of the loopback page | `ui`, `dsh compatibility` |
| Review page | Localisation (zh-TW first), keyboard flow, diff view for sample edits | `ui`, `good first issue` |
| Documentation | Real-world examples with different repository shapes; a screencast of the browser demo | `documentation`, `good first issue` |
| Community results | Evaluation write-ups following [EVALUATION.md](EVALUATION.md) | `documentation` |

## Later, maybe

- Batches larger than 50 modules as linked sub-batches
- Per-user default instructions and templates

## Not planned

Background folder watching, scheduled or unattended runs, shell or script recipes, executing generated code, automatic source modification, automatic git commits or pull requests, cloud backends, telemetry, model routing, API key management, an all-language parser, or a multi-agent orchestration layer. If Ditto needs any of these to be useful for you, it is probably the wrong tool, and that is fine.
