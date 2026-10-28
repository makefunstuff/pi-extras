# pi-extras

Extensions that make [pi](https://pi.dev) work better, especially with local models
(llama.cpp, Ollama, LM Studio, vLLM…). It is one pi package: install it once, then turn each
extension on or off on its own.

**Release 0.1.0** (2026-10-20): five extensions, each measured against plain pi. The unreleased
`codemode-steer` adds a sixth — see
[What each one fixes](#what-each-one-fixes-how-to-enable-it-and-what-it-measured) and
[CHANGELOG.md](CHANGELOG.md). `lfm3` is new and unreleased; it ships in the same package but is
off until `PI_LFM3=on`.

## Extensions

| extension | what it does | status |
|---|---|---|
| [`lessons`](extensions/lessons/README.md) | when something failed and was then fixed, asks for a short cue / lesson / evidence note and keeps it (Hindsight memory, or a local file); at the start of the next task in the same repo, appends only the notes that apply (Jev decides), so the mistake is not repeated. No system-prompt text, no tool | **beta** |
| [`local-edit`](extensions/local-edit/README.md) | replaces pi's `edit`. It places near misses when exactly one spot fits (indentation ignored, or ≥ 0.95 similar), and on a miss shows the closest lines with line numbers. Every edit returns a compact diff of removed and added lines. It also repairs basename and `path#tag` paths. Same tool schema, so the prompt cache is kept. Cloud results in; local numbers on Strata (reduced sample) | **new** |
| [`codemode-steer`](extensions/codemode-steer/README.md) | makes models use `codemode` for multi-step work: a clearer prompt with a decision rule and an example, then by default a short nudge after four direct calls. Opt-in `enforce` blocks further direct calls with an error that shows the script shape (and gives up after two blocks, so a model that cannot write a script is never stuck; model-only tools such as `tool_search` are never blocked). Cloud measured; local profile unit-tested | **new** |
| [`loop-guard`](extensions/loop-guard/README.md) | notices blind retries of a failed tool call, repeated no-progress calls and runs that stop on "I'll …" with no tool call, and appends a short correction (never rewrites history, so the prompt cache stays) | stable |
| [`thinking-guard`](extensions/thinking-guard/README.md) | stops runaway thinking: gives llama.cpp servers a per-request thinking budget, and aborts and re-issues a reply that still thinks too long, with a "stop deliberating, act with a tool" note appended (append-only, so the prompt cache survives) | on for local models |
| [`lfm3`](extensions/lfm3/README.md) | Liquid AI's LFM3 on CPU: d1-2B answers yes/no and choice questions about one piece of text in one pass, with calibrated probabilities, as a pi classifier and the `lfm3_decide` tool. LFM3-1.7B is registered as an experimental chat model. Off by default (`PI_LFM3=on`). The board's Watcher and task titles were tried and failed the POC, so nothing routes to it | **new, off by default** |
| [`verify-gate`](extensions/verify-gate/README.md) | runs the project's check (`.pi/verify` or AGENTS.md) before the agent may finish after editing files; on failure the agent gets the output for another round (at most 2). Adds a prompt line: tests must not share assumptions with the code | stable |
| [`d3-context`](experimental/d3-context/README.md) | lets a local decision model (vllm-d3 over the System One wire) keep, summarise or drop old tool output and pin key lines, editing the context at subtask boundaries; needs `D3_URL`, not in the package manifest (load with `pi -e`). Result: no gain, higher cost with cached providers: [RESULTS.md](experimental/d3-context/RESULTS.md) | **experimental** |

Each extension lives in its own folder under `extensions/<name>/` with its own README;
experimental extras live under `experimental/`.

## Install

Needs pi 1.3.0 or newer (and Node 22.19+, which pi needs anyway).

```bash
pi install git:github.com/makefunstuff/pi-extras          # personal, ~/.pi/agent/settings.json
pi install -l git:github.com/makefunstuff/pi-extras       # this project only, .pi/settings.json
pi install git:github.com/makefunstuff/pi-extras@v0.1.0    # pinned to a tag or commit
pi -e git:github.com/makefunstuff/pi-extras               # try it for one run, no install
```

`pi update --extensions` pulls the latest version; `pi remove git:github.com/makefunstuff/pi-extras`
removes it. `pi install git:…` clones the repository, so it works without npm; the package is not
published to npm.

## Enable and disable extensions

All extensions of the package load by default. To choose:

```bash
pi config          # TUI: toggle each pi-extras extension (Tab switches personal / project scope)
pi config -l       # start in the project scope
```

or filter in `settings.json` (`-path` drops one extension, `[]` drops all of them):

```json
{
  "packages": [
    {
      "source": "git:github.com/makefunstuff/pi-extras",
      "extensions": ["-extensions/lessons/index.ts"]
    }
  ]
}
```

## What each one fixes, how to enable it, and what it measured

Numbers are **before → after**: the same bench, the same tickets and the same model, run without
the extension and with it. Every table names its own sample size, because the local series were
cut short to save GPU time: the local model in this release is **Swift 1.5 Qwen3.8-Flash-Next
IQ3_S on Strata** (pi provider `strata/swift-1.5-flash-next-iq3_s`), and its runs are a reduced
sample against the cloud's. Nothing here was measured on the Qwen3.8-27B that was planned (its
router was offline), and the partial 27B runs are named where they exist. Raw rows and the full
method are in each extension's README and `bench/results/summary.md`.

### codemode-steer

**What it fixes.** `codemode` is declared next to `read`, `bash`, `edit` and `write`, and models
almost never choose it: over 174 recorded sessions it was **2.0 % of tool calls**, and only 22
sessions used it at all. Local providers do get the tool; the direct tools are simply easier, and
the one built-in codemode guideline did not change the choice. A strong prompt-only probe still
produced four `bash` calls and no codemode call on DeepSeek Flash.

**Enable and configure.** On by default once the package is installed, but it only acts while
`codemode` is active (`"defaultTools": ["+codemode"]`, or `pi --tools +codemode`). `nudge`
(default) appends one note after 4 direct calls; opt-in `enforce` blocks instead, with 2 blocks
before it gives up; `hint` only changes the prompt; `off` disables it.
`PI_CODEMODE_STEER_AFTER` and `PI_CODEMODE_STEER_BLOCKS` change the thresholds,
`PI_CODEMODE_STEER_PROFILE=cloud|local` overrides detection, and `/codemode-steer` shows the
counters. Local models get a shorter hint that says to write raw JavaScript, not a markdown fence.
To unload: `"-extensions/codemode-steer/index.ts"`.

**Measured** (3 tickets, 2 rounds, 6 runs/arm, hidden `node:test` graders, DeepSeek Flash):

| arm | hidden tests | tool calls | codemode calls | codemode share | turns |
|---|---:|---:|---:|---:|---:|
| off | 6/6 | 88 | 0 | 0.0 % | 73 |
| codemode-steer (`enforce`, opt-in) | 6/6 | 41 | 13 | 31.7 % | 43 |

- Same success, roughly half the calls and turns. Four direct calls were blocked; no run reached
  the two-block give-up.
- The default `nudge` mode on the same tickets passed 3/3 with 1 codemode call of 24 (4.2 %):
  safe, but enforcement is what moves the choice, so `enforce` stays available as an option.
- **Local models are not measured**: the local endpoints were not reachable from the eval machine,
  and no GPU server was started or switched. The local profile is covered by unit tests; recorded
  sessions show local Strata Swift already used codemode more than the cloud models (5.5 %), while
  most other local models used it never.
- Recommendations for pi (per-model `codemode.mode`, a per-provider opt-out from the codemode
  grammar) and for local provider config are in the extension README.

### verify-gate

**What it fixes.** "All done, the tests pass" when the tests were written from the same wrong
assumption as the code, or were never run after the last edit. Before the agent may stop after
changing files, verify-gate runs the project's own check; on failure it appends the output and
sends the agent back for another round (at most two). It also adds one system-prompt line: tests
must not share assumptions with the code under test.

**Enable and configure.** On by default once the package is installed. It needs a check command
written down for it, and finds one from the working directory up to the repository root:
`.pi/verify` (a shell script) first, then `AGENTS.md` in one of three explicit forms
(`<!-- verify: npm test -->`, ``Verify: `npm test` ``, or a `## Verify` section's first code
block). With no command found it only adds the prompt line, and it never runs a check in a project
pi does not trust. `/verify` runs the check by hand. Environment: `PI_VERIFY_GATE=off|gate-only|rule-only`
(default `on`), `PI_VERIFY_ROUNDS` (2), `PI_VERIFY_TIMEOUT` (300 s), `PI_VERIFY_MAX_OUTPUT`
(4000 characters). To unload: `"-extensions/verify-gate/index.ts"` in the package's `extensions`
filter.

**Measured** (11 tickets, hidden `node:test` graders; `plain` prompt = nobody tells the agent to
test, which is the case the gate is for):

| sample | hidden tests pass, base → gate |
|---|---|
| cloud, DeepSeek Flash, 3 rounds, 33 runs/arm, `plain` | 33/33 → 33/33 |
| cloud, Claude Sonnet 5.5, 3 rounds, 27 runs/arm, `plain` | 27/27 → 27/27 |
| cloud, DeepSeek Flash, 3 rounds, 33 runs/arm, `told` | 33/33 → 32/33 |
| local Strata, 2 rounds, 22 runs/arm, `plain` (**reduced sample**) | 20/22 → 22/22 |

- In all 240 cloud runs the project's check was already green when the agent stopped, in the base
  arms too: the gate had nothing to catch, sent no agent back, and its 120 checks never failed.
- Locally the same: all 22 of the gate arm's checks passed and it never sent an agent back, so
  **20/22 → 22/22 is run-to-run noise, not the gate's doing** (303 runs in all, counting the 19
  partial 27B runs). Both base misses were
  self-confirming tests with a green project check — the failure the prompt line targets, and the
  one a green check cannot see.
- Cost: one run of the check per prompt. Median wall 164 s → 165 s, output 12.8k → 12.9k tokens.
  97 % of prompt tokens came from the cache, in both arms.

**Read this as:** on cloud models the gate costs a check run and changes nothing; on a local model
that passes the tickets it is the same. Its value is on a project whose check the agent does not
run by itself — a case that did not occur in any of these 306 runs, and which is covered by unit
and smoke tests instead.

### local-edit

**What it fixes.** Local models fail far more edits than cloud models in pi: in 86 recorded
sessions **15.4 %** of local edit calls failed against **4.9 %** for cloud, and most are near
misses (a typo, the wrong indentation, a basename instead of a path, a literal `\n`) for which pi's
`edit` says only "Could not find the exact text". Edits that succeed can also silently delete the
lines next to the replacement. local-edit replaces `edit` with the same tool schema: it places a
near miss when exactly one spot fits, shows the closest lines with line numbers when it does not,
returns a compact diff for every edit and warns when lines were dropped, and repairs
`path#tag`/basename paths.

**Enable and configure.** On by default once the package is installed; it replaces pi's `edit`
tool, with no settings of its own. To turn it off: `pi config`, or
`"-extensions/local-edit/index.ts"` in the package's `extensions` filter. For one run:
`pi -e ./extensions/local-edit/index.ts`.

**Measured:**

| sample | before → after |
|---|---|
| replay of 376 local edit calls from 94 recorded sessions (offline, no model) | llama.cpp **9.9 % → 9.0 %** failed calls, Strata **7.9 % → 7.2 %** |
| the 287 successful edits in that replay (local and cloud) | outcome unchanged in all of them (no edit changed the file it produced) |
| live cloud bench, DeepSeek Flash, 6 rounds × 3 edit-heavy tickets, 18 runs/arm | 18/18 → 18/18 hidden tests; edit errors 1/30 → 0/26; edits dropping ≥ 3 lines **3 → 0** |
| live local bench, Strata, 1 round × 3 tickets, 3 runs/arm (**reduced sample**) | 3/3 → 3/3; 0 edit errors in both arms |
| cost of a miss (a 300-line stale `oldText` in a 3,000-line file) | **37.6 s → 32 ms** |

- Only 13 of the 32 local failures in the replay could be rebuilt from the session, so read the
  replay rates as a direction, not a measurement: local-edit places about one rebuildable failure
  in four, and refuses the rest with a message that says what to do.
- Neither DeepSeek Flash nor Strata missed an edit on the live tickets, so the bench arms cannot
  be told apart on errors; the value on local models rests on the replay.

### loop-guard

**What it fixes.** A model that keeps doing the same failing thing: an identical tool call after
the same failure, the same successful call over and over, a run of nothing but failures, and runs
that end on "Let me fix the parser." with no tool call at all. It appends one short line — to the
newest tool result, or as one extra turn for a stall — and never rewrites history, so a hybrid
model's prompt cache survives.

**Enable and configure.** All four rules (retry, repeat, streak, stall) are on by default.
`PI_LOOP_GUARD=off` turns them all off, `PI_LOOP_GUARD=-stall,-repeat` turns single rules off.
`/loop-guard` shows how often each rule fired in the session. To unload:
`"-extensions/loop-guard/index.ts"`. Calls made inside a codemode script are not conversation tool
results, so they are tracked through the codemode call itself.

**Measured** (9 tickets, hidden graders, 3 of them traps whose obvious first call fails):

| sample | before → after |
|---|---|
| cloud tickets, Claude Sonnet 5.5, 3 rounds, 27 runs/arm | 27/27 → 27/27, 0 notes, 0 nudges |
| cloud tickets, DeepSeek Flash, 3 rounds, 27 runs/arm | 27/27 → 26/27 (no note and no nudge in the failed run: the guard did not act in it) |
| cloud injection (a failing call forced twice), DeepSeek Flash, 5 rounds/scenario | retry note fires 5/5 per scenario; **0** blind retries in either arm |
| cloud injection, stall ending, 5 rounds | **0/5 → 5/5** runs passed: the nudge rescued every run |
| local tickets, Strata, 1 round, 5 runs/arm (**partial sample**, 5 of 9 tickets) | 5/5 → 5/5, guard never fired; median wall 147 s → 195 s |
| local injection, Strata, 1 run/scenario (**partial sample**) | stall **0/1 → 1/1**; retry-edit **1/1 → 0/1**: after the retry note the model miscounted its calls and stopped with no change |

- Over 658 recorded sessions (94 local, 568 cloud) the rule that catches an identical retry of a
  failed call would fire on 4 of 4,537 local tool calls and 14 of 60,280 cloud ones; the stall
  rule on 2 of 4,573 local turns. The problem is real and rare, which is why the guard is
  append-only and silent in normal runs.
- On the local sample the guard stayed silent on every ticket, and one injection run went the
  wrong way after its note. Watch it with this model.

### lfm3

**What it fixes.** Small decisions that would otherwise take a big-model turn or a person: is an
agent stuck or waiting for a permission prompt, is a review finding blocking, is an issue a bug or
a feature and which repo, are two issues the same. Liquid AI's **d1-2B** answers up to six yes/no
and choice questions about one piece of text in one pass, with calibrated probabilities and no
generated tokens. It costs nothing, runs on the CPU, and is registered as a pi classifier and as
the `lfm3_decide` tool.

**Enable and configure.** Off by default. `PI_LFM3=on`, or `{"enabled":true}` in
`~/.pi/agent/lfm3.json`, after starting the two CPU servers in the
[README](extensions/lfm3/README.md). `/lfm3` shows whether they answer; `/lfm3 on|off` switches the
provider for the session. When a server is down the tool says so and the agent decides without it.

**Measured:**

| sample | result |
|---|---|
| 40 classification cases, through headless `pi -p --mode json` and pi's classifier registry | **40/40** (stuck uses three questions in one request; one generic stuck question was 37/40); median 454 ms, p90 924 ms |
| d1-2B footprint | 1.85 GiB Q8 file, 1.95 GB RSS at 32K context |
| 16 realistic screens, the board's own Watcher prompt | valid JSON 15/16, `n` 1/16, status line 13/16 (rule baseline 13/16), progress 1/16; **not integrated** |
| 8 task titles | 3/8 clean (paragraphs, `</think>` leaks, too long); **not integrated** |

The model read the Watcher example's `n` as the minutes and its progress as elapsed time, so the
board's `read_answer` would drop the row. The chat model is registered as `lfm3/lfm3-1.7b` for
experiments, with `:off` recommended; nothing routes to it. Gate and raw rows:
[bench/GATE.md](extensions/lfm3/bench/GATE.md), [results](extensions/lfm3/bench/results/summary.md).

### thinking-guard and lessons: cloud numbers only

Both extensions ship in 0.1.0 and are measured on cloud models, and neither has local numbers:
the owner skipped their local series (the local model passes those tickets in the other
extensions' runs), and nothing was re-run for this release. Their READMEs carry the cloud results
and what is still open — [thinking-guard](extensions/thinking-guard/README.md) (cloud pass rate
28/30 → 29/30 with the guard on for all models, 4 runaway turns over 8k characters → 0, every
aborted reply followed by a tool call; local 27B replay 13.7–56.1k → 6.8–12.7k characters of
thinking; **Strata ignores `thinking_budget_tokens`, so only the abort path acts there**) and
[lessons](extensions/lessons/README.md) (repeated house-rule mistakes across a sequence of
related tickets **41 % → 0 %**, p < 0.001, with 5 % fewer tokens per ticket; a cloud rerun with
working Hindsight writes is still open).

## Experimental extras

`experimental/d3-context` is an experiment, not part of the installed package manifest: it is
loaded with `pi -e` and needs `D3_URL`. It recorded a negative result — no gain, higher cost with
cached providers — and its [README](experimental/d3-context/README.md) and
[RESULTS.md](experimental/d3-context/RESULTS.md) say what it measured, separately from the
extensions above. The repo's first experiment, `experimental/llama-native`, is removed in this
release; see [Removed](#removed).

## Development

```bash
npm ci --ignore-scripts        # pi 1.3.0 as a dev dependency, for the tests
npm test                       # unit tests (node:test, TypeScript via node's type stripping)
npm run smoke                  # headless pi -p smoke test against a mock model
scripts/check.sh               # everything CI runs
pi install "$PWD"              # use your checkout as the installed package
```

- **New extension**: copy [`templates/extension/`](templates/extension/README.md) to
  `extensions/<name>/`. The package manifest (`pi.extensions` in `package.json`) picks up every
  `extensions/*/index.ts`, so nothing else needs registering. Add a line to the table above.
- **Unit tests**: `*.test.ts` next to the code. [`test/lib/fake-pi.ts`](test/lib/fake-pi.ts) is a
  stand-in for pi's extension API that records registered tools, commands and providers and fires
  events.
- **Smoke test**: [`test/smoke.mjs`](test/smoke.mjs) makes a throw-away copy of your pi config
  (`~/.pi/agent`, without sessions; an empty config when there is none, as in CI), installs the
  package into it the way users do, `pi install git:github.com/makefunstuff/pi-extras`, served
  from a snapshot of the working tree (so without the dev `node_modules`), adds a mock
  OpenAI-compatible model on loopback, and runs `pi -p`: the package must load next to everything
  else in the config, with no extension errors. It then runs every
  `*.smoke.mjs` spec, which scripts the mock model's answers (tool calls included) and checks
  the output; see [`templates/extension/template.smoke.mjs`](templates/extension/template.smoke.mjs).
  `PI_EXTRAS_SMOKE_CONFIG=empty|copy` picks the config, `PI_EXTRAS_SMOKE_INSTALL=path` skips
  the git install, `PI_EXTRAS_SMOKE_MODEL=provider/id` runs
  the first step on a real model instead of the mock.
- **Bench**: [`bench/`](bench/README.md) is one shared bench for every extension and experiment:
  tickets (`issue.md`, `repo/`, `hidden.test.ts`, `ref/`), arms, pi driven in-process through its
  SDK (`createAgentSession`), and reports over recorded rows. `node bench/run.ts --bench pi-extras`,
  `--bench d3-context`; `node bench/selftest.ts` checks the tickets without a model, and
  `--dry-run` checks the harness the same way.
- **Dependencies**: runtime packages an extension imports go in `dependencies`. pi provides
  `@earendil-works/pi-*` and `typebox` itself: import them, never list them in `dependencies` or
  `peerDependencies` (next to the pi devDependency, npm would then lock them for production and
  git installs would get their own copy); `test/package.test.mjs` checks this.
- **CI**: [GitHub Actions](.github/workflows/ci.yml) runs `scripts/check.sh` on Node 22 and 24.
  It starts with a **no-Python check** (`scripts/no-python.sh`): a Python file — `.py`, `.pyc`,
  `__pycache__`, tracked, untracked, or written by a ticket generator — or a Python config file
  (`requirements.txt`, `pyproject.toml`, …) fails the run. `scripts/check.sh` runs the same check
  first and last, so a generated ticket tree is covered too. Everything in this repo is TypeScript
  and runs on node; `npm ci` is the only install. It then runs the **public-repo rule**
  (`node scripts/no-secrets.mjs`): no key, secret, personal path (`/home/<user>/…`), routable IP
  address or tailnet hostname anywhere in the tree, tracked, untracked or generated — the repository,
  its recorded benchmark rows and its release notes are all public. A line that has to stay (the
  rule's own pattern, a synthetic public fixture a test needs) carries `no-secrets: allow` and says
  why; `test/release-hygiene.test.mjs` tests both.
- **Releasing**: [docs/RELEASE.md](docs/RELEASE.md) — version, changelog, tag, GitHub release, and
  the install check on a clean config. Pushing a `v*.*.*` tag runs
  [`.github/workflows/release.yml`](.github/workflows/release.yml): it checks the tagged commit and
  creates the release with notes from that version's `CHANGELOG.md` section
  (`node scripts/release-notes.mjs v<x.y.z> [out.md]`, which refuses a version that does not match
  `package.json` and notes that fail the public-repo rules).

## Layout

```
extensions/<name>/        one folder per extension (index.ts, tests, README)
experimental/<name>/      an experiment: extension, bench, results (its own README)
bench/                    the shared bench: tickets, arms, pi in-process through its SDK, reports
templates/extension/      starting point for a new extension
test/                     unit-test runner, smoke test, shared harness (mock model, config copy, fake pi)
docs/RELEASE.md           how to cut a release
scripts/check.sh          repository check (CI)
scripts/no-python.sh      the no-Python rule (CI's first step, called by check.sh)
scripts/no-secrets.mjs    the public-repo rule (no secrets, keys, personal paths, routable IPs)
scripts/release-notes.mjs a release's notes, from CHANGELOG.md, put through that rule
.github/workflows/release.yml  tag push → check → GitHub release
```

## Removed

- **2026-10-20: `experimental/llama-native`** — the in-process llama.cpp provider (extension, C++
  addon, benchmark, results). It was the original experiment of this repo, the one pi-extras grew
  out of, and it is deleted: it needed a llama.cpp build and a compiled addon, it measured the same
  tickets over HTTP and in-process, and it lost — same kernels, so the same decode and prefill
  speeds, and llama-server's prompt cache already reuses ~92% of the prompt in an agent loop, so
  there was nothing left for in-process to win. Nothing in this repo refers to it any more: the
  benches (`bench/`, and each extension's own) name an extension, a provider or a model, and the
  extensions that guard local models detect them by host and provider name.
  Its code, its results and its `RESULTS.md` stay in git history —
  `git log --oneline -- experimental/llama-native` for the commits, and
  `git show "$(git log -1 --format=%H --diff-filter=D -- experimental/llama-native)^:experimental/llama-native/RESULTS.md"`
  for the report as it stood before the removal.
- **2026-10-20: Python.** The benches were Python (a runner, a reporter, a proxy, ticket generators
  per experiment). They are one TypeScript bench now, `bench/`, driving pi in-process through its
  SDK; ticket repos and hidden tests are TypeScript, graded with `node --test`. The recorded runs
  stay as data (`.jsonl` rows, summary tables, `RESULTS.md`), and CI fails if a `.py` file appears.

## License

MIT
