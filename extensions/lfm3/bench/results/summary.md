# LFM3 bench results

2026-10-27/28, 12-thread x86-64 CPU, no GPU, llama.cpp `d05706b4f3`, through headless
`pi -p --mode json` on this checkout. Raw rows: `classify.jsonl`, `watcher.jsonl`. The gate and the
per-case criteria are in [../GATE.md](../GATE.md).

## d1-2B classification — pass

40 labelled cases, classifier `lfm3/d1-2b` through pi's classifier registry. "stuck" is three
yes/no questions in one request (repeating, waiting for an answer, waiting for permission); the
other kinds are one question.

| kind | model | rule baseline | median |
|---|---:|---:|---:|
| stuck | 10/10 | 10/10 | 909 ms |
| permission | 8/8 | 8/8 | 267 ms |
| blocking | 7/7 | 7/7 | 270 ms |
| issue kind | 8/8 | 8/8 | 470 ms |
| repository | 3/3 | 3/3 | 475 ms |
| duplicate | 4/4 | 3/4 | 380 ms |
| **all** | **40/40** | **39/40** | **454 ms** |

p90 924 ms. d1-2B-Q8_0: 1.85 GiB file, 1.95 GB RSS at 32K context. The rule baseline was written
against the same 40 cases, so its 39/40 is an upper bound, not a general baseline.

A single generic "is it stuck?" question scored 37/40 in the prototype; the three-question set is
what the bench and the product use and is why stuck is 10/10.

## LFM3-1.7B Watcher — fail

16 realistic screens, the board's own Watcher prompt, thinking off.

| measure | result |
|---|---:|
| valid JSON | 15/16 |
| `n` = 1 | 1/16 |
| status line matches | 13/16 (rule baseline 13/16) |
| progress in range | 1/16 (rule baseline 14/16) |
| median / p90 wall | 2.04 s / 2.27 s |

The model read `n` as the minutes and progress as the elapsed time. The board's `read_answer`
drops such a row, so the Watcher would often not update. Not integrated.

## LFM3-1.7B titles and summaries — fail

Informal 8-case title check: 3/8 clean, one paragraph about the LFM family, two `</think>` leaks,
several over the 8-word limit. Informal 4-case summary check: 2/4 clean; one prefixed
"One-line summary:" and ran long, one described the model itself. Not integrated.

## Footprint

| model | file | RSS | notes |
|---|---:|---:|---|
| LFM3-1.7B-QAD-Q4_0 | 1001 MiB | 2.27 GB | 16K context, 8 threads |
| d1-2B-Q8_0 | 1.85 GiB | 1.95 GB | 32K context, batch 8192 |

Both servers together need about 4.2 GB, plus the agents. An LFM3-1.7B decode with thinking on ran
at about 8 tokens/s; one medium-thinking Watcher case produced 1,710 tokens in 194 s. Thinking is
off by default in the registered model.
