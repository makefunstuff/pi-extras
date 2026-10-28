import assert from "node:assert/strict";
import { textOf } from "../../test/lib/harness.mjs";

// With PI_LFM3=on the extension must load in a real pi process, register its provider, and run the
// lfm3_decide tool against a d1 server that is not there: the tool returns its fallback and the
// turn goes on. The mock model, not LFM3, is the model here; no llama.cpp and no network needed.
const env = { PI_LFM3: "on", PI_LFM3_URL: "http://127.0.0.1:1", PI_LFM3_D1_URL: "http://127.0.0.1:1" };

export default [
	{
		name: "lfm3 provider registers with the servers down",
		env,
		respond: () => ({ content: "SMOKE_OK lfm3 loaded" }),
		check: ({ stdout }) => {
			if (!stdout.includes("SMOKE_OK")) throw new Error("mock answer missing from output");
		},
	},
	{
		name: "lfm3_decide falls back when d1 is down, and the turn continues",
		prompt: "Check whether the finding is blocking.",
		env,
		respond(_body, n) {
			if (n === 0)
				return {
					toolCalls: [
						{
							name: "lfm3_decide",
							arguments: {
								state: "The fallback is never tested.",
								questions: [{ id: "blocking", type: "bool", instructions: "Must this be fixed before merging?" }],
							},
						},
					],
				};
			return { content: "SMOKE_OK decided without the tool" };
		},
		check({ stdout }, mock) {
			assert.match(stdout, /SMOKE_OK/);
			assert.equal(mock.requests.length, 2, "the tool result went back to the model");
			const toolResult = mock.requests[1].messages.find((m) => m.role === "tool");
			assert.ok(toolResult, "a tool result was sent");
			assert.match(textOf(toolResult), /lfm3 is not available/);
			assert.match(textOf(toolResult), /own judgement/);
		},
	},
];
