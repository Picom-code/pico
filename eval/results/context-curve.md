# Context-length curve — deepseek-v4.1-flash — hermes harness — 20261025-145930

- tasks (8): code-add-feature, code-cli-flag, code-js-slugify, code-multifile, code-offbyone, code-refactor, code-traceback, code-ts-docstring
- padding: neutral filler, mode `premessage` (prepended to the first user message, so it is in every model call's prompt)
- repeat: 2, effort: low, timeout x1.5

| extra tokens | n | pass rate | median 1st-call prompt | median prompt tok/task | median wall s | mean wall s | median model latency s | median tools |
|---|---|---|---|---|---|---|---|---|
| 0 | 16 | 16/16 = 100% | 9220 | 51108 | 86.8 | 89.8 | 85.9 | 6 |
| 2000 | 16 | 16/16 = 100% | 10980 | 74876 | 102.2 | 104.8 | 101.1 | 7 |
| 4000 | 16 | 16/16 = 100% | 12748 | 77221 | 94.3 | 115.4 | 93.7 | 6 |
| 8000 | 16 | 16/16 = 100% | 16188 | 95546 | 118.7 | 142.6 | 118.0 | 6 |
| 16000 | 16 | 15/16 = 94% | 23120 | 142796 | 95.9 | 117.7 | 95.2 | 6 |
| 32000 | 16 | 16/16 = 100% | 36932 | 228042 | 98.5 | 115.7 | 97.8 | 6 |

Failures: code-offbyone@16000 r1

Raw: `eval/results/context-curve-20261025-145930.jsonl`

Per-call model latency (median s per API call): 0K 17.0 · 2K 13.9 · 4K 16.9 · 8K 21.6 · 16K 18.4 · 32K 19.2.

## Conclusion
- **No pass-rate cliff up to +32K tokens.** 95/96 runs passed. The only failure (code-offbyone, +16K, rep 1)
  was a 0-tool-call turn where the model said "I'll start by reading the file." and stopped. That is the
  classic "announce and stop" mode, and it might be a padding effect. One instance in 16 can't be told apart
  from noise; the same task passed at +32K in both reps.
- **Cost grows linearly.** The padding is re-sent on every call: tokens per task go from 51K (0) to 96K (+8K)
  to 228K (+32K), which is 4.5× at +32K. Prefix caching on a DGX Spark absorbs most of the compute, so wall time
  rises only ~10–30% (median 87s → 95–119s). Run-to-run endpoint load noise (±20%) is the same size as that rise.
- **Recommendation for Pico's default prompt budget:** quality alone doesn't force a cut on
  deepseek-v4.1-flash for these task sizes, so set the budget on cost and latency. Keep the
  standing prompt (system + tools + memory + skills index) **≤ ~4K tokens over today's 9.2K baseline (≈ 13K
  total first-call prompt)**. Above +8K, tokens per task nearly double and median wall time rose the most
  (+37% at +8K). The current Hermes harness already spends ~9.2K tokens before the user's first word, so a
  lean harness has headroom to *cut*, not add.
- Caveats: 8 small coding tasks × 2 reps (16 runs per point). The filler is clearly marked as possibly
  irrelevant, so this tests tolerance to distraction, not retrieval. Hard needle-in-haystack is
  covered by the long-context tasks in the main suite (6/6 passed with ~100K prompt tokens per task).
