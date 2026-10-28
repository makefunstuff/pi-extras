// herdr + herdr-projects as pi tools, made to be called from codemode scripts.
//
// Read-only tools are available by default. State-changing tools (prompting an agent, adding or
// telling a board task, reporting a task's state) are off unless PI_HERDR_WRITES=on, and each call
// still has to pass confirm: true. All tools carry a namespace and output schemas, so codemode's
// searchTools/describeTool can find them and the model sees typed signatures.
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { HerdrConfig } from "./config.ts";
import { readConfig } from "./config.ts";
import { ToolError, messageOf } from "./errors.ts";
import type { CommandRunner } from "./exec.ts";
import { runCommand } from "./exec.ts";
import {
	listAgents,
	listPanes,
	listTabs,
	listWorkspaces,
	promptAgent,
	readAgent,
	readPane,
} from "./herdr.ts";
import { boardAdd, boardDetails, boardList, boardReport, boardShow, boardTell } from "./board.ts";
import { agentStuck, type ClassifierRegistryLike } from "./stuck.ts";
import {
	agentsResultSchema,
	boardDetailsResultSchema,
	boardListResultSchema,
	boardShowResultSchema,
	boardTaskResultSchema,
	blockedKindSchema,
	paneReadResultSchema,
	panesResultSchema,
	promptResultSchema,
	readResultSchema,
	reportStateSchema,
	sourceSchema,
	statusSchema,
	stuckResultSchema,
	tabsResultSchema,
	workspacesResultSchema,
} from "./schema.ts";

export const TOOL_NAMES = [
	"herdr_agent_list",
	"herdr_agent_read",
	"herdr_agent_stuck",
	"herdr_workspace_list",
	"herdr_pane_list",
	"herdr_pane_read",
	"herdr_tab_list",
	"herdr_board_list",
	"herdr_board_details",
	"herdr_board_show",
	"herdr_agent_prompt",
	"herdr_board_add",
	"herdr_board_tell",
	"herdr_board_report",
] as const;

const WRITE_TOOLS = new Set(["herdr_agent_prompt", "herdr_board_add", "herdr_board_tell", "herdr_board_report"]);

const NAMESPACE = {
	name: "herdr",
	aliases: ["herdr-projects", "board"],
	description:
		"Inspect herdr agents, workspaces, tabs and panes, and read or change tasks on the herdr-projects work board.",
	instructions: `All results are JSON. Read-only tools run without confirmation. Writes are off
unless the user set PI_HERDR_WRITES=on, and every write also needs confirm: true.

Examples for codemode:

  const agents = await tools.herdr_agent_list({ status: "blocked" });        // blocked agents, JSON
  const { agents } = agents;
  const out = await tools.herdr_agent_read({ target: agents[0].name, lines: 40 });
  const stuck = await tools.herdr_agent_stuck({ target: agents[0].name });
  const tasks = await tools.herdr_board_list({ query: "release" });
  const one = await tools.herdr_board_details({ id: "my-repo/12" });
  await Promise.allSettled(agents.map((a) => tools.herdr_agent_stuck({ target: a.paneId })));

A write looks like:

  await tools.herdr_board_report({ id: "my-repo/12", state: "blocked", kind: "question", msg: "Need a login", confirm: true });

Prefer herdr_agent_stuck over reading a lot of terminal output: it asks the local classifier
(lfm3/d1-2b, when that extension is loaded) and falls back to herdr's status alone.`,
};

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;

const TEXT_LIMIT = 20_000;

function textOf(data: unknown, limit = TEXT_LIMIT): string {
	const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n… the model-facing text was cut at ${limit} characters; a codemode call still receives the full structured result`;
}

function success(data: unknown, details: unknown = data) {
	return {
		content: [{ type: "text" as const, text: textOf(data) }],
		details,
		structuredContent: data as any,
	};
}

function requireWrite(config: HerdrConfig, confirm: boolean | undefined): void {
	if (!config.writes) {
		throw new ToolError(
			"writes_disabled",
			"state-changing herdr tools are off; the user must set PI_HERDR_WRITES=on (or PI_HERDR_ALLOW_WRITES=on) before this can run",
		);
	}
	if (confirm !== true) {
		throw new ToolError(
			"confirmation_required",
			"this call changes state; pass confirm: true as well, so it cannot fire by accident",
		);
	}
}

function tool<T>(fn: (params: T, signal?: AbortSignal, ctx?: ExtensionToolContext) => Promise<unknown>) {
	return async (_toolCallId: string, params: T, signal?: AbortSignal, _onUpdate?: unknown, ctx?: ExtensionToolContext) => {
		try {
			return success(await fn(params, signal, ctx));
		} catch (e) {
			// Throw instead of returning an isError result: pi turns this into a failed tool result,
			// and a codemode script gets a rejected promise it can catch (see README).
			const code = e instanceof ToolError ? e.code : "herdr_failed";
			throw new Error(`${code}: ${messageOf(e)}`);
		}
	};
}

export interface HerdrExtensionOptions {
	config?: HerdrConfig;
	run?: CommandRunner;
}

/** Register the tools. Exported so unit tests can pass a fake runner and config. */
export function registerHerdr(pi: ExtensionAPI, options: HerdrExtensionOptions = {}): void {
	const config = options.config ?? readConfig();
	const run = options.run ?? runCommand;

	const register = (definition: Record<string, unknown> & { name: string }) => {
		pi.registerTool({
			...definition,
			exposure: config.exposure,
			namespace: NAMESPACE,
			annotations: WRITE_TOOLS.has(definition.name) ? WRITE : READ_ONLY,
		} as any);
	};

	register({
		name: "herdr_agent_list",
		label: "herdr agents",
		description:
			"List herdr agents with their status (idle, working, blocked, done, unknown), title, pane, tab, workspace, cwd and session. " +
			"Read-only. Example: tools.herdr_agent_list({ status: 'blocked' }) returns every agent waiting for a human.",
		promptSnippet: "herdr_agent_list: list herdr agents and their status",
		parameters: Type.Object({
			status: Type.Optional(statusSchema()),
			workspace: Type.Optional(Type.String({ description: "Workspace id, e.g. wA" })),
			query: Type.Optional(Type.String({ description: "Match name, program, title, cwd, pane or session" })),
		}),
		outputSchema: agentsResultSchema,
		execute: tool<{ status?: string; workspace?: string; query?: string }>(async (params, signal) => {
			const agents = await listAgents(config, run, params, { signal });
			return { agents, count: agents.length };
		}),
	});

	register({
		name: "herdr_agent_read",
		label: "herdr agent output",
		description:
			"Read the terminal output of one herdr agent (or pane) as plain text. " +
			"Use it to see what the agent last printed; use herdr_agent_stuck first if you only need to know whether it is waiting. " +
			"Read-only. Example: tools.herdr_agent_read({ target: 'sw-repo-12', lines: 60 }).",
		promptSnippet: "herdr_agent_read: read a herdr agent's terminal output",
		parameters: Type.Object({
			target: Type.String({ description: "Agent name or pane id, e.g. sw-repo-12 or wA:p6W" }),
			lines: Type.Optional(Type.Number({ description: "Lines from the recent output (default 80)", minimum: 1, maximum: 2000 })),
			source: Type.Optional(sourceSchema()),
		}),
		outputSchema: readResultSchema,
		execute: tool<{ target: string; lines?: number; source?: any }>(async (params, signal) => readAgent(config, run, params.target, { ...params, signal })),
	});

	register({
		name: "herdr_agent_stuck",
		label: "herdr agent stuck?",
		description:
			"Answer whether an agent is stuck or waiting on a question, permission or approval. " +
			"Uses the local lfm3/d1-2b classifier when that extension is registered, otherwise herdr's status alone; " +
			"the result says which (source: 'classifier' or 'status'). Read-only. " +
			"Example: tools.herdr_agent_stuck({ target: 'sw-repo-12' }) -> { stuck: true, waiting: true, source: 'classifier' }.",
		promptSnippet: "herdr_agent_stuck: is an agent stuck or waiting on a prompt?",
		parameters: Type.Object({
			target: Type.String({ description: "Agent name or pane id" }),
			lines: Type.Optional(Type.Number({ description: "Lines of recent output to judge (default 120)", minimum: 10, maximum: 2000 })),
		}),
		outputSchema: stuckResultSchema,
		execute: tool<{ target: string; lines?: number }>(async (params, signal, ctx) => {
			const registry = (ctx as any)?.modelRegistry as ClassifierRegistryLike | undefined;
			return agentStuck({ config, run, registry }, params.target, { lines: params.lines, signal });
		}),
	});

	register({
		name: "herdr_workspace_list",
		label: "herdr workspaces",
		description:
			"List herdr workspaces: id, label, number, active tab, agent status, pane and tab counts, and the worktree when it has one. " +
			"Read-only. Example: tools.herdr_workspace_list({}) -> { workspaces: [...] }.",
		promptSnippet: "herdr_workspace_list: list herdr workspaces",
		parameters: Type.Object({}),
		outputSchema: workspacesResultSchema,
		execute: tool<Record<string, never>>(async (_params, signal) => {
			const workspaces = await listWorkspaces(config, run, { signal });
			return { workspaces, count: workspaces.length };
		}),
	});

	register({
		name: "herdr_pane_list",
		label: "herdr panes",
		description:
			"List herdr panes with their workspace, tab, agent, status, cwd and title. Read-only. " +
			"Example: tools.herdr_pane_list({ workspace: 'wA' }).",
		promptSnippet: "herdr_pane_list: list herdr panes",
		parameters: Type.Object({
			workspace: Type.Optional(Type.String({ description: "Only panes in this workspace id" })),
		}),
		outputSchema: panesResultSchema,
		execute: tool<{ workspace?: string }>(async (params, signal) => {
			const panes = await listPanes(config, run, params, { signal });
			return { panes, count: panes.length };
		}),
	});

	register({
		name: "herdr_pane_read",
		label: "herdr pane output",
		description:
			"Read a pane's terminal output as plain text, whether or not it runs an agent. Read-only. " +
			"Example: tools.herdr_pane_read({ paneId: 'wA:p6V', lines: 40 }).",
		promptSnippet: "herdr_pane_read: read a herdr pane's output",
		parameters: Type.Object({
			paneId: Type.String({ description: "Pane id, e.g. wA:p6V" }),
			lines: Type.Optional(Type.Number({ description: "Lines from the recent output (default 80)", minimum: 1, maximum: 2000 })),
			source: Type.Optional(sourceSchema()),
		}),
		outputSchema: paneReadResultSchema,
		execute: tool<{ paneId: string; lines?: number; source?: any }>(async (params, signal) => readPane(config, run, params.paneId, { ...params, signal })),
	});

	register({
		name: "herdr_tab_list",
		label: "herdr tabs",
		description:
			"List herdr tabs, optionally for one workspace. Read-only. Example: tools.herdr_tab_list({ workspace: 'wA' }).",
		promptSnippet: "herdr_tab_list: list herdr tabs",
		parameters: Type.Object({
			workspace: Type.Optional(Type.String({ description: "Only tabs in this workspace id" })),
		}),
		outputSchema: tabsResultSchema,
		execute: tool<{ workspace?: string }>(async (params, signal) => {
			const tabs = await listTabs(config, run, params, { signal });
			return { tabs, count: tabs.length };
		}),
	});

	register({
		name: "herdr_board_list",
		label: "herdr board",
		description:
			"List tasks on the herdr-projects work board: id, state, who is on it, title, one-line message, stage and progress. " +
			"Read-only. Example: tools.herdr_board_list({ query: 'release' }) searches titles; { archived: true } includes the archive.",
		promptSnippet: "herdr_board_list: list herdr-projects tasks",
		parameters: Type.Object({
			archived: Type.Optional(Type.Boolean({ description: "Show the archive instead of the live board" })),
			all: Type.Optional(Type.Boolean({ description: "Include archived tasks" })),
			query: Type.Optional(Type.String({ description: "Search text" })),
		}),
		outputSchema: boardListResultSchema,
		execute: tool<{ archived?: boolean; all?: boolean; query?: string }>(async (params, signal) => {
			const tasks = await boardList(config, run, { ...params, signal });
			return { tasks, count: tasks.length };
		}),
	});

	register({
		name: "herdr_board_details",
		label: "herdr task details",
		description:
			"Read one herdr-projects task in full: the task, failure, reviews, agent, handovers, plan, pull request, worktree and limits. " +
			"Read-only. Example: tools.herdr_board_details({ id: 'my-repo/12' }).",
		promptSnippet: "herdr_board_details: read a herdr-projects task in full",
		parameters: Type.Object({
			id: Type.String({ description: "Task id, e.g. my-repo/12" }),
		}),
		outputSchema: boardDetailsResultSchema,
		execute: tool<{ id: string }>(async (params, signal) => boardDetails(config, run, params.id, signal)),
	});

	register({
		name: "herdr_board_show",
		label: "herdr board settings",
		description:
			"Show board settings and where each value came from, for one task or (without an id) for the human. " +
			"Read-only. Example: tools.herdr_board_show({ id: 'my-repo/12' }).",
		promptSnippet: "herdr_board_show: show board settings and their source",
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: "Task id; omit for the human's own settings" })),
		}),
		outputSchema: boardShowResultSchema,
		execute: tool<{ id?: string }>(async (params, signal) => boardShow(config, run, params.id, signal)),
	});

	register({
		name: "herdr_agent_prompt",
		label: "herdr prompt agent (write)",
		description:
			"WRITE: submit a prompt to another herdr agent, optionally waiting for it to reach a state. " +
			"Off unless PI_HERDR_WRITES=on, and requires confirm: true. Do not use it unless the human asked you to talk to that agent. " +
			"A prompt that starts with -- gets one leading space, because herdr would otherwise read it as an option. " +
			"Example: tools.herdr_agent_prompt({ target: 'sw-repo-12', text: 'Please also run the tests', confirm: true }).",
		promptSnippet: "herdr_agent_prompt: submit a prompt to another agent (write, gated)",
		parameters: Type.Object({
			target: Type.String({ description: "Agent name or pane id" }),
			text: Type.String({ description: "The prompt to submit" }),
			wait: Type.Optional(Type.Boolean({ description: "Wait for the agent to reach a state after submission" })),
			until: Type.Optional(Type.Array(statusSchema(), { description: "States to match with wait; default idle, done or blocked", maxItems: 5 })),
			timeoutMs: Type.Optional(Type.Number({ description: "Give up after this many milliseconds", minimum: 0 })),
			confirm: Type.Boolean({ description: "Must be true; confirms you mean to change state" }),
		}),
		outputSchema: promptResultSchema,
		execute: tool<{ target: string; text: string; wait?: boolean; until?: any[]; timeoutMs?: number; confirm?: boolean }>(
			async (params, signal) => {
				requireWrite(config, params.confirm);
				return promptAgent(config, run, params.target, params.text, {
					wait: params.wait,
					until: params.until,
					timeoutMs: params.timeoutMs,
					signal,
				});
			},
		),
	});

	register({
		name: "herdr_board_add",
		label: "herdr add task (write)",
		description:
			"WRITE: add a task to the herdr-projects board. Adding starts nothing unless delegate is true. " +
			"Only when the human asked for the task. Off unless PI_HERDR_WRITES=on, and requires confirm: true. " +
			"Example: tools.herdr_board_add({ title: 'Fix the flaky test', description: '...', confirm: true }).",
		promptSnippet: "herdr_board_add: add a board task (write, gated)",
		parameters: Type.Object({
			title: Type.String({ description: "A short title (the board shortens over 60 characters)" }),
			description: Type.Optional(Type.String({ description: "The full task description" })),
			repo: Type.Optional(Type.String({ description: "Repository name or path; default is the current one" })),
			delegate: Type.Optional(Type.Boolean({ description: "Put an agent on it now" })),
			after: Type.Optional(Type.Array(Type.String(), { description: "Task ids that must be done first" })),
			research: Type.Optional(Type.Boolean({ description: "Research only: change nothing, report instead" })),
			confirm: Type.Boolean({ description: "Must be true; confirms you mean to change state" }),
		}),
		outputSchema: boardTaskResultSchema,
		execute: tool<{
			title: string;
			description?: string;
			repo?: string;
			delegate?: boolean;
			after?: string[];
			research?: boolean;
			confirm?: boolean;
		}>(async (params, signal) => {
			requireWrite(config, params.confirm);
			const task = await boardAdd(config, run, params.title, { ...params, signal });
			return { ok: true, task };
		}),
	});

	register({
		name: "herdr_board_tell",
		label: "herdr tell task (write)",
		description:
			"WRITE: send a message to a task's agent on the herdr-projects board (on a task with no agent, this starts one). " +
			"Off unless PI_HERDR_WRITES=on, and requires confirm: true. " +
			"Example: tools.herdr_board_tell({ id: 'my-repo/12', text: 'The reviewer found one more bug', confirm: true }).",
		promptSnippet: "herdr_board_tell: message a board task's agent (write, gated)",
		parameters: Type.Object({
			id: Type.String({ description: "Task id, e.g. my-repo/12" }),
			text: Type.String({ description: "The message" }),
			confirm: Type.Boolean({ description: "Must be true; confirms you mean to change state" }),
		}),
		outputSchema: boardTaskResultSchema,
		execute: tool<{ id: string; text: string; confirm?: boolean }>(async (params, signal) => {
			requireWrite(config, params.confirm);
			const task = await boardTell(config, run, params.id, params.text, signal);
			return { ok: true, task };
		}),
	});

	register({
		name: "herdr_board_report",
		label: "herdr report task (write)",
		description:
			"WRITE: report where a task stands: state, and for blocked a kind (question, permission, auth) and one-line message. " +
			"Off unless PI_HERDR_WRITES=on, and requires confirm: true. " +
			"Example: tools.herdr_board_report({ id: 'my-repo/12', state: 'blocked', kind: 'question', msg: 'Need a login', confirm: true }).",
		promptSnippet: "herdr_board_report: report a board task's state (write, gated)",
		parameters: Type.Object({
			id: Type.String({ description: "Task id, e.g. my-repo/12" }),
			state: reportStateSchema(),
			kind: Type.Optional(blockedKindSchema()),
			msg: Type.Optional(Type.String({ description: "One line, e.g. 'Waiting for the PR review'" })),
			title: Type.Optional(Type.String({ description: "Rename the task" })),
			progress: Type.Optional(Type.Number({ description: "Percent done, 0-100", minimum: 0, maximum: 100 })),
			eta: Type.Optional(Type.Number({ description: "Minutes left", minimum: 0 })),
			confirm: Type.Boolean({ description: "Must be true; confirms you mean to change state" }),
		}),
		outputSchema: boardTaskResultSchema,
		execute: tool<{
			id: string;
			state: any;
			kind?: any;
			msg?: string;
			title?: string;
			progress?: number;
			eta?: number;
			confirm?: boolean;
		}>(async (params, signal) => {
			requireWrite(config, params.confirm);
			const task = await boardReport(config, run, params.id, { ...params, signal });
			return { ok: true, task };
		}),
	});
}

export default function (pi: ExtensionAPI) {
	registerHerdr(pi);
}
