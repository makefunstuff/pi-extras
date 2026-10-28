// Wrappers over the herdr-projects board command. Read commands are always available; the write
// commands are gated by the extension (see index.ts) before they get here.
import type { HerdrConfig } from "./config.ts";
import { BLOCKED_KINDS, REPORT_STATES } from "./constants.ts";
import { ToolError } from "./errors.ts";
import { parseJson, type CommandResult, type CommandRunner, type RunOptions } from "./exec.ts";

export { BLOCKED_KINDS, REPORT_STATES };

interface RawRecord {
	[key: string]: unknown;
}

const RECORD = (value: unknown): RawRecord => (value && typeof value === "object" && !Array.isArray(value) ? (value as RawRecord) : {});

function boardBin(config: HerdrConfig): string {
	if (config.boardBin) return config.boardBin;
	throw new ToolError(
		"board_not_found",
		"the herdr-projects board command was not found; set PI_HERDR_PROJECTS_BIN, or put herdr-projects on PATH",
	);
}

function optionsOf(config: HerdrConfig, signal?: AbortSignal): RunOptions {
	return {
		timeoutMs: config.timeoutMs,
		maxOutput: config.maxOutput,
		signal,
		env: config.boardDataDir ? { HERDR_PROJECTS_DATA_DIR: config.boardDataDir } : undefined,
	};
}

function boardFailure(result: CommandResult, bin: string): never {
	if (result.error) throw new ToolError("board_unavailable", `could not run ${bin}: ${result.error}`);
	if (result.timedOut) throw new ToolError("board_timeout", `${bin} timed out after its time limit`);
	if (result.aborted) throw new ToolError("aborted", "the call was aborted");
	const text = (result.stderr.trim() || result.stdout.trim()).slice(0, 2_000);
	throw new ToolError("board_failed", text || `${bin} exited with ${result.code}`);
}

async function boardJson(
	config: HerdrConfig,
	run: CommandRunner,
	args: string[],
	signal?: AbortSignal,
): Promise<unknown> {
	const bin = boardBin(config);
	// --json must come before a -- terminator; after it the board would treat it as text.
	const separator = args.indexOf("--");
	const withJson = separator < 0 ? [...args, "--json"] : [...args.slice(0, separator), "--json", ...args.slice(separator)];
	const result = await run(bin, withJson, optionsOf(config, signal));
	const parsed = parseJson(result.stdout);
	if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
		const raw = parsed as RawRecord;
		if (raw.error) {
			const error = RECORD(raw.error);
			throw new ToolError(
				typeof error.code === "string" ? error.code : "board_error",
				typeof error.message === "string" ? error.message : JSON.stringify(raw.error),
			);
		}
	}
	if (result.code !== 0) boardFailure(result, bin);
	if (parsed === undefined) {
		throw new ToolError("board_bad_output", `${bin} did not return JSON: ${result.stdout.slice(0, 500)}`);
	}
	return parsed;
}

export interface BoardListOptions {
	archived?: boolean;
	all?: boolean;
	query?: string;
	signal?: AbortSignal;
}

export async function boardList(
	config: HerdrConfig,
	run: CommandRunner,
	options: BoardListOptions = {},
): Promise<unknown[]> {
	const args = ["list"];
	if (options.archived) args.push("--archived");
	if (options.all) args.push("--all");
	if (options.query) args.push(`--query=${options.query}`);
	const result = await boardJson(config, run, args, options.signal);
	if (!Array.isArray(result)) throw new ToolError("board_bad_output", "the board's list output was not an array");
	return result;
}

export async function boardDetails(
	config: HerdrConfig,
	run: CommandRunner,
	id: string,
	signal?: AbortSignal,
): Promise<Record<string, unknown>> {
	return RECORD(await boardJson(config, run, ["details", "--", id], signal));
}

export async function boardShow(
	config: HerdrConfig,
	run: CommandRunner,
	id?: string,
	signal?: AbortSignal,
): Promise<Record<string, unknown>> {
	return RECORD(await boardJson(config, run, id ? ["show", "--", id] : ["show"], signal));
}

export interface BoardAddOptions {
	description?: string;
	repo?: string;
	delegate?: boolean;
	after?: string[];
	research?: boolean;
	signal?: AbortSignal;
}

export async function boardAdd(
	config: HerdrConfig,
	run: CommandRunner,
	title: string,
	options: BoardAddOptions = {},
): Promise<Record<string, unknown>> {
	const args = ["add"];
	if (options.description !== undefined) args.push(`--desc=${options.description}`);
	if (options.repo !== undefined) args.push(`--repo=${options.repo}`);
	if (options.delegate) args.push("--delegate");
	if (options.after?.length) args.push(`--after=${options.after.join(",")}`);
	if (options.research === true) args.push("--research");
	if (options.research === false) args.push("--no-research");
	// The title is free text and may start with "--"; the board accepts options before "--".
	args.push("--", title);
	return RECORD(await boardJson(config, run, args, options.signal));
}

export async function boardTell(
	config: HerdrConfig,
	run: CommandRunner,
	id: string,
	text: string,
	signal?: AbortSignal,
): Promise<Record<string, unknown>> {
	return RECORD(await boardJson(config, run, ["tell", "--", id, text], signal));
}

export interface BoardReportOptions {
	state: (typeof REPORT_STATES)[number];
	kind?: (typeof BLOCKED_KINDS)[number];
	msg?: string;
	title?: string;
	progress?: number;
	eta?: number;
	signal?: AbortSignal;
}

export async function boardReport(
	config: HerdrConfig,
	run: CommandRunner,
	id: string,
	options: BoardReportOptions,
): Promise<Record<string, unknown>> {
	const args = ["report", "--state", options.state];
	if (options.kind) args.push("--kind", options.kind);
	if (options.msg !== undefined) args.push(`--msg=${options.msg}`);
	if (options.title !== undefined) args.push(`--title=${options.title}`);
	if (options.progress !== undefined) args.push("--progress", String(Math.max(0, Math.min(100, Math.round(options.progress)))));
	if (options.eta !== undefined) args.push("--eta", String(Math.max(0, Math.round(options.eta))));
	args.push("--", id);
	return RECORD(await boardJson(config, run, args, options.signal));
}
