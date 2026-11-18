# Launch kit

> Historical launch copy for earlier releases. Current 0.4 installation, supported versions, Java/Python coverage, and diagnostics are documented in README.md and COMPATIBILITY.md. Do not reuse the historical version claims below for a new release.

> **Historical note:** the long-form posts below are the preserved 0.1 first-release kit. Their `v0.1.0` and 14-tool claims are historical and must not be reused as current 0.2 facts.

## 0.2 release note

**Ditto 0.2.0 — practical, review-first file delivery**

Ditto now turns real external file batches into reviewed deliverables without widening the agent's general workspace boundary. A profile owner authorises source and destination roots; Recipe v2 captures codes with linear-time RE2, builds safe nested paths, and shows unmatched or colliding inputs as explicit exceptions. One rule revision updates the whole batch.

The complete mapping can be exported as CSV/JSON/Markdown. Reviewed sidecars include manifests, SHA-256 lists, and escaped literal-only SQL INSERT text for SQL Server, PostgreSQL, or SQLite—Ditto never connects to a database or executes SQL. An optional deterministic streamed ZIP contains exactly the reviewed outputs, with durable exact-hash crash recovery.

The plugin now exposes 17 native tools (nine Code → Spec, eight file organisation). Approval still fails closed: rejection/cancellation always deny, and an unavailable host prompt falls back only when the profile owner explicitly enables conversational agent approval.

Before posting: run `npm run release:check`, `npm run smoke:profile`, and inspect `npm pack --dry-run`; publish only after all evidence is green.

## Preserved 0.1 first-release material

Ready-to-post announcements for the first public release. Adjust length to the venue, not the claims.

Core message (do not change):

> AI is great at doing one file. Ditto is for doing the same thing to dozens of files without supervising every one.
> Review a few. Preview everything. Apply safely.

Do not say: revolutionary, world first, 10x, smarter AI, perfect automation, zero hallucination, guaranteed consistency.

## Pre-launch checklist

- [ ] `npm run release:check` and `npm run smoke:profile` green; CI green on `main`
- [ ] `npm publish` done; `npm view dsh-ditto version` shows the release
- [ ] GitHub release `v0.1.0` with the changelog section
- [ ] Repository topics set: `dsh-plugin`, `deepseek-harness`, `dsh`, `ai-agent`, `ai-agents`, `developer-tools`, `batch-processing`, `human-in-the-loop`, `code-documentation`, `typescript`
- [ ] GitHub About: "Review-first batch automation for DeepSeek Harness — review a few examples, preview the whole batch, then apply safely."
- [ ] Discussions enabled; labels created (`good first issue`, `help wanted`, `bug`, `enhancement`, `dsh compatibility`, `language adapter`, `ui`, `documentation`)
- [ ] Submit to community catalogs that index the `dsh-plugin` topic and npm keyword (for example dsh-plugin.org's submit page and dsh-plugin-shop); they need only the repository URL and the npm name

## GitHub release notes / launch post

**Ditto 0.1.0 — Review a few. Ditto the rest.**

Ditto is a review-first batch automation plugin for DeepSeek Harness.

AI is great at doing one file. Ditto is for doing the same thing to dozens of files without supervising every one. Ask for "specs for every module in `src/`" and Ditto discovers the modules, picks three representative samples, lets you edit them until they look right, applies the same standard to the rest, shows you the full preview with every claim cited to source lines and every open question collected under "Needs confirmation", and writes only after you approve.

- Install: `dsh plugin --profile web add dsh-ditto`
- Verify: `dsh plugin --profile web exec dsh-ditto doctor`
- Try without a model or API key: `npx dsh-ditto demo --headless`

Safety by design: your source stays untouched, nothing is batch-written before approval, Ditto does not execute your source code, and it does not store your model API keys. Each guarantee is tested — the map is in docs/SAFETY.md.

First use case: Code → Spec for TypeScript/JavaScript. Second: organising copies of files under one reviewed rule. Adapters for Python, Java, C#, and Go are open for contribution — the seam is one small interface.

Tested against DSH 0.1.5-rc.1 and rc.2. MIT licensed.

## DSH Discord post

**Ditto — review a few, ditto the rest** (new DSH plugin)

If you have ever asked an agent to "do the same thing to every module" and then babysat 30 files, this is for that. Ditto picks 3 representative samples, you edit them, it applies the same standard to the rest, shows the whole batch with citations and open questions, and writes only after you approve. Native plugin, 14 tools, no model calls of its own, no API keys stored.

`dsh plugin --profile web add dsh-ditto` · demo without a model: `npx dsh-ditto demo --headless` · repo: https://github.com/darrien1998/dsh-ditto

Looking for contributors for Python/Java/C#/Go adapters — it is one small interface.

## DSH Discussion post

**Title:** Ditto: review-first batch automation (Code → Spec, file organisation)

**Body:**

I built a DSH plugin for the "same thing across many files" problem. The idea is not to make the model smarter; it is to stop supervising 30 conversations.

Workflow: discover → 3 representative samples → you review and edit → explicit approval → full preview (every claim cites source lines; unsupported claims become "Needs confirmation") → apply into a separate output folder → durable, resumable results.

What it is: a native Cordis plugin with a skill (`skills/ditto/SKILL.md`), 14 typed tools, a deterministic core, and a small local review page. What it is not: a watcher, a scheduler, a script runner, or an autonomous writer.

Install: `dsh plugin --profile web add dsh-ditto`. Demo (no model): `npx dsh-ditto demo --headless`.

I would like feedback on two things: (1) the sample-selection heuristic, and (2) which language adapter matters most to you. Tested against DSH 0.1.5-rc.1/rc.2; the compatibility table and the safety-test map are in the docs.

## Reddit / developer community post

**Title:** I made a DSH plugin so an AI agent can document 30 modules after I review 3

I kept asking agents to write specs for a whole codebase and getting drift, missed files, invented details, and early writes. Ditto is my answer: pick three representative modules, let me edit their specs, apply the same style to the rest, show me everything with citations to real source lines and a list of "things the source cannot answer", and only then write — into a separate folder, never over my code.

It is a plugin for DeepSeek Harness (`dsh plugin --profile web add dsh-ditto`), MIT, TypeScript. There is a demo that needs no model or key (`npx dsh-ditto demo --headless`). Python/Java/C#/Go adapters are open for contribution.

Repo: https://github.com/darrien1998/dsh-ditto

## 中文社群貼文

**Ditto｜先改幾份，其餘照樣做（DSH 插件）**

AI 做一份很快。Ditto 解決的是做 50 份時，你不必盯 50 次。

叫 agent「把 `src/` 每個模組都寫成規格」，Ditto 會先掃描、挑出 3 份有代表性的樣本讓你改到滿意，再用同一套標準處理其餘模組；整批預覽裡每一句都引用來源行號、來源答不出的問題集中在「Needs confirmation」，你核准後才寫入獨立的輸出資料夾。不碰原始碼、不覆寫、不存 API key、插件本身不呼叫模型。

安裝：`dsh plugin --profile web add dsh-ditto`
檢查：`dsh plugin --profile web exec dsh-ditto doctor`
不需要模型的示範：`npx dsh-ditto demo --headless`

已對 DSH 0.1.5-rc.1／rc.2 測試。MIT 授權。Python、Java、C#、Go 的 language adapter 開放貢獻，介面很小。

Repo：https://github.com/darrien1998/dsh-ditto
