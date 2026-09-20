# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- English and Traditional Chinese (`zh-TW`) localisation for both local review pages, selected by `--lang` before the browser language with a safe English fallback.

## [0.2.0] - 2026-09-20

### Added

- Profile-owned `allowedSourceRoots` and `allowedDestinationRoots` for file organisation outside the workspace; relative paths, durable state, and Code → Spec remain workspace-bound.
- Recipe v2 with linear-time `re2-wasm` matching, anchored named captures, `{match.name}` tokens, safe nested destination templates, and reviewable item-level exceptions.
- `ditto_revise_rule` for one deterministic whole-batch rule revision, plus `ditto_manifest` and `ditto_artifact_review` for complete and byte-exact review.
- Reviewed deterministic sidecars: CSV/JSON/Markdown manifests, SHA-256 lists, and identifier-validated, literal-only SQL INSERT text for SQL Server, PostgreSQL, and SQLite. Ditto never connects to a database or executes SQL.
- Optional deterministic streamed store-only ZIP delivery, built only from the persisted reviewed allowlist, with explicit classic-ZIP limits and exact-hash crash journaling.
- Durable cross-process state locks, state-root/category/leaf link checks, full 174-file acceptance coverage, and golden 0.1 persisted-plan/recipe compatibility fixtures.

### Changed

- The native surface is now 17 tools: nine Code → Spec and eight file-organisation tools.
- Reviewed exceptions no longer block valid copies and are included in the complete manifest with their reason.
- Recipe v2 `{ext}` includes its leading dot; frozen v1 recipes retain their original dotless semantics.
- Persisted source/destination roots are revalidated against the current role allowlists on status, revision, review, and apply.
- Apply order is copies → sidecars → archive; returned `deliverables` identifies the output root, sidecars, and archive.

### Security

- Regex matching moved to a strict RE2 grammar; lookarounds, backreferences, alternation, nested quantifiers, unsafe captures, traversal, reserved names, and output-tree collisions fail closed or become reviewed exceptions.
- Host approval now validates the exact submitted identity before prompting. `unavailable`, a missing approval service, or a missing agent identity denies by default; `approvalUnavailable: agent` is an explicit profile-owner opt-in. Rejection and cancellation always deny.
- Copy, sidecar, and archive crash recovery can adopt only an exact hash backed by an earlier durable intent; unrelated same-content destinations are not adopted.
- SQL templates accept validated identifiers and escaped literals only; CSV manifests neutralise spreadsheet-formula prefixes.

## [0.1.0] - 2026-09-17

First public release.

### Added

- Native DeepSeek Harness plugin (`dsh-ditto/dsh`): one Cordis service that registers the `ditto` skill and 14 typed native tools on the host's public `skills` and `tools` services, with clean unload.
- `skills/ditto/SKILL.md` as the single source of truth for the skill (DSH frontmatter, loaded at runtime).
- Code → Spec workflow for TypeScript/JavaScript: bounded discovery with exclusion accounting, line-numbered evidence chunks, three structurally different calibration samples, citation-validated JSON drafts, deterministic Markdown rendering, "Needs confirmation" for unsupported claims, revision/digest gates, durable resumable apply.
- File-organisation workflow: declarative naming recipes, per-file review, copies into a new folder, saved recipes.
- Host approval gate: with a DSH approval service present, `ditto_apply` and `ditto_spec_apply` ask the user before writing (`approval: host`, the default).
- `LanguageAdapter` seam with the shipped TypeScript/JavaScript adapter.
- `dsh-ditto` CLI: `demo` (browser and `--headless`), `demo-files`, `doctor`, `serve`, `--version`, `--help`.
- `dsh-ditto doctor`: Node, DSH, pnpm, profile installation, resolved DSH versions, in-process mount (tools and skill), workspace and state folder checks.
- One-line installation through `dsh plugin --profile <name> add dsh-ditto` (package declares `dsh.bundle.patch`; DSH packages are peer dependencies).
- Generated tool reference (`docs/TOOLS.md`) with a CI drift check; architecture, safety, compatibility, development, evaluation, roadmap, and launch documentation; English and Traditional Chinese READMEs.
- Smoke scripts: component host (`smoke:dsh`), packed-tarball clean install (`smoke:tarball`), and a real `dsh plugin add` + profile boot in an isolated `DSH_HOME` (`smoke:profile`).
- GitHub issue and pull request templates, labels, and a CI matrix (Node 22/24 × Ubuntu/Windows, real profile install, non-blocking DSH `next`/`alpha` canaries).

### Changed

- Product surface is English-first (tool results, error messages, rendered spec headings, review pages); the Traditional Chinese README is kept in step.
- Minimum batch size for Code → Spec lowered from 10 to 4 modules (three samples plus at least one to apply the standard to).
- Relative `stateRoot` values are anchored to `workspaceRoot` instead of the process working directory.

### Fixed

- A cross-drive path on Windows could be treated as inside the workspace by the native-tool boundary check; the core `within()` check is now used everywhere.

[Unreleased]: https://github.com/darrien1998/dsh-ditto/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/darrien1998/dsh-ditto/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/darrien1998/dsh-ditto/releases/tag/v0.1.0
