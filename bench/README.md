# The shared bench

The bench of this repo: it runs tickets against **pi in-process, through pi's own SDK**
(`createAgentSession`), grades the final tree with the ticket's hidden `node:test` tests, and appends
one row per run to a `.jsonl` file. Everything is TypeScript and runs on node (no build step: node
strips the types). `--bench pi-extras` runs **every** extension against plain pi on the shared
tickets, so an extension's effect is one flag away.

```bash
node bench/run.ts --bench pi-extras --tasks all --arms off,verify-gate --rounds 2
node bench/run.ts --bench d3-context --arms base,d3 --rounds 2   # after gen-long-tasks.ts
node bench/report.ts --bench pi-extras        # → bench/results/pi-extras/summary.md
node bench/selftest.ts                        # tickets, no model
node bench/run.ts --bench pi-extras --tasks cli-json --arms off --dry-run --out /tmp/dry.jsonl
```

## Why one bench

Six extension benches and two experiment benches used to be separate programs (four of them in
Python), each with its own copy of: seeding a repo, running pi, reading a transcript, grading,
tabulating, and each with its own ticket format. That is what lives here instead, so an arm of one
experiment and an arm of another are the same shape and land in the same tables.

Five extensions still keep an `extensions/<name>/bench/` beside it. What is in those is what this
bench cannot do and what their recorded rows were measured with: offline replays of real pi sessions
(`local-edit/bench/replay.mjs`, `loop-guard/bench/replay.ts`, `thinking-guard/bench/replay.ts`),
forced-trap injection (`loop-guard/bench/run.ts --inject`), a two-sequence curriculum whose traps are
hidden from the agent (`lessons/bench/`), and per-extension ticket sets and prompt styles
(`verify-gate/bench/`, `local-edit/bench/`). They are TypeScript on the same SDK, and each
extension's README table points at its own rows — recorded data. **New measurements go here**
(`--bench pi-extras`), not into a sixth copy: `lib/arms.ts` is where an extension joins the matrix.

pi runs in-process, not as a subprocess: an extension can be handed a config for one run
(`extensionFactories`), which an environment variable cannot do when a whole series shares one
process. Sessions, work trees and temporary files live under the bench cache
(`~/.cache/pi-extras/<bench>/`), never in the repo: a transcript holds the full system prompt and
the tool output, which is not repo data.

## Files

| path | what |
|---|---|
| `run.ts` | the runner CLI: `--bench`, `--tasks`, `--arms`, `--rounds`, `--model`, `--workers`, `--timeout`, `--dry-run` |
| `report.ts` | → `bench/results/<bench>/summary.md`: pass rate, wall time, turns, calls, edits, tokens, cost, per arm and task. A recorded experiment's own `results/summary.md` is data, never overwritten from here |
| `selftest.ts` | every ticket: the broken repo fails the hidden tests, repo + reference passes them and its own tests |
| `gen-bulk-rename.ts` | generates `tickets/bulk-rename` (deterministic; the generated tree is committed) |
| `lib/pi.ts` | one pi session, the way the CLI makes one: `agentCopy` (a copy of `~/.pi/agent`, never the real one), `openSession`, `runPrompt`, `runSteps` |
| `lib/tickets.ts` | the ticket layout, seeding, grading (`node --test`), `selftest` |
| `lib/session.ts` | reading a transcript: turns, calls, errors, tokens, context growth, compactions, repeats, re-reads |
| `lib/run.ts` | one run (seed → session → grade → row) and the resumable series |
| `lib/arms.ts` | the arms: `pi-extras` (each extension against plain pi), `d3-context` (the router against plain pi) |
| `lib/report.ts` | the tables, over recorded rows (field names of both the current and the older runs) |
| `lib/util.ts` | CLI args, the cache and TMPDIR, tables, row files, git |
| `tickets/` | the shared tickets |

## Tickets

```
tickets/<name>/
  issue.md          the task, as the agent reads it
  repo/             the starting tree (seeded into a git repo, committed as "init")
  hidden.test.ts    the outcome test, run with `node --test` on the final tree; not in the repo
  ref/             the reference fix, applied on top of repo/ (used by the self-test only)
```

A good ticket **discriminates**: the seeded repo fails the hidden tests, `ref/` makes them pass, and
the repo's own visible tests pass in both. `node bench/selftest.ts` checks exactly that, with no
model, and CI runs it. `bulk-rename` is generated (`gen-bulk-rename.ts`, fixed seed) because its
value is being large and mechanical; the generated files are committed so a run is reproducible.

An outcome test checks the *answer* (`notes.md`, with citations) rather than the code when the task
is a read over a long context: a confident wrong number must fail. `experimental/d3-context/bench/long-tasks/`
builds those, computing the expected answers from the fixtures as it writes them.

## Rows

One JSON line per run: the arm, task, round, pass/fail, wall time, the session stats (turns, tool
calls and errors, edits, malformed calls, tokens in/out/cache, context peak and mean, compactions,
repeats, re-reads, provider errors), the ticket's `hidden_tail`, and the arm's own fields.

- Rows are appended as runs finish, so an interrupted series keeps what it measured.
- A `(arm, task, round)` pair already in the file is skipped, so a series resumes.
- Per-run artifacts sit next to the rows, in a folder named after the arm: `<task>-r<round>.diff`,
  `.stderr`, `.metrics.jsonl`, and an extension's own log for that run.
- `--dry-run` seeds and grades without calling a model. That is the CI check of the harness: seeding,
  grading, artifacts, resumability. It reports FAIL on purpose (the seeded tree is broken).

## Cost and honesty

`lib/session.ts` counts what pi reported; `bench/report.ts` prices it with `PRICES` in
`lib/session.ts` (list prices, kept in the repo so a table can be read years later). A run with a
provider error, a timeout, or a `session` that did not finish is kept in the rows and excluded from
the performance means by `perf()`, never silently dropped. The recorded `results/` of the
experiments are data from past runs, and the code in this repo is all TypeScript: where a recorded
series was measured by code that has since been replaced — the d3-context runs of February 2026 ran
on this experiment's own Python scripts, removed in October 2026 — the README of that experiment
says so, and points at the TypeScript equivalents that reproduce the measurements.
