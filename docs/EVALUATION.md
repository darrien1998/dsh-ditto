# Evaluation

Ditto ships a deterministic native-tool transport benchmark; CI never calls a model. See [EFFICIENCY.md](EFFICIENCY.md) for the reproducible method and bounded claims. This page also records the model and human evaluation still needed.

## What we claim, and what we do not

We claim that Ditto makes batch work **reviewable, consistent, and safe to apply**: representative samples, a full preview, evidence on every claim, explicit approval, and safe writes. Those properties are deterministic and tested (see [SAFETY.md](SAFETY.md)).

We do not claim that Ditto makes a model smarter, that generated specifications are semantically correct, or any percentage improvement in model tokens, cost, speed or quality. Users bring their own model and their own repository; the useful numbers come from real use, not from a synthetic benchmark.

## What is worth measuring

Deterministic (can be checked by code):

| Measure | How |
|---|---|
| Module coverage | Every in-scope module appears exactly once in the batch; every exclusion has a reason and a count |
| Citation validity | Every factual line in every written spec cites an evidence id that resolves to a real path and line range |
| Overwrite and source integrity | Source hashes before and after apply are identical; no destination existed before it was written |
| Resume correctness | After an interrupted apply, completed items are not rewritten and the remaining items complete |

Human-judged (needs people, per repository):

| Dimension | Question | Suggested method |
|---|---|---|
| Factual accuracy | Does each cited claim actually follow from the cited lines? | Sample 20 claims per batch; two reviewers |
| Citation support | Does the evidence support the statement, not merely exist? | Same sample |
| Style consistency | Do held-out specs follow the approved samples' structure and terminology? | Checklist per section |
| Honesty of "Needs confirmation" | Was anything unsupported stated as fact? | Read every spec's confirmation section |
| Supervision effort | How many interactions did the batch take versus one conversation per module? | Count tool calls, user turns, and edits |

## A fair comparison, if you want one

Same 12–20 modules, same model, two runs:

1. One conversation per module, re-explaining the format each time, collecting the output by hand.
2. Ditto: calibrate three samples, approve, preview, apply.

Record wall-clock time, number of user interactions, modules missed, unsupported claims, formatting fixes, and tokens. Publish the method with the numbers.

## Sharing results

If you run such a comparison, open a Discussion with the repository size, batch size, use case, results, and what the humans thought. No telemetry is collected; nothing leaves your machine unless you post it.
