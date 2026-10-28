# lfm3

Liquid AI's [LFM3](https://www.liquid.ai/blog/lfm3) models on this machine, for small jobs. The
measured part is **d1-2B**, a decision model: one llama.cpp request answers yes/no and choice
questions about one piece of text, with calibrated probabilities and no generated tokens. It is
registered as a pi **classifier** (codemode and other extensions reach it through
`modelRegistry.classify`) and as the **`lfm3_decide`** tool. LFM3-1.7B is registered as a chat
model too, for experiments; the POC below did not find a job where it beats the current path.

Off by default. No provider, no tool and no request until `PI_LFM3=on` or the config file says
enabled. Nothing routes to LFM3 on its own.

## What it is good for

Use `lfm3_decide` for the small decisions that a coding agent would otherwise spend a big-model
turn on, or that the board currently leaves to a person:

- is this agent stuck, waiting for a permission prompt, or waiting for an answer?
- is this review finding blocking, or a nit?
- is this issue a bug, a feature, a question or a docs fix — and which repo?
- are these two issues the same problem?
- which team should handle this ticket?

One call takes 250-500 ms on CPU and costs nothing. The model is 1.85 GiB at Q8 and needs no GPU.

## Not good for (measured)

- **The board's Watcher.** On 16 realistic terminal snapshots LFM3-1.7B produced a sensible status
  line 13/16 times, but it read the example JSON's `n` as the *minutes* in 15/16 cases and its
  progress percent was the elapsed minutes (1/16 within the labelled range). The board's
  `read_answer` drops a row whose `n` is not the agent number, so the line would often not change
  at all. Do not set `watcher.agent` to LFM3.
- **Task titles and one-line summaries.** In an 8-case title check, 3 titles were clean; the
  failures included a paragraph about the LFM family instead of a title, leaked `</think>` text,
  and titles over the 8-word limit. In a 4-case summary check, 2 were clean; one prefixed
  "One-line summary:" and ran long, and one described the LFM3 model itself instead of the task.
  The chat model is not wired into any title or summary path.

The chat model is still registered (`lfm3/lfm3-1.7b`) because the provider is the point of this
extension and it is useful to try on a new small job. Select it with `:off` for speed; with
thinking on (`:medium`) it runs at about 8 tokens/s on CPU.

## Servers

Needs a llama.cpp build from 2026-10-27 or later: LFM3 support merged as
[#31252](https://github.com/ggml-org/llama.cpp/pull/31252) and d1 support as
[#31275](https://github.com/ggml-org/llama.cpp/pull/31275). Build the CPU backend only
(`-DGGML_CUDA=OFF -DGGML_VULKAN=OFF`); nothing here uses a GPU.

Download the weights (the LFM Open License v1.0 allows commercial use below $10M annual revenue;
read [the license](https://huggingface.co/LiquidAI/LICENSE) before redistributing them):

```bash
# chat model, about 1.0 GiB; the QAD Q4_0 build is Liquid's quantization-aware checkpoint
hf download LiquidAI/LFM3-1.7B-GGUF LFM3-1.7B-QAD-Q4_0.gguf --local-dir ~/models
# decision model, about 1.8 GiB
hf download LiquidAI/d1-2B-GGUF d1-2B-Q8_0.gguf --local-dir ~/models
```

Start the two CPU servers (loopback only; `-ngl 0` keeps every layer on the CPU):

```bash
llama-server -m ~/models/LFM3-1.7B-QAD-Q4_0.gguf \
  --host 127.0.0.1 --port 18181 -ngl 0 -c 16384 --jinja -t 8

llama-server -m ~/models/d1-2B-Q8_0.gguf \
  --host 127.0.0.1 --port 18182 -ngl 0 -c 32768 -b 8192 -ub 8192 -t 8
```

The d1 batch size must hold a question's state and media: `-b 8192 -ub 8192` is the value from
the model card. The chat server's `-c 16384` matches the model metadata this extension registers;
raise both if you need more context, at about 200 MiB of KV cache per 16K tokens (1.6 GB at 128K, per Liquid).

`/lfm3` shows whether each server answers and what is registered.

## Enable

```bash
PI_LFM3=on pi
```

or `~/.pi/agent/lfm3.json`:

```json
{
  "enabled": true,
  "baseUrl": "http://127.0.0.1:18181",
  "d1Url": "http://127.0.0.1:18182",
  "tool": true
}
```

`/lfm3 on` and `/lfm3 off` switch the provider for the current session; the config file and
environment are the durable switch. To remove the extension entirely, use `pi config` or
`"-extensions/lfm3/index.ts"` in the package filter.

| setting | env | default | |
|---|---|---|---|
| `enabled` | `PI_LFM3` | `false` | register the provider and tool |
| `baseUrl` | `PI_LFM3_URL` | `http://127.0.0.1:18181` | LFM3-1.7B server root |
| `d1Url` | `PI_LFM3_D1_URL` | `http://127.0.0.1:18182` | d1-2B server root |
| `tool` | `PI_LFM3_TOOL` | `true` | offer `lfm3_decide` when enabled |
| `timeoutMs` | `PI_LFM3_TIMEOUT_MS` | `15000` | classify timeout |
| — | `PI_LFM3_CONFIG` | `~/.pi/agent/lfm3.json` | config file |

The registered models are `lfm3/lfm3-1.7b` (chat) and the classifier `lfm3/d1-2b`. A classifier
does not appear in `/model`; reach it from a codemode script:

```js
const d1 = await models.getModelOfType("classifier", "lfm3", "d1-2b");
const out = await models.classify(d1, {
  state: { terminal: lastLines },
  questions: {
    stuck: { type: "bool", instructions: "Is the agent repeating the same failing command?" },
    team: { type: "choice", instructions: "Which team?", criteria: { billing: "Charges", technical: "App faults" } },
  },
});
return out.answers;
```

## The tool

`lfm3_decide` takes one `state` (the text to judge, passed as data) and up to six questions:

```json
{
  "state": "The fallback is never tested; the only test uses a fake that always succeeds.",
  "questions": [
    { "id": "blocking", "type": "bool", "instructions": "Must this be fixed before merging?" },
    { "id": "kind", "type": "choice", "instructions": "What kind of finding is it?", "options": ["blocking", "nit", "question"] }
  ]
}
```

It answers with the probability or the chosen label:

```text
lfm3/d1-2b (312 ms)
blocking: yes (0.96)
kind: blocking (0.93; nit 0.05, question 0.02)
```

If the server is down, disabled, or returns an error, the tool says so and tells the agent to use
its own judgement. It never throws and never blocks a turn. The fallback is the current path: the
agent decides without the tool.

## POC numbers

Measured 2026-10-27/28 on a 12-thread x86-64 CPU, no GPU, llama.cpp `d05706b4f3` (2026-10-27),
LFM3-1.7B-QAD-Q4_0 and d1-2B-Q8_0. The criteria were written before the runs; they are in
[bench/GATE.md](bench/GATE.md), the raw rows in `bench/results/`.

| use case | result | verdict |
|---|---|---|
| d1-2B classification, 40 labelled cases, through headless `pi -p --mode json` and pi's classifier registry | **40/40** (the 3-question stuck set) | **pass** |
| same, one generic stuck question | 37/40; the three misses were repeated failing output and a waiting question | context |
| d1 latency | median **454 ms**, p90 924 ms for the 3-question stuck set; 267-475 ms for one question | pass |
| d1 footprint | 1.85 GiB Q8 file, **1.95 GB RSS**, 32K context | pass |
| LFM3-1.7B Watcher prompt, 16 realistic screens | JSON 15/16, `n` 1/16, status line 13/16, progress 1/16; median 2.0 s, p90 2.3 s | **fail** |
| LFM3-1.7B titles, 8 tasks | 3/8 clean; one paragraph, two `</think>` leaks, several over 8 words | **fail** |
| LFM3-1.7B chat footprint | 1001 MiB QAD Q4_0 file, 2.27 GB RSS at 16K context | — |
| LFM3-1.7B thinking | about 8 tokens/s on CPU; one medium-thinking Watcher case produced 1,710 tokens in 194 s | avoid by default |

The rule baseline in the same 40 classification cases scores 39/40, but those rules were written
against the same cases, so that is an upper bound, not a general baseline. The model's advantage is
that no rules are needed for a new label set. No cloud model was called: the task's rules forbid
real provider authorisation, so there is no model-vs-model number here.

Against the gate in [bench/GATE.md](bench/GATE.md): classification passes on accuracy, latency and
footprint; the Watcher and titling fail on quality. So the integration is the d1 classifier and its
tool, not the Watcher or a title generator.

### Reproduce

With both servers up:

```bash
node extensions/lfm3/bench/classify.ts   # 40 classification cases via headless pi
node extensions/lfm3/bench/watcher.ts    # 16 Watcher prompts via headless pi
```

Both use the `pi` in `node_modules/.bin`, an empty temporary agent directory, and the extension in
this checkout; neither touches the real config. They write raw JSONL rows to `bench/results/`.

## Limits

- Text only here. llama.cpp's d1 support answers `noul`, `choice` and `score`; multi-select,
  extraction with spans, estimates and boxes are not wired. Images are not exposed by this
  extension, though d1 and LFM3-VL take them.
- The state is passed as data, but a small model can still follow instructions inside it. Treat a
  decision as evidence, not as a permission check.
- The chat model's context is registered as 16K to match the documented server command; the model
  itself supports 256K. Longer context needs a bigger `-c` and more RAM (about 1.6 GB of KV cache at
  128K, per Liquid).
- LFM3-1.7B is not trained for agentic coding or hard multi-step reasoning. Use it for short,
  single-step jobs and keep the big model for the task itself.
