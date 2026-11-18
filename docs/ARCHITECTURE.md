# Architecture

Version 0.5 adds `SpecProductivity` orchestration over the existing specification core: bounded complete-module work, durable identity-bound receipts, atomic multi-draft validation, compact deltas, reviewed reuse, task guidance and local counters. Sidecars live in `spec-work`, `spec-templates`, and `spec-metrics` under the protected state root. Batch mutations use the existing cross-process lock. Guidance and environment snapshots participate in the batch digest; approval never transfers between batches. See [EFFICIENCY.md](EFFICIENCY.md) for protocol and cache boundaries.

Ditto is a native DeepSeek Harness (DSH) plugin. This document describes what runs where, what the plugin depends on, how state and approvals work, and what the boundaries are. For the safety guarantees and the tests behind them see [SAFETY.md](SAFETY.md); for the tool reference see [TOOLS.md](TOOLS.md).

## The shape of the product

```text
User
 ↓  natural-language batch request
DSH agent
 ↓  `ditto` skill routing (skills/ditto/SKILL.md)
Ditto native tools                       ← src/dsh/tools/*.ts, registered on ctx.tools
 ↓  bounded evidence out, structured drafts in
Deterministic core                       ← src/core (files), src/spec (code → spec)
 ↓  discovery · evidence ids · citation validation · rendering · hashes · digests · durable state
Preview → Human approval → Apply
```

The core value is not a smarter model. It is that a batch of 20–50 similar items is calibrated on three reviewed samples, previewed in full, approved explicitly, and applied safely — instead of supervising 20–50 conversations.

## Package layout

| Path | Role |
|---|---|
| `src/dsh/service.ts` | `DshDitto`, a Cordis `Service` (`provide: 'dshDitto'`, `inject: ['tools', 'skills']`). Registers the skill and the tools in its constructor. |
| `src/dsh/skill.ts` | Loads `skills/ditto/SKILL.md` at runtime and turns its frontmatter into a `SkillRegistration`. The file is the only definition of the skill. |
| `src/dsh/tools/files.ts` | Eight file tools: `ditto_preview`, `ditto_revise`, `ditto_revise_rule`, `ditto_manifest`, `ditto_artifact_review`, `ditto_apply`, `ditto_status`, `ditto_recipe` |
| `src/dsh/tools/spec.ts` | `ditto_spec_create`, `ditto_spec_queue`, `ditto_spec_module`, `ditto_spec_submit`, `ditto_spec_review`, `ditto_spec_revise_samples`, `ditto_spec_approve`, `ditto_spec_apply`, `ditto_spec_status` |
| `src/dsh/tools/shared.ts` | JSON result boundary, cancellation check, in-process queue plus state-backed mutation lock, and the human-approval gate |
| `src/dsh/catalog.ts` | Human-facing facts per tool (stage, writes, approval, failure cases). `scripts/gen-tools-doc.ts` merges it with the live schemas into `docs/TOOLS.md`; a test keeps it in step with the registered tools. |
| `src/dsh/config.ts` | Plugin configuration and its validation |
| `src/core/*` | File-organisation engine: Recipe v1/v2 and RE2 matching, plans/exceptions, sidecar rendering (`artifacts.ts`), streamed deterministic ZIP (`zip.ts`), safe state paths and cross-process locks (`state-paths.ts`), digests and safe apply |
| `src/spec/*` | Code → Spec engine: discovery, evidence chunks, draft validation, deterministic Markdown rendering, approval/recipe transitions, cached generation, safe write apply |
| `src/spec/languages/*` | The `LanguageAdapter` seam (TypeScript/JavaScript, Java, and Python shipped) |
| `src/server.ts`, `src/ui/*` | Optional loopback-only review pages (no CDN, no third-party assets), used by the demo and `dsh-ditto serve` |
| `src/cli.ts`, `src/demo.ts`, `src/doctor.ts` | `dsh-ditto` command: demos, doctor, local page |
| `cordis.patch.yml` | The bundle patch DSH applies when the package is installed into a profile |

## How DSH loads Ditto

1. `dsh plugin --profile <name> add dsh-ditto` runs pnpm inside `$DSH_HOME/profiles/<name>` and, because `package.json` declares `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`, appends `dsh-ditto` to the profile's `dsh.profile.bundles`.
2. At boot, DSH composes the plugin tree: each bundle's patch list in order, then the profile's own `cordis.patch.yml`. Ditto's patch inserts one entry:

   ```yaml
   - insert:
       - id: ditto
         name: 'dsh-ditto/dsh'
         config:
           stateRoot: .dsh-ditto
   ```

3. The loader imports `dsh-ditto/dsh` (the `./dsh` export) and mounts `DshDitto` once its injected services (`tools`, `skills`) are available. Both come from `@deepseek-ai/dsh-base`, which every shipped profile except `sdk-minimal` includes.
4. Everything Ditto registers is a Cordis effect of its own fiber. Unloading the bundle, or a live reload of the patch layer, disposes the fiber and removes the skill, all 18 tools, and the `dshDitto` service. The test `registers the bundled skill … and removes them on unload` covers this on the real registry.

Module resolution follows DSH's two-anchor rule: the profile's own dependencies first, then the installation's dependency closure through the host's runtime resolver. DSH 0.2 does not project this closure into standalone CLI resolution. `ditto_doctor` inspects the active instance; a standalone doctor only mounts a component host when its peers are locally resolvable. That is why `@deepseek-ai/cordis` and `@deepseek-ai/dsh-tools` are **peerDependencies** — a second copy of the core inside the profile would give the plugin different `Service`/`Context` classes from the host's.

## Configuration

Set from the profile's own `cordis.patch.yml` by overriding the `ditto` entry (a user patch replaces the whole `config` object, so restate the fields you keep):

| Field | Default | Meaning |
|---|---|---|
| `workspaceRoot` | the DSH process working directory | Anchor for every relative tool path, all Code → Spec source/output paths, and durable state. Relative paths never inherit external-root authority. |
| `stateRoot` | `.dsh-ditto` (relative to `workspaceRoot`) | Durable plans, locks, review manifests, batches, recipes, and generation cache. Must stay inside `workspaceRoot`; every category and leaf is link-checked. |
| `allowedSourceRoots` | `[workspaceRoot]` | Canonical roots from which **file organisation only** may read. Absolute source paths must be contained by one of these profile-owned roots. |
| `allowedDestinationRoots` | `[workspaceRoot]` | Canonical roots beneath which **file organisation only** may create outputs. Source and destination roles are checked separately. |
| `approval` | `host` | `host`: request a one-shot DSH host grant after validating the exact reviewed identity. `agent`: explicitly rely on the conversational approval rule in the skill. |
| `approvalUnavailable` | `deny` | A missing service/agent identity or host `unavailable` denies by default. `agent` is an explicit profile-owner fallback and is not proof of human approval. `rejected`/`cancelled` always deny. |
| `maxItems` | 200 | Maximum files one file-organisation preview may enumerate (1–1000) |
| `resultItems` | 25 | Maximum item records per tool response (1–100); larger sets are paged with `nextOffset` |
| `evidenceItems` | 20 | Maximum evidence chunks per `ditto_spec_module` response (1–40); paged with `nextEvidenceOffset` |

Ditto's workspace boundary is its own check on top of whatever file sandbox the host enforces; it does not replace the host's permission model.

## The Code → Spec pipeline

`discover → prepare → generate → validate → preview → apply`, with the model step deliberately outside the plugin:

- **Discover.** Walk the source folder without following symlinks; skip `.git`, `node_modules`, build output, tests, and the state folder; claim files by extension through the language adapters; record every exclusion and its reason. A batch covers 4–50 modules (three samples plus at least one more; larger repositories are split into several batches).
- **Prepare.** Read each module as text (never import or execute it), hash the bytes, cut it into 24-line evidence chunks with ids derived from path + line range + content hash, and extract deterministic structural facts (exports, imports, line count).
- **Samples.** Choose three structurally different modules: the richest exporter, the module with the most imports, and the smallest. This is a deterministic spread, not a confidence score.
- **Generate.** Ditto never calls a model. `ditto_spec_module` hands the agent the evidence and facts (plus the approved samples for remaining modules); the agent returns a JSON `SpecDraft`. The local demo and the tests use a labelled deterministic generator instead.
- **Validate.** A draft is accepted only if it matches the module, uses only known fields, and cites existing evidence ids on every factual entry. Unsupported or uncertain statements must be `confirmations` — questions ending with `?`. Invalid drafts never reach the preview.
- **Render.** A deterministic renderer owns the Markdown: title, `Source`, `Purpose`, `Responsibilities`, `Public API`, `Dependencies`, `Errors and edge cases`, `Needs confirmation`, `Evidence`. Generator output never supplies a path or a template.
- **Review and approve.** The user edits the three sample Markdown files (every factual line must keep a `[ev_…]` citation) and the batch instructions. Any material edit bumps the revision, clears the approval, and discards held-out drafts. `ditto_spec_approve` records the three samples as the versioned recipe for this revision.
- **Preview.** Remaining modules are drafted against the approved samples. The preview shows every module, its output path, its status, and everything under "Needs confirmation".
- **Apply.** Requires the exact batch id, revision, and digest; re-checks every source hash and destination in a write-free preflight; writes each Markdown file through a temporary file with `wx` semantics; records per-module results after each write for resume.

## The file-organisation pipeline

Recipe v2 adds a strictly anchored, linear-time `re2-wasm` match rule with named captures to the existing `{stem}`, `{ext}`, `{index}`, and `{class}` tokens. `{match.name}` may render one safe path segment, so a reviewed template can create nested paths such as `PRO_FILES/{match.code}/{match.code}{ext}` without permitting traversal. Non-matches, unsafe captures, invalid destinations, and collisions are explicit per-item exceptions.

`ditto_revise_rule` regenerates every proposal, exception, sidecar, and archive identity in one new revision; `ditto_revise` is reserved for genuine per-item overrides. `ditto_manifest` exports the complete reviewed mapping under state, while reviewed manifest/checksum/safe-SQL sidecars are hashed into the plan and paged through `ditto_artifact_review`. SQL is emitted text only and is never executed.

Apply runs in three stages: verified `COPYFILE_EXCL` copies, exact reviewed sidecars, then a streamed deterministic store-only ZIP built from the persisted allowlist rather than a directory walk. Classic ZIP limits are checked explicitly. Copy, sidecar, and archive writes record durable intent and may adopt only the exact expected hash after a crash. Recipes contain no scripts or commands and can be saved and reused.

## Identity, revisions, digests

- A plan or batch id is a UUID. Each reviewed change increments `revision`.
- The `digest` is a SHA-256 over the reviewed identity: roots, recipe, samples, evidence, drafts, and rendered Markdown — but **not** over apply outcomes, so an interrupted batch keeps its identity while it resumes.
- Every mutating tool takes the exact `revision` (and, for approval and apply, the `digest`) and rejects anything stale with a message that tells the agent to read the current status and re-review with the user.
- Persisted state is validated on load (shape, digest, approval invariants) before it is trusted.

## Human approval

Two layers, both always on:

1. **Deterministic gate.** Apply requires the exact reviewed identity, a complete preview (every module rendered and validated), and, for Code → Spec, an approval record that matches the current revision. Nothing about this depends on the model behaving.
2. **Host prompt (`approval: host`).** After validating the caller's exact revision/digest, `ditto_apply` and `ditto_spec_apply` call `ctx.approval.request()` with the tool-call id and an authenticated summary. `allowed-once` proceeds; `rejected` and `cancelled` always deny. A missing approval service, missing agent identity, or `unavailable` (including policy `never`) denies by default. Only a profile owner may opt into `approvalUnavailable: agent`; that relies on the skill's conversational approval and is not proof of human approval.

The skill additionally instructs the agent never to call an apply tool on its own initiative and to show the samples and the full preview before asking.

## Durable state

Under `stateRoot`:

| Folder | Contents |
|---|---|
| `plans/<id>.json` | File-organisation plans with reviewed identities, per-item/sidecar outcomes, and copy/archive crash journals |
| `recipes/<id>.json` | Saved versioned naming recipes |
| `reviews/<plan-id>.r<revision>.*` | Complete CSV/JSON/Markdown review manifests exported by `ditto_manifest` |
| `locks/<hash>.lock/` | Atomic cross-process mutation leases with local dead-process recovery |
| `spec-batches/<id>.json` | Code → Spec batches: discovery, evidence, drafts, rendered Markdown, approval record, per-module status |
| `spec-cache/<hash>.json` | Generator responses keyed by source hash + recipe digest + generator id |

Every state root, category, temporary file, and leaf is checked against symlink/junction redirection. Writes are atomic (new temporary file + rename), and per-plan mutations are serialised in-process and through a state-root filesystem lock. State never contains credentials; agent-supplied `metadata` on a draft is limited to short strings.

## Language adapters

`src/spec/languages/types.ts` defines the seam:

```ts
interface LanguageAdapter {
  id: string                      // persisted with each module
  displayName: string
  extensions: ReadonlySet<string> // lower-case, with the dot
  exclude?(fileName): 'declaration-file' | 'generated' | undefined
  structuralFacts(text): { exports: string[]; imports: string[]; lineCount: number }
}
```

Evidence chunking, citation validation, rendering, hashing, and every safety gate are language-independent. A new language is one file plus tests; see [CONTRIBUTING.md](../CONTRIBUTING.md#adding-a-language-adapter).

## What Ditto deliberately does not do

No background folder watching, no scheduled runs, no shell or script recipes, no execution of generated code, no automatic source modification, no git commits or pull requests, no unattended batch writes, no cloud backend, no telemetry, no model routing, no API key management. Keeping the plugin small is the point; see [ROADMAP.md](ROADMAP.md).
