// The decisions behind codemode-steer, kept free of pi so the unit tests can call them.
//
// The problem this addresses: `codemode` is declared next to read/bash/edit/write, but almost every
// model keeps choosing the direct tools, so a task that could be one script becomes five calls. A
// prompt rule alone did not change that in the probe (DeepSeek Flash still used four bash calls),
// so enforce mode also steers at the call boundary: after a few direct calls it blocks the next
// ones with an error that names codemode and shows the script shape. It gives up after
// `maxBlocks` blocks per prompt, so a model that cannot write a script is never stuck. The default
// is nudge, which appends the same guidance to a tool result and never blocks.

export type SteerMode = "off" | "hint" | "nudge" | "enforce";
export type SteerProfile = "cloud" | "local";

export interface SteerConfig {
	mode: SteerMode;
	/** Direct calls allowed before steering starts. 4 means the fifth one is blocked. */
	after: number;
	/** Blocked direct calls per prompt before the model is left alone again. */
	maxBlocks: number;
	/** `auto` detects local endpoints from the provider and base URL. */
	profile: "auto" | SteerProfile;
}

const MODES = new Set<SteerMode>(["off", "hint", "nudge", "enforce"]);
const PROFILES = new Set(["auto", "cloud", "local"]);

/** Read `PI_CODEMODE_STEER`, `_AFTER`, `_BLOCKS`, `_PROFILE`; malformed values fall back. */
export function readConfig(env: Record<string, string | undefined> = process.env): SteerConfig {
	const mode = String(env.PI_CODEMODE_STEER ?? "nudge").trim().toLowerCase() as SteerMode;
	const num = (v: string | undefined, d: number, min = 0) => {
		const n = Number(v);
		return v !== undefined && v !== "" && Number.isFinite(n) ? Math.max(min, Math.floor(n)) : d;
	};
	const profile = String(env.PI_CODEMODE_STEER_PROFILE ?? "auto").trim().toLowerCase();
	return {
		mode: MODES.has(mode) ? mode : "nudge",
		after: num(env.PI_CODEMODE_STEER_AFTER, 4),
		maxBlocks: num(env.PI_CODEMODE_STEER_BLOCKS, 2),
		profile: PROFILES.has(profile) ? (profile as SteerConfig["profile"]) : "auto",
	};
}

/** Providers that serve models locally, and local-looking base URLs. No host names are hardcoded. */
const LOCAL_PROVIDERS = /^(llama\.?cpp|llamacpp|ollama|lm-?studio|vllm|strata|basalt|local|local-?ai)$/i;

export function isLocalUrl(url: string | undefined): boolean {
	if (!url) return false;
	let host: string;
	try {
		host = new URL(url).hostname.toLowerCase();
	} catch {
		return false;
	}
	if (host === "localhost" || host === "::1" || host.endsWith(".local")) return true;
	if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
	return /^172\.(1[6-9]|2\d|3[01])\./.test(host);
}

/** A local model: a local provider name, or a base URL on loopback, a private network or `.local`. */
export function isLocalModel(model: any): boolean {
	if (!model) return false;
	if (LOCAL_PROVIDERS.test(String(model.provider ?? ""))) return true;
	return isLocalUrl(model.baseUrl);
}

export function profileFor(model: any, config: Pick<SteerConfig, "profile">): SteerProfile {
	if (config.profile !== "auto") return config.profile;
	return isLocalModel(model) ? "local" : "cloud";
}

export interface PromptHints {
	snippet: string;
	guidelines: string[];
	rules: string[];
}

const READ_EXAMPLE = (prefix: string) =>
	`const files = (await tools.bash({ command: "${prefix}ls src" })).output.trim().split("\\n"); ` +
	`const out = await Promise.allSettled(files.map((f) => tools.read({ path: "src/" + f }))); ` +
	`return out.map((r) => (r.status === "fulfilled" ? r.value : String(r.reason)));`;

/**
 * System-prompt additions. They are short on purpose: a model that is already unsure what to do
 * needs a decision rule and one working example, not another page of API reference.
 */
export function hintsFor(profile: SteerProfile, config: SteerConfig): PromptHints {
	if (config.mode === "off") return { snippet: "", guidelines: [], rules: [] };
	const local = profile === "local";
	const guidelines = local
		? [
				"Use codemode for two or more tool calls: one script that calls tools.read, tools.bash, tools.edit or tools.write and returns only what is needed, instead of a series of direct calls.",
				"Put raw JavaScript in `code`, not a markdown fence. Use Promise.allSettled for independent calls; await dependent calls one after another.",
				`Example: \`${READ_EXAMPLE("")}\``,
			]
		: [
				"Use codemode whenever a task needs two or more tool calls: read or search several places in one script, edit several files in one script, or chain a call whose output decides the next call.",
				"Use Promise.allSettled for independent calls and filter large results inside the script, so only the useful text reaches the model.",
				`Example, reading a batch: \`${READ_EXAMPLE("cd repo && ")}\``,
				"Example, editing a batch: `const out = await Promise.allSettled(paths.map((path) => tools.edit({ path, edits: [{ oldText, newText }] }))); return out.map((r) => (r.status === \"fulfilled\" ? r.value : String(r.reason)));`",
			];
	const rules =
		config.mode === "enforce"
			? [
					`After ${config.after} direct tool call${config.after === 1 ? "" : "s"} in one task, do the remaining work with codemode instead of more direct calls.`,
				]
			: [];
	return {
		snippet: "Run JavaScript that calls the other tools in one batch; preferred for multi-step work",
		guidelines,
		rules,
	};
}

/** Mutate pi's prompt options in place: a better tool snippet, guidelines and (for enforce) one rule. */
export function applyHints(options: any, profile: SteerProfile, config: SteerConfig): void {
	const hints = hintsFor(profile, config);
	if (!hints.snippet) return;
	options.toolSnippets ??= {};
	options.toolSnippets.codemode = hints.snippet;
	options.toolGuidelines ??= {};
	const current = Array.isArray(options.toolGuidelines.codemode) ? options.toolGuidelines.codemode : [];
	for (const g of hints.guidelines) if (!current.includes(g)) current.push(g);
	options.toolGuidelines.codemode = current;
	options.promptGuidelines ??= [];
	for (const r of hints.rules) if (!options.promptGuidelines.includes(r)) options.promptGuidelines.push(r);
}

/** A note appended to a tool result in nudge mode. */
export function nudgeNote(profile: SteerProfile, direct: number): string {
	const local = profile === "local";
	return [
		"",
		"",
		`[codemode-steer] You have made ${direct} direct tool calls. For the remaining work, write one codemode script that does it in a batch instead of more direct calls.`,
		local
			? `Put raw JavaScript in \`code\` (no markdown fence). Example: \`${READ_EXAMPLE("")}\``
			: `Example: \`${READ_EXAMPLE("cd repo && ")}\``,
	].join("\n");
}

/** The error a blocked direct call returns. It must be useful enough to write the next script. */
export function blockReason(profile: SteerProfile, toolName: string, direct: number): string {
	const local = profile === "local";
	return [
		`[codemode-steer] ${direct} direct tool calls are enough for this task; \`${toolName}\` was not run.`,
		"Continue with codemode: write one JavaScript script that calls the remaining tools through `tools.<name>(args)` and returns only the result you need.",
		local
			? `Put raw JavaScript in \`code\`, not a markdown fence. Example: \`${READ_EXAMPLE("")}\``
			: `Use Promise.allSettled for independent calls. Example: \`${READ_EXAMPLE("cd repo && ")}\``,
		"Call tools.edit({ path, edits: [{ oldText, newText }] }), tools.write, tools.bash or tools.read the same way.",
	].join("\n");
}

/** Interactive/meta direct tools that are never blocked; a script should not own them. */
export const BYPASS_TOOLS = new Set(["codemode", "ask_question", "ask_user", "question", "exit_plan_mode", "todo_write"]);
