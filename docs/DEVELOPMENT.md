# Development

## Setup

```bash
git clone https://github.com/darrien1998/dsh-ditto.git
cd dsh-ditto
npm ci
npm run build
```

Node.js 22 or later. The dev dependencies pin the DSH 0.1.5-rc.1 component packages (`@deepseek-ai/dsh-tools`, `dsh-skill`, `dsh-system-prompt`, `dsh-user-approval`) and `@deepseek-ai/cordis` 4.0.2 for regression coverage; the tests mount the plugin on those real packages, not on mocks. CI also boots the current 0.1.5-rc.3 launcher in a real profile. A DSH launcher is only needed for the profile smoke.

## Commands

| Command | What it does |
|---|---|
| `npm run build` | `tsc` to `dist/` |
| `npm test` | Vitest: core safety (`tests/core`), Code → Spec engine (`tests/spec`), review pages (`tests/ui`), plugin contract and native tools on the real component host (`tests/dsh`), CLI demo and doctor (`tests/cli`) |
| `npm run smoke:dsh` | The `tests/dsh` suite in an isolated `DSH_HOME`, with an assertion on the resolved DSH versions (`DITTO_DSH_VERSION` overrides the expected version) |
| `npm run smoke:tarball` | `npm pack`, install the tarball into an empty project next to the DSH peers, mount from the installed copy, run the installed CLI and doctor |
| `npm run smoke:profile` | Real launcher: initialise a `ditto-smoke` profile from the shipped `web` template in a temporary `DSH_HOME`, `dsh plugin add <tarball>`, `--dump-config`, a real boot, and the doctor inside the profile. Needs `dsh` and `pnpm` on PATH; never touches your own `~/.dsh`. On Windows it invokes the DSH Desktop CLI directly, because the generated `dsh.cmd` wrapper pins `DSH_HOME` to your real profile |
| `npm run docs:tools` / `-- --check` | Regenerate `docs/TOOLS.md` from the live schemas + `src/dsh/catalog.ts`, or fail if it is stale |
| `npm run demo:headless` | The terminal demo (16 synthetic modules) |
| `npm run demo` / `npm run demo:files` | The browser review pages on synthetic data |
| `npm run doctor` | The doctor from the checkout |
| `npm run release:check` | build + test + component smoke + docs check + tarball smoke |

## Testing against another DSH version

```bash
node scripts/use-dsh-version.mjs next        # or alpha, or an exact version
npm install --no-package-lock
DITTO_DSH_VERSION=0.1.5-rc.2 npm test
DITTO_DSH_VERSION=0.1.5-rc.2 npm run smoke:dsh
git checkout package.json && npm ci          # back to the pinned set
```

## Windows 8.3 short names

CI's Windows runners expose `TEMP` through an 8.3 short component (`RUNNER~1`), while a
developer machine with a short user name usually does not. `realpath` expands such a
component, so any code that compares a caller-supplied path against its realpath behaves
differently on the two machines. To reproduce CI locally, point `TEMP`/`TMP` at the short
form of a directory and run the suite:

```powershell
$long = Join-Path $env:TEMP 'ditto-shortname-simulation'; New-Item -ItemType Directory $long -Force | Out-Null
$env:TEMP = $env:TMP = (New-Object -ComObject Scripting.FileSystemObject).GetFolder($long).ShortPath
npm test
```

`tests/dsh/v02-roots-rules.spec.ts` also covers this directly: it resolves a state root
through its short name and skips when the volume does not generate 8.3 names.

## Conventions

- TypeScript, ESM, `strict`. Runtime dependencies are limited to the DSH peers and `re2-wasm`; ZIP and SQL sidecars must remain deterministic and must never shell out.
- Every safety guarantee gets a test, and [docs/SAFETY.md](SAFETY.md) lists it. If you add a gate, add both.
- Error messages are English, one sentence, and tell the agent what to do next (for example "call ditto_spec_status and retry with its current revision and digest").
- The skill lives in `skills/ditto/SKILL.md` only. Do not duplicate its text in TypeScript.
- Tool facts live in `src/dsh/catalog.ts`; `docs/TOOLS.md` is generated. CI fails if it drifts.
- The demo generator is deterministic and labelled as such. Never present it as model quality.
- No benchmarks that call models in CI. See [EVALUATION.md](EVALUATION.md).

## Releasing

1. Update `CHANGELOG.md` and the version in `package.json`/lockfile; keep `src/compat.ts` and `docs/COMPATIBILITY.md` in step.
2. Run `git diff --check`, `npm run release:check`, `npm pack --dry-run`, inspect the packed file list, and run `npm run smoke:profile` on a machine with `dsh` and pnpm installed.
3. Tag `vX.Y.Z`, push, and let CI go green.
4. Run `npm publish --access public` (the `prepublishOnly` script rebuilds, tests, and checks generated tool docs).
5. Create the GitHub release from the matching changelog section.

## Debugging inside a profile

- `dsh --profile <name> --dump-config` shows the composed plugin tree, including the `ditto` entry and its config.
- A boot failure is one labelled line: `dsh: plugin tree failed to load: … (dsh-ditto/dsh): <cause>`.
- `dsh plugin --profile <name> exec dsh-ditto doctor` runs the doctor with the profile's own packages.
- State is plain JSON under `stateRoot`; deleting it resets Ditto.
