// LFM3 settings, free of pi so the unit tests can call them: the switch, where the two local
// servers listen, and whether the classification tool is offered.
//
// Off by default. Nothing is registered and no request is made until PI_LFM3=on (or the config
// file says enabled). The current path — the selected model, and the agent's own judgement for a
// classification — stays as it is.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Lfm3Config {
	/** Master switch: register the provider and the tool. */
	enabled: boolean;
	/** Root URL of the LFM3-1.7B llama-server (no /v1). */
	baseUrl: string;
	/** Root URL of the d1-2B llama-server (no /v1). */
	d1Url: string;
	/** Offer the lfm3_decide tool to the model. */
	tool: boolean;
	/** Per-request timeout for classification and health checks. */
	timeoutMs: number;
}

export const DEFAULT_BASE_URL = "http://127.0.0.1:18181";
export const DEFAULT_D1_URL = "http://127.0.0.1:18182";

export const DEFAULTS: Lfm3Config = {
	enabled: false,
	baseUrl: DEFAULT_BASE_URL,
	d1Url: DEFAULT_D1_URL,
	tool: true,
	timeoutMs: 15000,
};

function agentDir(env: NodeJS.ProcessEnv): string {
	const dir = env.PI_CODING_AGENT_DIR;
	if (dir) return dir.startsWith("~/") ? join(homedir(), dir.slice(2)) : dir;
	return join(homedir(), ".pi", "agent");
}

/** Path of the optional config file: <agent dir>/lfm3.json. */
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_LFM3_CONFIG ?? join(agentDir(env), "lfm3.json");
}

const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
const onOff = (v: string | undefined, fallback: boolean) => (v === undefined ? fallback : !/^(0|false|off|no)$/i.test(v));

/** A root URL without a trailing slash; an invalid or non-http value falls back. */
export function normalizeBaseUrl(value: unknown, fallback: string): string {
	const raw = typeof value === "string" ? value.trim() : "";
	if (!raw) return fallback;
	try {
		const url = new URL(raw);
		if (url.protocol !== "http:" && url.protocol !== "https:") return fallback;
		return raw.replace(/\/+$/, "");
	} catch {
		return fallback;
	}
}

/** Defaults, then the config file, then PI_LFM3_* environment variables. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, warn: (m: string) => void = () => {}): Lfm3Config {
	let file: Record<string, unknown> = {};
	const path = configPath(env);
	if (existsSync(path)) {
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) file = parsed;
			else warn(`lfm3: ignoring ${path}: not a JSON object`);
		} catch (e) {
			warn(`lfm3: ignoring ${path}: ${(e as Error).message}`);
		}
	}
	const merged: Record<string, unknown> = { ...file };
	if (env.PI_LFM3 !== undefined) merged.enabled = onOff(env.PI_LFM3, DEFAULTS.enabled);
	if (env.PI_LFM3_URL !== undefined) merged.baseUrl = env.PI_LFM3_URL;
	if (env.PI_LFM3_D1_URL !== undefined) merged.d1Url = env.PI_LFM3_D1_URL;
	if (env.PI_LFM3_TOOL !== undefined) merged.tool = onOff(env.PI_LFM3_TOOL, DEFAULTS.tool);
	if (env.PI_LFM3_TIMEOUT_MS !== undefined && Number.isFinite(Number(env.PI_LFM3_TIMEOUT_MS))) merged.timeoutMs = Number(env.PI_LFM3_TIMEOUT_MS);
	const timeout = Number(merged.timeoutMs);
	return {
		enabled: bool(merged.enabled, DEFAULTS.enabled),
		baseUrl: normalizeBaseUrl(merged.baseUrl, DEFAULTS.baseUrl),
		d1Url: normalizeBaseUrl(merged.d1Url, DEFAULTS.d1Url),
		tool: bool(merged.tool, DEFAULTS.tool),
		timeoutMs: Number.isFinite(timeout) && timeout >= 100 ? timeout : DEFAULTS.timeoutMs,
	};
}
