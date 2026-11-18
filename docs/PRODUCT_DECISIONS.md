# Product priorities — 2026-11-18

Ditto's value is consistent, reviewable batch work with less agent bookkeeping. The next release should improve calibration and review effort for existing users before expanding platforms or formats.

| Issue | Decision | Reason |
|---|---|---|
| #6 sample spread | High priority; shipped in 0.6 | Three redundant examples weaken calibration. Folder/language/structural diversity is deterministic, inexpensive and testable without a model. |
| #8 keyboard review | High priority; shipped in 0.6 | Repeated sample review benefits from keyboard access. Shared local controls improve both workflows without a new host integration or write path. |
| #3 C# adapter | Close as not planned | Existing TS/JS, Python and Java cover the current scope. Another text adapter needs ongoing correctness fixtures without demonstrated demand. Community extensions remain possible. |
| #4 Go adapter | Close as not planned | Same scope and maintenance tradeoff as C#. No existing support is removed. |
| #5 arbitrary sections/headings | Close as not planned | Task guidance and approved examples already address repeated style instructions. A configurable renderer/validator contract adds substantial complexity with limited present evidence of need. |
| #7 native DSH panel | Close as not planned | The local review page works through public core APIs. A second host-specific UI adds compatibility maintenance; improve the existing review experience first. |
| #9 real-world examples | Keep open, next evidence priority | Actual model output and human corrections are necessary to assess usefulness and semantic quality. Synthetic transport fixtures cannot establish either. Do not fabricate model runs or accuracy claims. |

Closed as not planned means a scope decision, not completed implementation. Revisit with a concrete user workflow, evidence of demand and a bounded maintenance plan.

The 0.6 selector takes a rich starting module and then prefers unseen folders, languages and the greatest minimum distance in export/import counts and line-count buckets. It strips the common folder prefix before comparing roles, so discovering from the repository root still distinguishes `src/routes` and `src/services`. This is a heuristic for review coverage, not semantic clustering or a confidence score. Old persisted batches retain their original sample ids and approval identity.

Keyboard shortcuts navigate sample cards and focus approval. They do not approve or write by themselves: native Enter/Space activation and the existing server gates remain authoritative. Typing, composition and repeated keys are ignored. No extra model calls, network assets or runtime libraries were added.
