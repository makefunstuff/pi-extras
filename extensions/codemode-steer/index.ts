// codemode-steer: make models actually use codemode for multi-step work.
//
// Two levers, both only while `codemode` is active:
//   1. Prompt: a clearer codemode snippet, a decision rule (two or more calls -> one script) and
//      one working example. Local models get a shorter version and an explicit "raw JavaScript,
//      no markdown fence" hint.
//   2. Call boundary: in `enforce` mode (the default) the first few direct calls run normally; the
//      next ones are blocked with a short error that names codemode and shows the script shape.
//      After `PI_CODEMODE_STEER_BLOCKS` blocks in one prompt the model is left alone again, so a
//      model that cannot write a script is never stuck. `nudge` mode never blocks: it appends the
//      same guidance to a tool result. `hint` only changes the prompt.
//
// Every state change is per user prompt; callbacks made from inside a codemode script are nested
// (`parentToolCallId`) and are never blocked.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyHints, blockReason, BYPASS_TOOLS, nudgeNote, profileFor, readConfig, type SteerConfig, type SteerProfile } from "./steer.ts";

export const CUSTOM_TYPE = "codemode-steer";

export interface SteerOptions {
	config?: SteerConfig;
}

export default function codemodeSteer(pi: ExtensionAPI, options: SteerOptions = {}) {
	const cfg = options.config ?? readConfig(process.env);
	if (cfg.mode === "off") return;
	const state = { direct: 0, blocks: 0, gaveUp: false, nudged: false, pending: false };

	const codemodeActive = () => pi.getActiveTools().includes("codemode");
	const profile = (ctx: ExtensionContext): SteerProfile => profileFor(ctx.model, cfg);
	// Only `direct` tools are declared next to codemode and callable from a script. `model-only`
	// tools (tool_search, codemode itself) cannot be called from a script, so steering them into
	// codemode would point the model at something that cannot work.
	const isDirect = (name: string) => pi.getAllTools().find((tool) => tool.name === name)?.exposure === "direct";

	pi.on("session_start", () => {
		state.direct = state.blocks = 0;
		state.gaveUp = state.nudged = state.pending = false;
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (event.messageType === "user") {
			state.direct = state.blocks = 0;
			state.gaveUp = state.nudged = state.pending = false;
		}
		if (!codemodeActive()) return;
		applyHints(event.systemPromptOptions, profile(ctx), cfg);
	});

	pi.on("tool_call", (event, ctx) => {
		if (!codemodeActive() || event.parentToolCallId) return;
		if (BYPASS_TOOLS.has(event.toolName) || !isDirect(event.toolName)) return;
		state.direct++;
		if (cfg.mode === "nudge") {
			if (!state.nudged && state.direct > cfg.after) state.pending = true;
			return;
		}
		if (cfg.mode !== "enforce") return;
		if (state.direct <= cfg.after || state.gaveUp) return;
		if (state.blocks >= cfg.maxBlocks) {
			state.gaveUp = true;
			if (ctx.hasUI) ctx.ui.notify(`codemode-steer: still using direct calls after ${state.blocks} blocks; leaving it alone`, "warning");
			return;
		}
		state.blocks++;
		return { block: true, reason: blockReason(profile(ctx), event.toolName, state.direct) };
	});

	// Nudge mode: attach the note to the result the model reads next, without rewriting history.
	pi.on("message_end", (event: any, ctx) => {
		const m = event.message;
		if (cfg.mode !== "nudge" || m?.role !== "toolResult" || !state.pending) return;
		state.pending = false;
		state.nudged = true;
		return {
			message: {
				...m,
				content: [...(m.content ?? []), { type: "text", text: nudgeNote(profile(ctx), state.direct) }],
			},
		};
	});

	pi.on("agent_settled", () => {
		if (state.direct || state.blocks) pi.appendEntry(CUSTOM_TYPE, { mode: cfg.mode, direct: state.direct, blocks: state.blocks, gaveUp: state.gaveUp });
	});

	pi.registerCommand("codemode-steer", {
		description: "Show how codemode-steer is configured and how often it stepped in",
		handler: async (_args, ctx) => {
			ctx.ui.notify(
				[
					`codemode-steer ${cfg.mode}${cfg.mode === "enforce" ? ` (after ${cfg.after} direct calls, ${cfg.maxBlocks} blocks)` : ""}`,
					`this prompt: ${state.direct} direct calls, ${state.blocks} blocked${state.gaveUp ? ", gave up" : ""}, ${state.nudged ? "nudged" : "not nudged"}`,
					`profile: ${cfg.profile === "auto" ? `auto (${profile(ctx)})` : cfg.profile}; set PI_CODEMODE_STEER=off|hint|nudge|enforce to change`,
				].join("\n"),
				"info",
			);
		},
	});
}
