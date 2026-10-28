# LFM3 POC gate

The criteria were set before the runs on 2026-10-27; this page was written up afterwards. The
hardware is a 12-thread x86-64 CPU, no GPU; llama.cpp `d05706b4f3` (2026-10-27); LFM3-1.7B-QAD-Q4_0 and d1-2B-Q8_0, Q8 for the
decision model because its full output is probabilities, not text.

## Pass criteria

### d1-2B classification — the most promising use case

| criterion | pass | why |
|---|---|---|
| accuracy on the 40 labelled cases | ≥ 36/40 (90 %) | below that a rule or the agent's own reading is as good |
| median latency per request | ≤ 500 ms | the Watcher runs about once a minute; a tool call inside a turn must be cheap |
| p90 latency | ≤ 1500 ms | includes the 3-question "stuck" request |
| server RSS | ≤ 3 GB | leaves room for a big model and the rest of the board on this machine |

### LFM3-1.7B as the board's Watcher

| criterion | pass | why |
|---|---|---|
| valid JSON | ≥ 95 % | the board parses the reply and drops a bad row |
| `n` equal to the agent number | 100 % | the board's `read_answer` rejects a row with the wrong `n` |
| status line matches the screen | ≥ 80 % | the line is the product |
| progress inside the labelled range | ≥ 70 % | the minutes-left guess is drawn from it |
| p90 wall time for one look | ≤ 5 s | the board starts a whole `pi -p` per look |
| peak RSS | ≤ 3 GB | it shares the machine with the agents |

### LFM3-1.7B titles and summaries

| criterion | pass | why |
|---|---|---|
| acceptable titles (≤ 8 words, concrete, no reasoning leakage) | ≥ 80 % | a title that needs editing is worse than no title |
| median latency | ≤ 3 s | it would run on every new task |

No cloud model was called: this task forbids real provider authorisation, so the comparison is
against the labelled labels and, for classification, a hand-written rule baseline on the same
cases (reported, with the caveat that it was written against them).

## Results

### d1-2B classification — PASS

`node extensions/lfm3/bench/classify.ts`, 40 cases, through headless `pi -p --mode json` and pi's
real classifier registry:

| kind | model | rule baseline | median |
|---|---:|---:|---:|
| stuck (3 questions in one request) | 10/10 | 10/10 | 909 ms |
| waiting for permission | 8/8 | 8/8 | 267 ms |
| blocking review finding | 7/7 | 7/7 | 270 ms |
| issue kind | 8/8 | 8/8 | 470 ms |
| repository | 3/3 | 3/3 | 475 ms |
| duplicate | 4/4 | 3/4 | 380 ms |
| **all** | **40/40** | **39/40** | **454 ms (p90 924 ms)** |

One generic "is it stuck?" question scored 37/40 in the prototype; the three-question set is what
the bench and the README use, and it is why the stuck cases are 10/10. The d1 server used 1.95 GB
RSS at 32K context with the 1.85 GiB Q8 file.

Verdict: **pass**. Integrated as the classifier `lfm3/d1-2b` and the `lfm3_decide` tool.

### LFM3-1.7B Watcher — FAIL

`node extensions/lfm3/bench/watcher.ts`, 16 realistic screens, thinking off, exactly the board's
one-shot (`-p --no-session --no-tools --no-skills --no-context-files`, system prompt, prompt):

| measure | result | criterion |
|---|---:|---|
| valid JSON | 15/16 | ≥ 95 % → fail |
| `n` = 1 | 1/16 | 100 % → **fail** |
| status line matches the screen | 13/16 | ≥ 80 % → fail |
| progress in range | 1/16 | ≥ 70 % → **fail** |
| median / p90 wall | 2.04 s / 2.27 s | p90 ≤ 5 s → pass |

The model systematically read `n` as the minutes in the prompt ("The agent has been on this for
12 minutes" → `n: 12`) and gave progress equal to the elapsed minutes. The message text was about
as good as the rule baseline (13/16 both), so there is nothing here to integrate around.

Verdict: **fail**. The Watcher keeps its current model. The chat model is still registered
(`lfm3/lfm3-1.7b`) for other experiments, with `:off` recommended.

### Titles and summaries — FAIL

Informal 8-case title check with the same chat model, thinking off, "at most 8 words, keep the
concrete nouns": 3 titles were clean (e.g. "Cleanup of stale build cache in `.cache` directory"),
one reply was a paragraph about the LFM family, two leaked `</think>` and repeated the instruction,
and several were over 8 words. 3/8 < 80 %.

An informal 4-case summary check ("one line, at most 20 words"): 2 were clean; one prefixed
"One-line summary:" and ran long, and one described the LFM3 model itself instead of the task.

Verdict: **fail**. No title or summary path was added.

## Decision

Integrate d1-2B as a pi classifier and a tool, off by default behind `PI_LFM3`; register LFM3-1.7B
as an experimental chat model but route nothing to it; keep the Watcher and titles on their current
path. The fallback for every d1 call is the agent's own judgement, and the tool says when it fell
back.
