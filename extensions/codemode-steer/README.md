# codemode-steer

Makes models use pi's `codemode` for multi-step work instead of a string of direct `read`, `bash`
and `edit` calls. Works on cloud and local models; it changes nothing when `codemode` is not
active.

## Why

`codemode` is declared next to the direct tools, and models almost never pick it. In 174 recorded
pi sessions (2026-09-01 onward), it was **283 of 14,104 tool calls (2.0 %)**; in the 157 sessions
where the system prompt declared it, it was **283 of 13,865 (2.0 %)**, and only **22 sessions**
used it at all. Per model with at least one tool call, over the sessions where codemode was available:

| model | sessions | tool calls | codemode calls | share | sessions using it |
|---|---:|---:|---:|---:|---:|
| strata/swift-1.5-flash-next-iq3_s (local) | 23 | 3,995 | 221 | 5.5 % | 13 |
| opencode-go/deepseek-v4.1-flash | 20 | 2,276 | 8 | 0.4 % | 2 |
| anthropic/claude-opus-5-5 | 47 | 2,089 | 12 | 0.6 % | 2 |
| llama.cpp/qwen3.6-35b-a3b (local) | 17 | 1,567 | 3 | 0.2 % | 1 |
| deepseek/deepseek-flash | 8 | 976 | 0 | 0.0 % | 0 |
| basalt/swift-1.5-flash-next-iq3_s (local) | 3 | 924 | 1 | 0.1 % | 1 |
| anthropic/claude-sonnet-5-5 | 10 | 596 | 19 | 3.2 % | 1 |
| other local models (8) | 22 | 396 | 0 | 0.0 % | 0 |

The tool was presented to local providers too: the local sessions above had `codemode` in their
declared tool list, and their model entries have `supportsTools: true`. The problem is not that
local templates skip the tool. It is that the direct tools are easier, and the one built-in
codemode guideline ("batch independent tool calls") is too weak to change the choice.

What it is not: schema size (in an empty-config request codemode's description was 1,435
characters against read 422 and bash 364, well inside its 3,000-token inline budget), or
`tool_search` (it loads only tools that are not declared, so an active codemode is never one of its
results). The decision is direct call versus script, and the default presentation does not tip it.

A probe on DeepSeek Flash confirmed it: with a strong appended system-prompt instruction to batch
work through codemode, the model still made four `bash` calls and no codemode call. Forcing
`codemode.mode: only` (hiding the direct tools) made it use codemode immediately, but that is a
global settings change and breaks models that cannot write a script. This extension steers at the
call boundary instead, and leaves a way out.

## What it does

While `codemode` is active:

1. **Prompt.** Replaces the one-line codemode snippet with a decision rule, one or two guidelines
   and a working example. Local models (detected by provider name or a loopback/private-network
   base URL) get a shorter version and an explicit "raw JavaScript, no markdown fence" hint.
2. **Call boundary.** The default `nudge` mode appends one short note after the threshold and never
   blocks. In opt-in `enforce` mode the first `PI_CODEMODE_STEER_AFTER` direct calls (default 4)
   run normally; further direct calls are blocked with an error that names codemode and shows the
   script shape. Calls made from inside a script (`parentToolCallId`) and
   codemode itself are never blocked. After `PI_CODEMODE_STEER_BLOCKS` blocks (default 2) in one
   prompt the extension gives up and lets the model continue directly, so a model that cannot
   write a script is never stuck.

Only tools whose exposure is `direct` are counted and blocked. `model-only` tools such as
`tool_search` and `codemode` itself are declared to the model but cannot be called from a script,
so steering them into codemode would point the model at something that cannot work; they are left
alone, as are a few interactive tools.

Modes:

| `PI_CODEMODE_STEER` | behavior |
|---|---|
| `nudge` (default) | prompt hints + one note appended to a tool result after the threshold; never blocks |
| `enforce` | prompt hints + block direct calls after the threshold, with a give-up limit |
| `hint` | prompt hints only |
| `off` | does nothing |

Settings:

| variable | default | meaning |
|---|---:|---|
| `PI_CODEMODE_STEER` | `nudge` | `off`, `hint`, `nudge`, `enforce` |
| `PI_CODEMODE_STEER_AFTER` | `4` | direct calls allowed before steering (0 blocks the first one) |
| `PI_CODEMODE_STEER_BLOCKS` | `2` | blocked direct calls per prompt before giving up |
| `PI_CODEMODE_STEER_PROFILE` | `auto` | `auto`, `cloud` or `local`; overrides detection |

The extension is on for every model once the package is installed, in `nudge` mode, which never
blocks; the measurement below is DeepSeek Flash only. For stronger steering set
`PI_CODEMODE_STEER=enforce`; for a long, strictly sequential task use `hint` or `off`.
`/codemode-steer` shows the mode, the current prompt's counters and the detected profile. To unload it: `"-extensions/codemode-steer/index.ts"` in the package's `extensions` filter.

## Results

**Cloud, DeepSeek Flash**, 3 tickets (`bulk-rename`, `cli-json`, `config-rename`), 2 rounds,
6 runs/arm, hidden `node:test` graders, same eval and model:

| arm | hidden tests | tool calls | codemode calls | codemode share | turns | steer blocks | gave up |
|---|---:|---:|---:|---:|---:|---:|---:|
| off | **6/6** | 88 | 0 | **0.0 %** | 73 | 0 | 0 |
| codemode-steer (`enforce`) | **6/6** | 41 | 13 | **31.7 %** | 43 | 4 | 0 |

Same success, roughly half the calls and turns, and codemode went from never used to a third of
the work. No run hit the give-up limit; the four blocks were enough.

A `nudge` run on the same 3 tickets with the same threshold (1 round, 3 runs) passed 3/3 but made
only 1 codemode call of 24 (4.2 %). That is the safe default; `enforce` is the opt-in setting for
stronger steering. The nudge rows are in `bench/results/nudge.jsonl`.

**Local models are not measured here.** The local endpoints (`llama.cpp`, Strata, vLLM) were not
reachable from the machine that ran this eval, and the task forbade starting or switching GPU
servers. The local profile and its hint are covered by unit tests with fake models; the usage
numbers above are cloud only. The recorded sessions show local Strata Swift already used codemode
more than any cloud model (5.5 %), but most local models used it never.

## Recommendations outside this extension

- **pi:** a per-model `codemode.mode` (or a "prefer codemode" model preference) would let local
  models run in `only` mode without hiding direct tools for every model. Today it is a global
  setting.
- **pi:** the codemode tool declares a `constrainedSampling` grammar for capable providers. Local
  OpenAI-compatible servers vary in whether they enforce it; a per-provider opt-out would make
  failures easier to diagnose. This was not tested against a live local server here.
- **Local provider config:** keep `supportsTools: true` and use an endpoint that implements
  OpenAI-style tool calls. If a model cannot write a script reliably, set
  `PI_CODEMODE_STEER=hint` or `nudge` for it rather than `enforce`.
- **`tool_search`:** it only searches tools that are not declared, so an active `codemode` is not
  a search result. That is not the reason it is unused, but it means searching for "batch" will
  not surface it once it is active.

## Tests

```bash
node --test extensions/codemode-steer/index.test.ts
node bench/run.ts --tasks bulk-rename,cli-json,config-rename --arms off,codemode-steer \
  --rounds 1 --model deepseek/deepseek-flash
node bench/report.ts --bench pi-extras
```

The unit tests use pi's fake extension API (no model): config and profile detection, prompt
hints for cloud and local, blocking and its give-up path, nested and codemode calls never blocked,
nudge append-once, and the command output. The bench rows of the run above are in
[`bench/results/`](bench/results/).
