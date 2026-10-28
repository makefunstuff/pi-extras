// Thin, typed wrappers over the herdr CLI. Everything returns plain JSON values so codemode
// scripts can work with them; no command ever goes through a shell.
import type { HerdrConfig } from "./config.ts";
import { AGENT_STATUSES, READ_SOURCES } from "./constants.ts";
import { ToolError } from "./errors.ts";
import { parseJson, type CommandResult, type CommandRunner, type RunOptions } from "./exec.ts";

export { AGENT_STATUSES, READ_SOURCES };

export type AgentStatus = (typeof AGENT_STATUSES)[number];
export type ReadSource = (typeof READ_SOURCES)[number];

export interface AgentSummary {
	name?: string;
	agent?: string;
	status: string;
	title?: string;
	display?: string;
	cwd?: string;
	paneId: string;
	tabId?: string;
	workspaceId?: string;
	terminalId?: string;
	session?: string;
	focused: boolean;
	tokens?: unknown;
}

export interface WorkspaceSummary {
	id: string;
	label?: string;
	number?: number;
	activeTabId?: string;
	agentStatus?: string;
	focused: boolean;
	paneCount?: number;
	tabCount?: number;
	worktree?: unknown;
}

export interface PaneSummary {
	id: string;
	workspaceId?: string;
	tabId?: string;
	agent?: string;
	agentStatus?: string;
	title?: string;
	cwd?: string;
	focused: boolean;
	terminalId?: string;
	terminalTitle?: string;
	tokens?: unknown;
}

export interface TabSummary {
	id: string;
	workspaceId?: string;
	title?: string;
	number?: number;
	focused?: boolean;
}

interface RawRecord {
	[key: string]: unknown;
}

const record = (value: unknown): RawRecord => (value && typeof value === "object" && !Array.isArray(value) ? (value as RawRecord) : {});
const str = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const bool = (value: unknown): boolean => value === true;

/** Drop undefined fields so a JSON result does not carry keys with no value. */
function compact<T extends Record<string, unknown>>(value: T): T {
	for (const key of Object.keys(value)) if (value[key] === undefined) delete value[key];
	return value;
}

function runOptions(config: HerdrConfig, options: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {}): RunOptions {
	return {
		timeoutMs: config.timeoutMs,
		maxOutput: config.maxOutput,
		cwd: options.cwd,
		env: options.env,
		signal: options.signal,
	};
}

function herdrFailure(config: HerdrConfig, result: CommandResult): never {
	if (result.error) throw new ToolError("herdr_unavailable", `could not run ${config.herdrBin}: ${result.error}`);
	if (result.timedOut) throw new ToolError("herdr_timeout", `${config.herdrBin} timed out after ${config.timeoutMs} ms`);
	if (result.aborted) throw new ToolError("aborted", "the call was aborted");
	throw new ToolError("herdr_failed", result.stderr.trim() || `${config.herdrBin} exited with ${result.code}`);
}

/** Run a herdr command and unwrap its {"id","result"} envelope. Throws ToolError on failure. */
export async function herdrJson(
	config: HerdrConfig,
	run: CommandRunner,
	args: string[],
	options: { signal?: AbortSignal } = {},
): Promise<unknown> {
	const result = await run(config.herdrBin, args, runOptions(config, options));
	const parsed = parseJson(result.stdout);
	if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
		const envelope = parsed as RawRecord;
		const error = record(envelope.error);
		if (envelope.error) {
			throw new ToolError(str(error.code) ?? "herdr_error", str(error.message) ?? JSON.stringify(envelope.error), envelope.error);
		}
		if ("result" in envelope) return envelope.result;
	}
	if (result.code !== 0) herdrFailure(config, result);
	if (parsed !== undefined) return parsed;
	return result.stdout.trim();
}

/** Run a herdr command whose useful output is text (agent read, pane read). */
export async function herdrText(
	config: HerdrConfig,
	run: CommandRunner,
	args: string[],
	options: { signal?: AbortSignal } = {},
): Promise<string> {
	const result = await run(config.herdrBin, args, runOptions(config, options));
	const parsed = parseJson(result.stdout);
	if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
		const envelope = parsed as RawRecord;
		const error = record(envelope.error);
		if (envelope.error) throw new ToolError(str(error.code) ?? "herdr_error", str(error.message) ?? JSON.stringify(envelope.error));
		if (typeof envelope.result === "string") return envelope.result;
	}
	if (result.code !== 0) herdrFailure(config, result);
	return result.stdout;
}

export function asAgent(value: unknown): AgentSummary {
	const raw = record(value);
	const session = record(raw.agent_session);
	return compact({
		name: str(raw.name),
		agent: str(raw.agent),
		status: str(raw.agent_status) ?? "unknown",
		title: str(raw.title),
		display: str(raw.display_agent),
		cwd: str(raw.foreground_cwd) ?? str(raw.cwd),
		paneId: str(raw.pane_id) ?? "",
		tabId: str(raw.tab_id),
		workspaceId: str(raw.workspace_id),
		terminalId: str(raw.terminal_id),
		session: str(session.value),
		focused: bool(raw.focused),
		tokens: raw.tokens,
	});
}

export function asWorkspace(value: unknown): WorkspaceSummary {
	const raw = record(value);
	return compact({
		id: str(raw.workspace_id) ?? str(raw.id) ?? "",
		label: str(raw.label),
		number: num(raw.number),
		activeTabId: str(raw.active_tab_id),
		agentStatus: str(raw.agent_status),
		focused: bool(raw.focused),
		paneCount: num(raw.pane_count),
		tabCount: num(raw.tab_count),
		worktree: raw.worktree,
	});
}

export function asPane(value: unknown): PaneSummary {
	const raw = record(value);
	return compact({
		id: str(raw.pane_id) ?? str(raw.id) ?? "",
		workspaceId: str(raw.workspace_id),
		tabId: str(raw.tab_id),
		agent: str(raw.agent),
		agentStatus: str(raw.agent_status),
		title: str(raw.title),
		cwd: str(raw.foreground_cwd) ?? str(raw.cwd),
		focused: bool(raw.focused),
		terminalId: str(raw.terminal_id),
		terminalTitle: str(raw.terminal_title),
		tokens: raw.tokens,
	});
}

export function asTab(value: unknown): TabSummary {
	const raw = record(value);
	return compact({
		id: str(raw.tab_id) ?? str(raw.id) ?? "",
		workspaceId: str(raw.workspace_id),
		title: str(raw.title) ?? str(raw.label),
		number: num(raw.number),
		focused: typeof raw.focused === "boolean" ? raw.focused : undefined,
	});
}

function arrayAt(value: unknown, key: string): unknown[] {
	const raw = record(value);
	return Array.isArray(raw[key]) ? (raw[key] as unknown[]) : Array.isArray(value) ? value : [];
}

export interface AgentFilter {
	status?: string;
	workspace?: string;
	query?: string;
}

export async function listAgents(
	config: HerdrConfig,
	run: CommandRunner,
	filter: AgentFilter = {},
	options: { signal?: AbortSignal } = {},
): Promise<AgentSummary[]> {
	const result = await herdrJson(config, run, ["agent", "list"], options);
	const agents = arrayAt(result, "agents").map(asAgent);
	const q = filter.query?.toLowerCase();
	return agents.filter(
		(agent) =>
			(!filter.status || agent.status === filter.status) &&
			(!filter.workspace || agent.workspaceId === filter.workspace) &&
			(!q ||
				[agent.name, agent.agent, agent.title, agent.display, agent.cwd, agent.paneId, agent.session]
					.filter(Boolean)
					.some((field) => String(field).toLowerCase().includes(q))),
	);
}

export interface ReadOptions {
	lines?: number;
	source?: ReadSource;
	signal?: AbortSignal;
}

export async function readAgent(
	config: HerdrConfig,
	run: CommandRunner,
	target: string,
	options: ReadOptions = {},
): Promise<{ target: string; text: string; lines: number; source: ReadSource }> {
	const source = options.source ?? "recent";
	const lines = options.lines ?? 80;
	const text = await herdrText(
		config,
		run,
		["agent", "read", target, "--source", source, "--lines", String(lines)],
		{ signal: options.signal },
	);
	return { target, text, lines, source };
}

export async function listWorkspaces(
	config: HerdrConfig,
	run: CommandRunner,
	options: { signal?: AbortSignal } = {},
): Promise<WorkspaceSummary[]> {
	const result = await herdrJson(config, run, ["workspace", "list"], options);
	return arrayAt(result, "workspaces").map(asWorkspace);
}

export async function listPanes(
	config: HerdrConfig,
	run: CommandRunner,
	filter: { workspace?: string } = {},
	options: { signal?: AbortSignal } = {},
): Promise<PaneSummary[]> {
	const args = ["pane", "list"];
	if (filter.workspace) args.push("--workspace", filter.workspace);
	const result = await herdrJson(config, run, args, options);
	return arrayAt(result, "panes").map(asPane);
}

export async function listTabs(
	config: HerdrConfig,
	run: CommandRunner,
	filter: { workspace?: string } = {},
	options: { signal?: AbortSignal } = {},
): Promise<TabSummary[]> {
	const args = ["tab", "list"];
	if (filter.workspace) args.push("--workspace", filter.workspace);
	const result = await herdrJson(config, run, args, options);
	return arrayAt(result, "tabs").map(asTab);
}

export async function readPane(
	config: HerdrConfig,
	run: CommandRunner,
	paneId: string,
	options: ReadOptions = {},
): Promise<{ paneId: string; text: string; lines: number; source: ReadSource }> {
	const source = options.source ?? "recent";
	const lines = options.lines ?? 80;
	const text = await herdrText(
		config,
		run,
		["pane", "read", paneId, "--source", source, "--lines", String(lines)],
		{ signal: options.signal },
	);
	return { paneId, text, lines, source };
}

export interface PromptOptions {
	wait?: boolean;
	until?: string[];
	timeoutMs?: number;
	signal?: AbortSignal;
}

export async function promptAgent(
	config: HerdrConfig,
	run: CommandRunner,
	target: string,
	text: string,
	options: PromptOptions = {},
): Promise<{ target: string; result: unknown }> {
	const args = ["agent", "prompt", target, text];
	if (options.wait) args.push("--wait");
	for (const state of options.until ?? []) args.push("--until", state);
	if (options.timeoutMs !== undefined) args.push("--timeout", String(options.timeoutMs));
	const result = await herdrJson(config, run, args, { signal: options.signal });
	return { target, result };
}
