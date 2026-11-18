# Compatibility

Checked on 2026-11-18 against the published npm packages and installed DSH launcher. DSH is a developer preview and may change its public APIs. `src/compat.ts` is the version table used by the doctor.

## Current baseline

| Ditto | DSH | Node.js | Evidence |
|---|---|---|---|
| 0.4.0 | 0.2.2-rc.4 (`next` at verification time) | >=24.9.0 | Windows/Node 24.19: full test suite, component host, clean tarball, native diagnostic execution, and real isolated profile install/boot/registration/CLI doctor |
| 0.4.0 | 0.2.2-rc.1 (`latest` at verification time) | >=24.9.0 | Clean tarball, native executor/diagnostic call, CLI demo and doctor, and real isolated profile install/boot/active diagnostics |
| 0.4.0 | future `next` / `alpha` | 24, 26 | Non-blocking canaries, not an automatic compatibility promise |
| 0.1–0.3 | 0.1.x | 22, 24 | Historical releases; retain matching Ditto for old profiles |

CI targets Node 24 and 26 on Ubuntu and Windows. Local verification was on Windows with Node 24.19.0; this does not claim that every CI matrix entry was run locally.

## Runtime contract

- Peers: `@deepseek-ai/cordis ~4.1.0`, `@deepseek-ai/dsh-tools >=0.2.2-rc.1 <0.3.0`. Ditto uses the host instances instead of bundling another runtime.
- Required services: `tools`, `skills`. `approval` is read at call time and fails closed when unavailable, unless the profile owner explicitly enables the documented agent fallback.
- Public APIs only: `defineTool`, tool registry, skill registration, Cordis services, and approval requests. Ditto modifies no DSH code.
- DSH 0.2 separates the tool registry from its executor. Tests mount `dsh-tool-executor-native` and dispatch `{ calls, signal }` batches with raw JSON arguments. A live profile chooses its own executor; Ditto does not replace it.
- Node >=24.9.0 follows the current DSH launcher requirement. pnpm is required by `dsh plugin`, not the core.
- `re2-wasm` is the only direct runtime dependency. ZIP and SQL delivery use Node APIs without shell commands.

## Standalone versus active diagnostics

DSH 0.2 resolves host dependencies inside its runtime and no longer creates filesystem fallback links for subprocesses. `dsh plugin --profile web exec dsh-ditto doctor` may inspect installation and folders but report that its component mount is unavailable. This warning does not establish registration health. Booting again does not repair standalone resolution.

Use native `ditto_doctor` through the DSH agent to inspect the actual running plugin, all 18 tools, skill, folders, and approval service. The real-profile smoke installs a temporary verification plugin inside DSH and requires successful diagnostics and complete registrations. A process merely staying up cannot pass.

`doctor --json` returns `{ ok, checks }` and exits nonzero for failed checks. With locally resolvable peers it also mounts a real component host. It rejects invalid profiles, outside-workspace state, and linked state before testing writability.

## Updating and canaries

Use exact component versions: some npm component `latest` tags still point to `0.0.1-rc.1`. Development pins 0.2.2-rc.4. `scripts/use-dsh-version.mjs` resolves another tag and that release's Cordis peer. The tarball smoke pins the component closure to avoid mixed releases.

`npm run smoke:profile` always fails if DSH or pnpm is missing. It uses an isolated `DSH_HOME`, uses an OS-assigned port, prevents browser opening, and accepts an explicit launcher JS path in `DITTO_DSH_CLI`. It never installs into existing user profiles.

## Reporting a problem

Include the DSH version, native `ditto_doctor` output, standalone `doctor --json`, and plugin activation errors. See [VERIFICATION.md](VERIFICATION.md) for executed checks and remaining limitations.
