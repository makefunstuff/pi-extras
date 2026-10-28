// lfm3: Liquid AI's LFM3 models on this machine, for small jobs.
//
// The measured part is d1-2B, a decision model: one llama.cpp request answers yes/no and choice
// questions about one piece of state, with calibrated probabilities and no generated tokens. It is
// registered as a pi classifier (so codemode and other extensions reach it through
// modelRegistry.classify) and as the lfm3_decide tool.
//
// LFM3-1.7B is also registered as a chat model for experiments. It was NOT good enough in the POC
// for the board's Watcher or for task titles (see README.md), so nothing routes to it by itself.
//
// Off by default: no provider, no tool and no request until PI_LFM3=on or the config file says
// enabled. When a server is down the tool says so and the agent decides without it.
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionToolContext, ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { classifySystemOne, formatAnswer, probeServer, type ClassifierAnswer, type ClassifierQuestion, type FetchLike } from "./client.ts";
import { configPath, loadConfig, type Lfm3Config } from "./config.ts";

export const PROVIDER = "lfm3";
export const CHAT_MODEL = "lfm3-1.7b";
export const D1_MODEL = "d1-2b";
export const COMMAND = "lfm3";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export interface Lfm3Options {
	config?: Lfm3Config;
	/** Injected by the tests; real requests use global fetch. */
	fetch?: FetchLike;
}

function providerConfig(config: Lfm3Config, fetchImpl?: FetchLike): ProviderConfig {
	const chat: ProviderModelConfig = {
		type: "chat",
		id: CHAT_MODEL,
		name: "LFM3-1.7B QAD Q4_0 (CPU)",
		reasoning: true,
		// The chat template thinks by default, and thinking ran at 8 tok/s on CPU in the POC. The
		// default levels (off, minimal, low) therefore turn it off; `:medium` and above opt in.
		thinkingLevelMap: { off: "off", minimal: "off", low: "off", medium: "medium", high: "medium", xhigh: "medium" },
		input: ["text"],
		contextWindow: 16384,
		maxTokens: 2048,
		cost: ZERO_COST,
		samplingParams: { temperature: 0.1, top_k: 50, repeat_penalty: 1.1 },
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			supportsUsageInStreaming: true,
			supportsStrictMode: false,
			maxTokensField: "max_tokens",
			thinkingFormat: "qwen-chat-template",
		},
	};
	const d1: ProviderModelConfig = {
		type: "classifier",
		id: D1_MODEL,
		name: "d1-2B Q8_0 (CPU)",
		api: "typesafe-system-one",
		baseUrl: `${config.d1Url}/v1`,
		input: ["text"],
		contextWindow: 32768,
		cost: ZERO_COST,
	};
	return {
		name: "LFM3 local (CPU)",
		baseUrl: `${config.baseUrl}/v1`,
		api: "openai-completions",
		apiKey: "local",
		models: [chat, d1],
		classifiers: {
			"typesafe-system-one": {
				classify: (model, context, options) =>
					classifySystemOne(model, context, { fetch: fetchImpl, timeoutMs: config.timeoutMs, signal: options?.signal }),
			},
		},
	};
}

function criteriaOf(options: string[] | undefined): Record<string, string> | undefined {
	if (!options?.length) return undefined;
	return Object.fromEntries(options.map((option) => [option, option]));
}

function fallbackText(config: Lfm3Config, reason: string): string {
	return `lfm3 is not available (${reason}). Decide with your own judgement, or start the local server and see /lfm3.`;
}

function summary(result: { ms: number; answers: Record<string, ClassifierAnswer> }): string {
	const lines = Object.entries(result.answers).map(([id, answer]) => `${id}: ${formatAnswer(answer)}`);
	return `lfm3/d1-2b (${result.ms} ms)\n${lines.join("\n")}`;
}

export default function lfm3(pi: ExtensionAPI, options: Lfm3Options = {}) {
	const warnings: string[] = [];
	const config = options.config ?? loadConfig(process.env, (m) => warnings.push(m));
	let registered = false;
	let toolRegistered = false;

	const register = () => {
		if (!config.enabled || registered) return;
		pi.registerProvider(PROVIDER, providerConfig(config, options.fetch));
		registered = true;
	};

	const unregister = () => {
		if (!registered) return;
		pi.unregisterProvider(PROVIDER);
		registered = false;
	};

	pi.on("session_start", (_event, ctx) => {
		for (const w of warnings.splice(0)) {
			if (ctx.hasUI) ctx.ui.notify(w, "warning");
		}
	});

	const registerTool = () => {
		if (!config.enabled || !config.tool || toolRegistered) return;
		toolRegistered = true;
		pi.registerTool({
			name: "lfm3_decide",
			label: "LFM3 decide",
			description:
				"Ask the local d1-2B decision model yes/no or choice questions about one piece of text, in one pass, with calibrated probabilities. " +
				"Use it for small triage decisions: is an agent stuck, is a review finding blocking, which team or repo does this belong to. " +
				"If the local server is down it says so; decide with your own judgement then.",
			promptSnippet: "lfm3_decide: local d1-2B decisions (yes/no, choice) with probabilities",
			parameters: Type.Object({
				state: Type.String({ description: "The text or JSON to judge, passed as data." }),
				questions: Type.Array(
					Type.Object({
						id: Type.String({ description: "Short name used in the answer" }),
						type: Type.Union([Type.Literal("bool"), Type.Literal("choice")], { description: "bool: yes/no, choice: one of the options" }),
						instructions: Type.String({ description: "The question to answer about the state" }),
						options: Type.Optional(Type.Array(Type.String(), { description: "For choice: the labels, at least two" })),
					}),
					{ minItems: 1, maxItems: 6 },
				),
			}),
			async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionToolContext) {
				const t0 = Date.now();
				if (!config.enabled) {
					return { content: [{ type: "text" as const, text: fallbackText(config, "PI_LFM3 is off") }], details: { fallback: true, reason: "disabled" } };
				}
				const questions: Record<string, ClassifierQuestion> = {};
				for (const q of params.questions) {
					if (q.type === "choice") {
						const criteria = criteriaOf(q.options);
						if (!criteria || Object.keys(criteria).length < 2) {
							return {
								content: [{ type: "text" as const, text: `lfm3_decide: choice question "${q.id}" needs at least two options.` }],
								details: { error: "bad-options", question: q.id },
							};
						}
						questions[q.id] = { type: "choice", instructions: q.instructions, criteria };
					} else {
						questions[q.id] = { type: "bool", instructions: q.instructions, criteria: { true: "yes", false: "no" } };
					}
				}
				const model = ctx.modelRegistry.getModelOfType("classifier", PROVIDER, D1_MODEL);
				if (!model) {
					return { content: [{ type: "text" as const, text: fallbackText(config, "the d1-2B classifier is not registered") }], details: { fallback: true, reason: "no-model" } };
				}
				const result = await ctx.modelRegistry.classify(model, { state: params.state, questions }, { signal });
				const ms = Date.now() - t0;
				if (result.stopReason !== "stop") {
					return {
						content: [{ type: "text" as const, text: fallbackText(config, `${config.d1Url}: ${result.errorMessage ?? result.stopReason}`) }],
						details: { fallback: true, ms, stopReason: result.stopReason, errorMessage: result.errorMessage },
					};
				}
				return {
					content: [{ type: "text" as const, text: summary({ ms, answers: result.answers }) }],
					details: { ms, answers: result.answers, usage: result.usage },
				};
			},
		});
	};

	register();
	registerTool();

	pi.registerCommand(COMMAND, {
		description: "Show whether local LFM3 (chat and d1-2B) is on and reachable; `on` / `off` toggles the provider for this session",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on" || arg === "off") {
				config.enabled = arg === "on";
				if (config.enabled) {
					register();
					registerTool();
				} else unregister();
			}
			const [chat, d1] = config.enabled
				? await Promise.all([
						probeServer(config.baseUrl, { fetch: options.fetch, timeoutMs: 700 }),
						probeServer(config.d1Url, { fetch: options.fetch, timeoutMs: 700 }),
					])
				: [{ ok: false, detail: "not checked" }, { ok: false, detail: "not checked" }];
			const line = (name: string, url: string, health: { ok: boolean; detail: string }) =>
				`${name.padEnd(5)} ${url} — ${health.ok ? `ok (${health.detail})` : `not reachable (${health.detail})`}`;
			const lines = [
				`lfm3 ${config.enabled ? "on" : "off"} (config: ${configPath()})`,
				line("chat", config.baseUrl, chat),
				line("d1", config.d1Url, d1),
				config.enabled
					? `models: ${PROVIDER}/${CHAT_MODEL} (chat), classifier ${PROVIDER}/${D1_MODEL}; tool ${config.tool ? "lfm3_decide" : "off"}`
					: `enable: PI_LFM3=on, or {"enabled":true} in ${configPath()}, then restart pi (or /lfm3 on now)`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
