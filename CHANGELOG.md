# Changelog

All versions of pi-extras. The package is installed from git
(`pi install git:github.com/makefunstuff/pi-extras`); it is not published to npm.

## Unreleased

- **`lfm3`** (new, off by default) — Liquid AI's LFM3 on the CPU. d1-2B answers up to six yes/no
  and choice questions about one piece of text in one pass, with calibrated probabilities and no
  generated tokens, as pi classifier `lfm3/d1-2b` and the `lfm3_decide` tool. 40/40 on the bench,
  median 454 ms, 1.95 GB RSS; the 16-screen Watcher prompt and the title/summary checks failed the
  gate, so neither is wired. LFM3-1.7B is registered as an experimental chat model (`lfm3/lfm3-1.7b`, use `:off`).
  Enable with `PI_LFM3=on`; [README](extensions/lfm3/README.md), [gate](extensions/lfm3/bench/GATE.md).
- **`codemode-steer`** (new) — makes models use `codemode` for multi-step work. While codemode is
  active it adds a decision rule, clearer guidelines and an example to the prompt, and in the
  default `enforce` mode blocks direct calls after four (with a two-block give-up limit, so a
  model that cannot write a script is never stuck); model-only tools such as `tool_search` are never
  blocked, since a script cannot call them. `nudge`, `hint` and `off` are available, and
  local models get a shorter raw-JavaScript hint. Measured on DeepSeek Flash, 3 tickets × 2 rounds:
  **6/6 passed in both arms**, codemode share **0.0 % → 31.7 %**, tool calls 88 → 41, turns 73 → 43.
  Local endpoints were not reachable for the eval; the local profile is unit-tested. The extension
  README also recommends a per-model `codemode.mode` in pi. [README](extensions/codemode-steer/README.md)
- The shared bench counts codemode and direct calls, codemode errors and codemode-steer blocks in
  every row, and its report has a codemode table.
- The release workflow updates a release that already exists instead of failing on it. Pushing a tag
  schedules the workflow twice (the file is on the tag and on the default branch), and the run that
  arrived second on v0.1.0 ended with `HTTP 422 … Release.tag_name already exists`. The release
  itself was fine.

## 0.1.0 — 2026-10-20

First release. One pi package, five extensions, each loaded on its own, each measured against
plain pi on the same tickets. Needs pi 1.3.0 and Node 22.19+.

```bash
pi install git:github.com/makefunstuff/pi-extras@v0.1.0    # pinned
pi install git:github.com/makefunstuff/pi-extras           # latest from main
```

### Extensions

- **`verify-gate`** (stable) — runs the project's check (`.pi/verify`, or a `Verify:` line in
  `AGENTS.md`) before the agent may stop after editing files, and sends it back with the output for
  at most two rounds. Adds one prompt line: tests must not share assumptions with the code under
  test. `/verify` runs the check by hand. Measured: cloud 33/33 → 33/33 hidden tests (DeepSeek
  Flash, 3 rounds); local Strata 20/22 → 22/22 (2 rounds, reduced sample) — the gate never sent an
  agent back in 306 runs, so the local difference is noise, not the gate. Cost: one check run per
  prompt, 97 % of prompt tokens from the cache.
  [README](extensions/verify-gate/README.md)
- **`local-edit`** (new) — replaces pi's `edit` with the same tool schema: places near misses when
  exactly one spot fits (indentation ignored, literal `\n` decoded, ≥ 0.95 similar whole-line
  window), names the closest lines with line numbers on a miss, returns a compact diff for every
  edit and warns when lines are dropped, repairs basename and `path#tag` paths. Measured: local
  edit-failure rate 9.9 % → 9.0 % (llama.cpp sessions) and 7.9 % → 7.2 % (Strata sessions) in an
  offline replay of 376 recorded calls; none of the 287 successful edits changes outcome; live
  cloud bench 18/18 → 18/18 with edits dropping ≥ 3 lines 3 → 0; live local bench 3/3 → 3/3
  (1 round, reduced sample). A 300-line stale `oldText` against a 3,000-line file: 37.6 s → 32 ms.
  [README](extensions/local-edit/README.md)
- **`loop-guard`** (stable) — catches blind retries of a failed call, repeated no-progress calls,
  failure streaks and runs that stop on "I'll …" with no tool call, and appends one short
  correction. Append-only, so a hybrid model's prompt cache survives. Measured: cloud tickets
  27/27 → 27/27 (Sonnet 5.5) and 27/27 → 26/27 (DeepSeek Flash, guard inactive in the failed run),
  with no note and no nudge in any normal run; forced stall endings 0/5 → 5/5 passed. Local
  (partial: 5 of 9 tickets, 1 round): 5/5 → 5/5 with the guard never firing; the stall nudge
  rescued its run, and one retry-edit run stopped after its note.
  [README](extensions/loop-guard/README.md)
- **`thinking-guard`** (on for local models) — gives llama.cpp servers a per-request thinking
  budget (`thinking_budget_tokens` plus a stop message), and aborts and re-issues a reply that
  still thinks past the limit, with a "stop deliberating, act with a tool" note. Measured on cloud
  (guard on for all models): DeepSeek Flash 28/30 → 29/30 runs, turns thinking past 8k characters
  4 → 0, every aborted reply followed by a tool call; on the 27B replay of four real runaway turns,
  thinking 13.7–56.1k → 6.8–12.7k characters, with 16,404 of 16,408 prompt tokens reused.
  No local agent-ticket numbers: the local series was skipped. Note for servers that ignore the
  budget field (Strata does): only the abort path acts there.
  [README](extensions/thinking-guard/README.md)
- **`lessons`** (beta) — when something failed and was then fixed, asks the agent for a short
  cue / lesson / evidence note and keeps it (Hindsight memory, with a local-copy fallback); at the
  start of the next task in the same repository it appends only the notes a decision model (Jev)
  says apply. No system-prompt text, no tool, no tool-list change. Measured on cloud over
  sequences of five related tickets: repeated house-rule mistakes **41 % → 0 %** (p < 0.001), 5 %
  fewer tokens per ticket. No local numbers: the local series was skipped, and the cloud rerun with
  working Hindsight writes is still open. [README](extensions/lessons/README.md)

### Experiments

- **`experimental/d3-context`** (not in the installed package manifest) — a local decision model
  keeps, summarises or drops old tool output at subtask boundaries; loaded with `pi -e`, needs
  `D3_URL`. Measured negative: no gain, higher cost with cached providers.
  [README](experimental/d3-context/README.md), [RESULTS.md](experimental/d3-context/RESULTS.md)
- **`experimental/llama-native` is removed in this release** — llama.cpp inside pi's process as a
  model provider, the experiment pi-extras grew out of. It needed a llama.cpp build and a compiled
  addon, and it lost: same kernels, so the same decode and prefill speed, and llama-server's prompt
  cache already reuses ~92 % of the prompt in an agent loop. Its code, bench and `RESULTS.md` stay
  in git history, and the README's [Removed](README.md#removed) section gives a command that
  recovers the report as it stood.

### Known gaps in 0.1.0

- The local measurements are a reduced sample (Strata Swift 1.5 Qwen3.8-Flash-Next IQ3_S, cut short
  to save GPU time): verify-gate 2 rounds `plain` only, local-edit 1 round, loop-guard 5 of 9
  tickets, thinking-guard and lessons none. The Qwen3.8-27B runs that were planned were not done
  (its router was offline); 19 partial verify-gate and 4 partial local-edit 27B runs are kept as
  data and are too few to read on their own.
- 24 cloud runs (Claude: `presets-ini` and `sqlite-migration`, 3 rounds × 4 arms) are missing: the
  Anthropic key in the bench config failed mid-series, and the bench records them as provider errors.
- Every number is on pi 1.3.0, measured 2026-10-18…20.

### Also in this release

- The package layout, manifest (`pi.extensions` globs), extension
  [template](templates/extension/README.md), the headless smoke test that installs the package from
  git into a throw-away config copy and runs `pi -p` against a mock model, and
  [`scripts/check.sh`](scripts/check.sh) as the single repository check (CI: Node 22 and 24).
- **No Python in the repo.** The benches that were Python are one shared TypeScript bench,
  [`bench/`](bench/README.md), driving pi in-process through its SDK (`createAgentSession`), with
  TypeScript tickets (repo, issue, reference solution, hidden `node:test` grader); recorded runs
  stay as data (`.jsonl` rows, summary tables, `RESULTS.md`), and CI fails on a `.py` file
  (`scripts/no-python.sh`, run first and last by `scripts/check.sh`). Each extension's own bench is
  the same shape, with rows under `bench/results/`.
- `package.json` is `"private": true`: the package is installed from git, and it is not published
  to npm.
