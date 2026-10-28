import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { callKey, callsOf, costUsd, entriesOfSessionDir, keyOf, PATH_RE, PRICES, READERS_RE, sessionStats, turnsOf } from "./session.ts";

const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite, reasoning: 0 });
const text = (t: string) => ({ type: "text", text: t });
const call = (id: string, name: string, args: any) => ({ type: "toolCall", id, name, arguments: args });

const entries = [
	{ type: "message", message: { role: "user", content: [text("do the task")] } },
	{
		type: "message",
		message: {
			role: "assistant",
			model: "some-model",
			stopReason: "toolUse",
			usage: usage(1000, 40, 8000, 0),
			content: [text("reading"), call("1", "read", { path: "src/a.ts" }), call("2", "read", { path: "src/a.ts" })],
		},
	},
	{ type: "message", message: { role: "toolResult", toolCallId: "1", toolName: "read", content: [text("...")], isError: false } },
	{ type: "message", message: { role: "toolResult", toolCallId: "2", toolName: "read", content: [text("boom")], isError: true } },
	{
		type: "message",
		message: {
			role: "assistant",
			model: "some-model",
			stopReason: "toolUse",
			usage: usage(2000, 60, 9000, 500),
			content: [call("3", "edit", { path: "src/a.ts", edits: [] }), call("4", "bash", { command: "cat src/a.ts | grep x", args: { ["__proto__"]: "polluted" } })],
		},
	},
	{ type: "message", message: { role: "toolResult", toolCallId: "3", toolName: "edit", content: [text("Validation failed: bad edit")], isError: true } },
	{ type: "message", message: { role: "toolResult", toolCallId: "4", toolName: "bash", content: [text("x")], isError: false } },
	{ type: "compaction", tokensBefore: 3000, data: { ms: 250 } },
	{ type: "message", message: { role: "assistant", model: "other-model", stopReason: "stop", usage: usage(500, 10), content: [text("I will call <tool_call> now")] } },
	{ type: "message", message: { role: "assistant", model: "other-model", stopReason: "error", errorMessage: "endpoint died", usage: usage(0, 0), content: [] } },
	{ type: "custom", customType: "thinking-guard-tip", data: { text: "a tip", count: 2 } },
];

test("turn counts, call counts and the repeats", () => {
	const st = sessionStats(entries);
	assert.equal(st.assistant_turns, 4);
	assert.equal(st.tool_calls, 4);
	assert.equal(st.codemode_calls, 0);
	assert.equal(st.direct_calls, 4);
	assert.equal(st.codemode_turns, 0);
	assert.equal(st.codemode_errors, 0);
	assert.equal(st.tool_errors, 2);
	assert.equal(st.tool_uniq, 3); // read, edit, bash
	assert.equal(st.repeat_calls, 1); // the second identical read
	assert.equal(st.repeat_max, 2);
	assert.equal(st.top_repeats, "read 2x");
	assert.equal(turnsOf(entries).length, 4);
	assert.equal(turnsOf(entries)[0].calls.length, 2);
	assert.equal(turnsOf(entries)[1].error, true); // the failed edit belongs to that turn
});

test("edit discipline, malformed calls and provider failures", () => {
	const st = sessionStats(entries);
	assert.equal(st.edit_calls, 1);
	assert.equal(st.edit_errors, 1);
	assert.equal(st.malformed_calls, 2); // the text pseudo-call, and the __proto__ argument the harness rejected
	assert.equal(st.stop, "error"); // the last stop reason wins
	assert.equal(st.error_turns, 1);
	assert.equal(st.last_error, "endpoint died");
	assert.equal(st.provider_errors, 1);
});

test("token totals, context growth, models and compaction", () => {
	const st = sessionStats(entries);
	assert.equal(st.in_miss, 3500);
	assert.equal(st.in_hit, 17000);
	assert.equal(st.in_write, 500);
	assert.equal(st.out, 110);
	assert.equal(st.ctx_peak, 2000 + 9000 + 500); // the largest request
	assert.equal(st.ctx_mean, Math.round((9000 + 11500 + 500) / 3));
	assert.equal(st.ctx_sum_over_turns, 9000 + 11500 + 500);
	assert.equal(st.compactions, 1);
	assert.equal(st.compaction_ms, 250);
	assert.deepEqual(st.models, ["some-model", "other-model"]);
	assert.equal(st.custom_messages, 1);
	assert.equal(st.tips, 2);
});

test("codemode calls, codemode turns, errors and steer counters", () => {
	const cm = [
		{ type: "message", message: { role: "assistant", stopReason: "toolUse", usage: usage(1, 1), content: [call("c1", "codemode", { code: "return 1" }), call("c2", "read", { path: "a" })] } },
		{ type: "message", message: { role: "toolResult", toolCallId: "c1", toolName: "codemode", content: [text("Script failed")], isError: true } },
		{ type: "message", message: { role: "toolResult", toolCallId: "c2", toolName: "read", content: [text("a")], isError: false } },
		{ type: "custom", customType: "codemode-steer", data: { direct: 3, blocks: 2, gaveUp: true } },
	];
	const st = sessionStats(cm);
	assert.equal(st.codemode_calls, 1);
	assert.equal(st.direct_calls, 1);
	assert.equal(st.codemode_turns, 1);
	assert.equal(st.codemode_errors, 1);
	assert.equal(st.steer_blocks, 2);
	assert.equal(st.steer_gave_up, 1);
});

test("calls of a session, and the file paths in a transcript", () => {
	const calls = callsOf(entries);
	assert.deepEqual(calls.map((c) => c.name), ["read", "read", "edit", "bash"]);
	assert.deepEqual([...calls[0].paths], ["src/a.ts"]);
	assert.deepEqual([...calls[3].paths], ["src/a.ts"]); // `cat src/a.ts | grep x` reads it
	assert.deepEqual([...calls[2].paths], []); // an edit is not a read
	assert.equal(callKey(entries[1].message.content[1]), keyOf("read", { path: "src/a.ts" }));
	assert.equal(callKey({ name: "read", arguments: { b: 1, a: 2 } }), callKey({ name: "read", arguments: { a: 2, b: 1 } }));

	assert.ok(READERS_RE.test("cat src/a.ts"));
	assert.ok(READERS_RE.test("rg 'x' src"));
	assert.ok(!READERS_RE.test("rm -rf src/a.ts"));
	assert.deepEqual("see README.md, a.jsonl and rm -rf src".match(new RegExp(PATH_RE.source, "g")), ["README.md", "a.jsonl"]);
});

test("cost at an endpoint's price", () => {
	const price = { miss: 3, hit: 0.3, out: 10 };
	assert.equal(costUsd({ in_miss: 1000000, in_hit: 0, out: 0 }, price), 3);
	assert.equal(costUsd({ in_miss: 0, in_hit: 1000000, out: 1000000 }, price), 10.3);
	assert.equal(costUsd({ in_miss: 0, in_hit: 0, out: 0 }, price), 0);
	assert.deepEqual(PRICES["openai-codex"], { hit: 0.625, miss: 1.25, out: 10, label: "openai-codex/gpt-5.2 (list)" });
});

test("session dirs are read from their JSONL files", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-bench-sess-"));
	mkdirSync(join(dir, "s"), { recursive: true });
	writeFileSync(join(dir, "s", "x.jsonl"), entries.map((e) => JSON.stringify(e)).join("\n") + "\n{half-written\n");
	assert.deepEqual(entriesOfSessionDir(dir).map((e) => e.type).slice(0, 2), ["message", "message"]);
	assert.equal(sessionStats(entriesOfSessionDir(dir)).tool_calls, 4);
	assert.equal(entriesOfSessionDir(join(dir, "nope")).length, 0);
});
