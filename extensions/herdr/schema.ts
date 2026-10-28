// The TypeBox schemas the tools use for parameters and structured results. Keeping them here makes
// the codemode declarations (and the tests that check them) one short file to read.
import { Type } from "@earendil-works/pi-ai";
import { AGENT_STATUSES, READ_SOURCES, REPORT_STATES, BLOCKED_KINDS } from "./constants.ts";

export const agentSchema = Type.Object({
	name: Type.Optional(Type.String({ description: "herdr agent name, when it has one" })),
	agent: Type.Optional(Type.String({ description: "Program: pi, claude, codex, …" })),
	status: Type.String({ description: "idle, working, blocked, done or unknown" }),
	title: Type.Optional(Type.String()),
	display: Type.Optional(Type.String({ description: "The agent's one-line status line" })),
	cwd: Type.Optional(Type.String()),
	paneId: Type.String(),
	tabId: Type.Optional(Type.String()),
	workspaceId: Type.Optional(Type.String()),
	terminalId: Type.Optional(Type.String()),
	session: Type.Optional(Type.String({ description: "Agent session id or transcript path" })),
	focused: Type.Boolean(),
	tokens: Type.Optional(Type.Any()),
});

export const workspaceSchema = Type.Object({
	id: Type.String(),
	label: Type.Optional(Type.String()),
	number: Type.Optional(Type.Number()),
	activeTabId: Type.Optional(Type.String()),
	agentStatus: Type.Optional(Type.String()),
	focused: Type.Boolean(),
	paneCount: Type.Optional(Type.Number()),
	tabCount: Type.Optional(Type.Number()),
	worktree: Type.Optional(Type.Any()),
});

export const paneSchema = Type.Object({
	id: Type.String(),
	workspaceId: Type.Optional(Type.String()),
	tabId: Type.Optional(Type.String()),
	agent: Type.Optional(Type.String()),
	agentStatus: Type.Optional(Type.String()),
	title: Type.Optional(Type.String()),
	cwd: Type.Optional(Type.String()),
	focused: Type.Boolean(),
	terminalId: Type.Optional(Type.String()),
	terminalTitle: Type.Optional(Type.String()),
	tokens: Type.Optional(Type.Any()),
});

export const tabSchema = Type.Object({
	id: Type.String(),
	workspaceId: Type.Optional(Type.String()),
	title: Type.Optional(Type.String()),
	number: Type.Optional(Type.Number()),
	focused: Type.Optional(Type.Boolean()),
});

export const agentsResultSchema = Type.Object({
	agents: Type.Array(agentSchema),
	count: Type.Number(),
});

export const workspacesResultSchema = Type.Object({
	workspaces: Type.Array(workspaceSchema),
	count: Type.Number(),
});

export const panesResultSchema = Type.Object({
	panes: Type.Array(paneSchema),
	count: Type.Number(),
});

export const tabsResultSchema = Type.Object({
	tabs: Type.Array(tabSchema),
	count: Type.Number(),
});

export const readResultSchema = Type.Object({
	target: Type.String(),
	text: Type.String(),
	lines: Type.Number(),
	source: Type.String(),
});

export const paneReadResultSchema = Type.Object({
	paneId: Type.String(),
	text: Type.String(),
	lines: Type.Number(),
	source: Type.String(),
});

export const promptResultSchema = Type.Object({
	target: Type.String(),
	result: Type.Any({ description: "herdr's JSON result for the submission" }),
});

export const taskSchema = Type.Object({
	id: Type.String(),
	state: Type.Optional(Type.String({ description: "idle, working, blocked, done or error" })),
	app: Type.Optional(Type.String({ description: "Who is on it: pi, claude, the human's name, …" })),
	title: Type.Optional(Type.String()),
	msg: Type.Optional(Type.String()),
	stage: Type.Optional(Type.String()),
	progress: Type.Optional(Type.Number()),
	pr: Type.Optional(Type.String()),
	research: Type.Optional(Type.Boolean()),
	review: Type.Optional(Type.Any()),
	report: Type.Optional(Type.Any()),
});

export const boardListResultSchema = Type.Object({
	tasks: Type.Array(taskSchema),
	count: Type.Number(),
});

export const boardDetailsResultSchema = Type.Object({
	task: taskSchema,
	failure: Type.Optional(Type.Any()),
	review: Type.Optional(Type.Any()),
	reviews: Type.Optional(Type.Array(Type.Any())),
	agent: Type.Optional(Type.Any()),
	handovers: Type.Optional(Type.Array(Type.Any())),
	research: Type.Optional(Type.Boolean()),
	report: Type.Optional(Type.Any()),
	plan: Type.Optional(Type.Any()),
	pr: Type.Optional(Type.Any()),
	worktree: Type.Optional(Type.Any()),
	branch: Type.Optional(Type.Any()),
	limits: Type.Optional(Type.Any()),
});

export const settingSchema = Type.Object({
	name: Type.String(),
	value: Type.Any(),
	kind: Type.Optional(Type.String()),
	from: Type.Optional(Type.String()),
	place: Type.Optional(Type.String()),
	own: Type.Optional(Type.Boolean()),
	note: Type.Optional(Type.String()),
});

export const boardShowResultSchema = Type.Object({
	settings: Type.Array(settingSchema),
});

export const boardTaskResultSchema = Type.Object({
	ok: Type.Boolean({ description: "true when the board accepted the change" }),
	task: taskSchema,
});

export const stuckResultSchema = Type.Object({
	target: Type.String(),
	name: Type.Optional(Type.String()),
	status: Type.String(),
	stuck: Type.Union([Type.Boolean(), Type.Null()], { description: "true, false, or null when the status is unknown" }),
	waiting: Type.Union([Type.Boolean(), Type.Null()], {
		description: "an unanswered question, permission or approval is on screen",
	}),
	source: Type.Union([Type.Literal("classifier"), Type.Literal("status")]),
	model: Type.Optional(Type.String()),
	confidence: Type.Optional(Type.Number()),
	reason: Type.String(),
	recentOutput: Type.Optional(Type.String()),
});

export function statusSchema() {
	return Type.Union(AGENT_STATUSES.map((s) => Type.Literal(s)));
}

export function sourceSchema() {
	return Type.Union(READ_SOURCES.map((s) => Type.Literal(s)));
}

export function reportStateSchema() {
	return Type.Union(REPORT_STATES.map((s) => Type.Literal(s)));
}

export function blockedKindSchema() {
	return Type.Union(BLOCKED_KINDS.map((s) => Type.Literal(s)));
}
