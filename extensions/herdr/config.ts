// Where the herdr and herdr-projects programs are, and what this extension may do.
//
// Nothing here is personal or baked in: the binaries are found from PI_HERDR_* / HERDR_* variables,
// then PATH, then the board's conventional data folder under the user's home. Writes are off
// unless PI_HERDR_WRITES says otherwise, and a write call also has to pass confirm: true.
import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export type Exposure = "direct" | "model-only" | "codemode" | "deferred" | "hidden";

export interface StuckModel {
	provider: string;
	id: string;
}

export interface HerdrConfig {
	/** The herdr CLI. */
	herdrBin: string;
	/** The herdr-projects board command, when one was found. */
	boardBin?: string;
	/** The board's data folder, when it is known (passed through to the board command). */
	boardDataDir?: string;
	/** Allow state-changing tools at all. Off by default. */
	writes: boolean;
	/** How the tools are exposed to pi. Default: codemode (callable, listed by codemode). */
	exposure: Exposure;
	/** Timeout for one CLI invocation. */
	timeoutMs: number;
	/** The most stdout kept from one CLI invocation. */
	maxOutput: number;
	/** Classifier used by herdr_agent_stuck; absent when disabled or misconfigured. */
	stuckModel?: StuckModel;
}

export interface ConfigOptions {
	exists?: (path: string) => boolean;
	home?: string;
	platform?: NodeJS.Platform;
}

const ON = /^(1|on|true|yes|all)$/i;
const OFF = /^(0|off|false|no|none)$/i;
const EXPOSURES: Exposure[] = ["direct", "model-only", "codemode", "deferred", "hidden"];

function first(...values: Array<string | undefined>): string | undefined {
	return values.map((v) => v?.trim()).find((v) => v);
}

function findOnPath(name: string, env: NodeJS.ProcessEnv, exists: (path: string) => boolean, platform: NodeJS.Platform): string | undefined {
	const exts = platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean) : [""];
	for (const dir of (env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		for (const ext of exts) {
			const candidate = join(dir, name + ext);
			if (exists(candidate)) return candidate;
		}
	}
	return undefined;
}

function number(value: string | undefined, fallback: number, min: number): number {
	const n = Number(value);
	return value !== undefined && value !== "" && Number.isFinite(n) && n >= min ? n : fallback;
}

function parseStuckModel(value: string | undefined): StuckModel | undefined {
	if (value === undefined) return { provider: "lfm3", id: "d1-2b" };
	const raw = value.trim();
	if (!raw || OFF.test(raw)) return undefined;
	const slash = raw.indexOf("/");
	if (slash <= 0 || slash === raw.length - 1) return undefined;
	return { provider: raw.slice(0, slash), id: raw.slice(slash + 1) };
}

/** Read the extension's settings. Env first; discovery is injectable for the tests. */
export function readConfig(env: NodeJS.ProcessEnv = process.env, options: ConfigOptions = {}): HerdrConfig {
	const exists = options.exists ?? existsSync;
	const platform = options.platform ?? process.platform;
	const home = options.home ?? homedir();
	const boardDataDir = first(env.PI_HERDR_PROJECTS_DATA_DIR, env.HERDR_PROJECTS_DATA_DIR);

	const herdrBin =
		first(env.PI_HERDR_BIN, env.HERDR_BIN) ?? findOnPath("herdr", env, exists, platform) ?? "herdr";

	const boardBin =
		first(env.PI_HERDR_PROJECTS_BIN, env.HERDR_PROJECTS_BIN) ??
		findOnPath("herdr-projects", env, exists, platform) ??
		[boardDataDir, join(home, ".herdr-projects", "data")]
			.filter((dir): dir is string => Boolean(dir))
			.map((dir) => join(dir, "bin", "herdr-projects"))
			.find((path) => exists(path));

	const writeSetting = first(env.PI_HERDR_WRITES, env.PI_HERDR_ALLOW_WRITES);
	const writes = writeSetting !== undefined ? ON.test(writeSetting) && !OFF.test(writeSetting) : false;
	const requestedExposure = first(env.PI_HERDR_EXPOSURE)?.toLowerCase();
	const exposure = EXPOSURES.includes(requestedExposure as Exposure) ? (requestedExposure as Exposure) : "codemode";

	return {
		herdrBin,
		boardBin,
		boardDataDir,
		writes,
		exposure,
		timeoutMs: number(env.PI_HERDR_TIMEOUT_MS, 20_000, 100),
		maxOutput: number(env.PI_HERDR_MAX_OUTPUT, 1_000_000, 1_000),
		stuckModel: parseStuckModel(first(env.PI_HERDR_STUCK_MODEL)),
	};
}

/** True when a path is executable, for callers that want to check a configured binary. */
export function isExecutable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
