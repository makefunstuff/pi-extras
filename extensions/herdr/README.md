# herdr

Herdr and the herdr-projects work board as pi tools, made to be called by agents and by
**codemode** scripts. Every tool returns JSON, has a TypeBox parameter and result schema, and sits
in one `herdr` namespace so `searchTools()` and `describeTool()` can find it.

The extension is read-only by default. Prompting another agent, adding or telling a board task, and
reporting a task's state are write tools: they stay off unless `PI_HERDR_WRITES=on`, and each call
must also pass `confirm: true`.

## Tools

| tool | kind | what it does |
|---|---|---|
| `herdr_agent_list` | read | agents with status, title, pane, tab, workspace, cwd and session; filter by `status`, `workspace` or `query` |
| `herdr_agent_read` | read | one agent's recent terminal output as text |
| `herdr_agent_stuck` | read | is this agent stuck, or waiting on a question / permission / approval? Classifier when one is registered, otherwise plain herdr status |
| `herdr_workspace_list` | read | workspaces, their active tab, agent status and counts |
| `herdr_pane_list` | read | panes, optionally for one workspace |
| `herdr_pane_read` | read | a pane's recent terminal output as text |
| `herdr_tab_list` | read | tabs, optionally for one workspace |
| `herdr_board_list` | read | board tasks: id, state, who is on it, title, message, stage, progress |
| `herdr_board_details` | read | one task in full: failure, reviews, agent, handovers, plan, PR, worktree, limits |
| `herdr_board_show` | read | board settings and where each value came from |
| `herdr_agent_prompt` | **write** | submit a prompt to another agent, optionally wait for a state |
| `herdr_board_add` | **write** | add a task; adding starts nothing unless `delegate: true` |
| `herdr_board_tell` | **write** | send a message to a task's agent (starts one when there is none) |
| `herdr_board_report` | **write** | report a task's state, kind, message, progress and ETA |

The read tools call the herdr CLI (`herdr agent list|read`, `workspace list`, `pane list|read`,
`tab list`) and the board's JSON output (`herdr-projects list|details|show`). Nothing goes through a
shell: arguments are passed as an array. Board titles, messages and query values are placed after
`--`, or after `--name=` for option values, so text that starts with `--` is data. herdr 0.9.5 has
no `--` terminator for `agent prompt` text, so a prompt that would start with `--` is sent with one
leading space, which keeps it a positional; the rest of the text is unchanged.

## Codemode

With the default exposure (`codemode`) the tools are callable from a codemode script and listed in
the `codemode` description. `searchTools("herdr agents")` or `describeTool("herdr_agent_list")`
finds them; the declarations are generated from the TypeBox schemas.

```js
// every blocked agent, and what it is waiting for
const { agents } = await tools.herdr_agent_list({ status: "blocked" });
const answers = await Promise.all(
  agents.map((a) => tools.herdr_agent_stuck({ target: a.name ?? a.paneId })),
);
return answers.map((a, i) => ({ agent: agents[i].name, stuck: a.stuck, waiting: a.waiting, source: a.source }));

// a task and its last review
const details = await tools.herdr_board_details({ id: "my-repo/12" });
text(details.task);
console.log(details.review?.text);
```

A write, when the user has explicitly allowed writes and asked for the change:

```js
await tools.herdr_board_report({
  id: "my-repo/12",
  state: "blocked",
  kind: "question",
  msg: "Need a GitHub login to open the PR",
  confirm: true,
});
```

A failed call throws, so a codemode script sees a rejected promise with a message that starts
with its code, for example `writes_disabled: …`, `confirmation_required: …` or
`agent_not_found: …`. Use `try`/`catch` or `Promise.allSettled()` when a call may fail.

`herdr_agent_prompt` with `wait: true` is allowed to run until herdr's own `--timeout` (the
`timeoutMs` argument) expires. The extension's process timeout is always longer than that, and
with no `timeoutMs` the wait defaults to 30 minutes, so a delivered prompt is not killed by the
normal 20-second CLI limit.

## Stuck / waiting helper

`herdr_agent_stuck` reads the agent's status and recent output and asks a classifier two yes/no
questions: is it stuck, and is an unanswered prompt on screen. When HRN-15's `lfm3` extension is
loaded it registers `lfm3/d1-2b`, which is the default. Nothing is imported from that extension:
the model is looked up in pi's model registry, so this works only when it is actually registered.
When the model is off, not installed, or its local server is down, the tool returns the plain
herdr status (`source: "status"`) and says why in `reason`. `blocked` means stuck and waiting;
`working`, `idle` and `done` mean not stuck; `unknown` means `null`.

Set `PI_HERDR_STUCK_MODEL=provider/model` for another classifier, or `PI_HERDR_STUCK_MODEL=off` to
disable classification entirely.

## Configuration

| setting | env | default |
|---|---|---|
| herdr CLI | `PI_HERDR_BIN`, `HERDR_BIN` | `herdr` from `PATH` |
| board command | `PI_HERDR_PROJECTS_BIN`, `HERDR_PROJECTS_BIN` | `herdr-projects` from `PATH`, then `$HERDR_PROJECTS_DATA_DIR/bin/herdr-projects`, then `~/.herdr-projects/data/bin/herdr-projects` |
| board data folder | `PI_HERDR_PROJECTS_DATA_DIR`, `HERDR_PROJECTS_DATA_DIR` | none (the board command's own default) |
| allow writes | `PI_HERDR_WRITES` (also `PI_HERDR_ALLOW_WRITES`) | `off`; `on`, `1`, `true`, `yes`, `all` enable |
| exposure | `PI_HERDR_EXPOSURE` | `codemode`; also `direct`, `model-only`, `deferred`, `hidden` |
| stuck classifier | `PI_HERDR_STUCK_MODEL` | `lfm3/d1-2b`; `off` disables |
| CLI timeout | `PI_HERDR_TIMEOUT_MS` | `20000` |
| max CLI output | `PI_HERDR_MAX_OUTPUT` | `1000000` characters |

With `PI_HERDR_EXPOSURE=direct` the tools are declared to the model like any other tool as well as
being callable from codemode. The default `codemode` keeps them out of the direct tool list.

Nothing personal is committed: the code uses `homedir()`, `PATH`, and the variables above. There is
no board URL, socket path, hostname, key or fixed personal directory in the source.

## Tests

The unit tests use fake command runners and a fake model registry; they never start a herdr daemon
or touch a real board. The repository check runs them through `test/run-unit.mjs`.

```bash
node --test extensions/herdr/*.test.ts
```
