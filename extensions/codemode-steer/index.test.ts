import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeCtx, fakePi } from "../../test/lib/fake-pi.ts";
import codemodeSteer, { CUSTOM_TYPE } from "./index.ts";
import { isLocalModel, isLocalUrl, readConfig, type SteerConfig } from "./steer.ts";

// Enforcement tests opt in explicitly; the package default (readConfig) is nudge.
const config = (over: Partial<SteerConfig> = {}): SteerConfig => ({ mode: "enforce", after: 4, maxBlocks: 2, profile: "auto", ...over });

const TOOLS = [
	{ name: "read", exposure: "direct" },
	{ name: "bash", exposure: "direct" },
	{ name: "edit", exposure: "direct" },
	{ name: "write", exposure: "direct" },
	{ name: "ask_question", exposure: "direct" },
	{ name: "codemode", exposure: "model-only" },
	{ name: "tool_search", exposure: "model-only" },
];
function setup(over: Partial<SteerConfig> = {}, active = ["read", "bash", "edit", "write", "codemode", "tool_search"], tools = TOOLS) {
	const pi = fakePi();
	(pi as any).getActiveTools = () => active;
	(pi as any).getAllTools = () => tools;
	codemodeSteer(pi as any, { config: config(over) });
	return pi;
}

const userStart = () => ({
	type: "before_agent_start",
	messageType: "user",
	prompt: "do it",
	systemPromptOptions: { toolSnippets: {}, toolGuidelines: {}, promptGuidelines: [] as string[] },
});

const cloud = () => fakeCtx({ model: { provider: "deepseek", baseUrl: "https://api.deepseek.com" } });
const local = () => fakeCtx({ model: { provider: "llama.cpp", baseUrl: "http://127.0.0.1:8080" } });
const call = (name: string, parent?: string) => ({ type: "tool_call", toolName: name, toolCallId: "c1", ...(parent ? { parentToolCallId: parent } : {}) });

test("config: modes, thresholds, profile and malformed values", () => {
	assert.deepEqual(readConfig({}), { mode: "nudge", after: 4, maxBlocks: 2, profile: "auto" });
	assert.equal(readConfig({ PI_CODEMODE_STEER: "off" }).mode, "off");
	assert.equal(readConfig({ PI_CODEMODE_STEER: "nudge" }).mode, "nudge");
	assert.equal(readConfig({ PI_CODEMODE_STEER: "bogus" }).mode, "nudge");
	assert.deepEqual([readConfig({ PI_CODEMODE_STEER_AFTER: "0", PI_CODEMODE_STEER_BLOCKS: "3" }).after, readConfig({ PI_CODEMODE_STEER_BLOCKS: "3" }).maxBlocks], [0, 3]);
	assert.equal(readConfig({ PI_CODEMODE_STEER_AFTER: "-4" }).after, 0);
	assert.equal(readConfig({ PI_CODEMODE_STEER_PROFILE: "local" }).profile, "local");
	assert.equal(readConfig({ PI_CODEMODE_STEER_PROFILE: "elsewhere" }).profile, "auto");
});

test("local detection covers provider names and private base URLs, not cloud endpoints", () => {
	for (const url of ["http://127.0.0.1:8080", "http://localhost:1234/v1", "http://10.1.2.3:8000/v1", "http://192.168.1.5/v1", "http://172.20.0.2/v1", "http://100.64.1.2/v1", "http://" + "box." + "ts.net/v1", "http://[fd12::1]:8000/v1", "http://box.local/v1"])
		assert.equal(isLocalUrl(url), true, url);
	for (const url of ["https://api.deepseek.com", "https://openrouter.ai/api/v1", "http://172.32.0.1/v1", // no-secrets: allow (synthetic public fixture for the private-range boundary)
		"http://100.128.0.1/v1", // no-secrets: allow (synthetic public fixture for the CGNAT boundary)
		"not a url"])
		assert.equal(isLocalUrl(url), false, url);
	assert.equal(isLocalModel({ provider: "llama.cpp", baseUrl: "https://example.com" }), true);
	assert.equal(isLocalModel({ provider: "ollama", baseUrl: "" }), true);
	assert.equal(isLocalModel({ provider: "deepseek", baseUrl: "https://api.deepseek.com" }), false);
});

test("prompt: a clearer codemode snippet, guidelines and one rule while codemode is active", async () => {
	const pi = setup();
	const ev = userStart();
	await pi.emit("before_agent_start", ev, cloud());
	assert.match(ev.systemPromptOptions.toolSnippets.codemode, /one batch/);
	assert.ok(ev.systemPromptOptions.toolGuidelines.codemode.some((g: string) => g.startsWith("Use codemode whenever")));
	assert.ok(ev.systemPromptOptions.toolGuidelines.codemode.some((g: string) => g.includes("Promise.allSettled")));
	assert.deepEqual(ev.systemPromptOptions.promptGuidelines, ["After 4 direct tool calls in one task, do the remaining work with codemode instead of more direct calls."]);
});

test("prompt: local models get the raw-JavaScript hint and a shorter example", async () => {
	const pi = setup();
	const ev = userStart();
	await pi.emit("before_agent_start", ev, local());
	const text = ev.systemPromptOptions.toolGuidelines.codemode.join("\n");
	assert.match(text, /raw JavaScript/);
	assert.match(text, /not a markdown fence/);
	assert.ok(!text.includes("editing a batch"), "the longer cloud example is left out");
});

test("prompt: nothing changes when codemode is not active", async () => {
	const pi = setup({}, ["read", "bash"]);
	const ev = userStart();
	await pi.emit("before_agent_start", ev, cloud());
	assert.deepEqual(ev.systemPromptOptions, { toolSnippets: {}, toolGuidelines: {}, promptGuidelines: [] });
	const [r] = await pi.emit("tool_call", call("read"), cloud());
	assert.equal(r, undefined);
	assert.equal((pi as any).calls.some((c: any) => c.method === "setActiveTools"), false);
});

test("enforce: the first four direct calls run, the fifth is blocked with an actionable reason", async () => {
	const pi = setup();
	for (const name of ["read", "bash", "edit", "read"]) assert.deepEqual(await pi.emit("tool_call", call(name), cloud()), [undefined]);
	const [blocked] = await pi.emit("tool_call", call("edit"), cloud());
	assert.equal(blocked.block, true);
	assert.match(blocked.reason, /5 direct tool calls are enough/);
	assert.match(blocked.reason, /Continue with codemode/);
	assert.match(blocked.reason, /tools\.edit/);
});

test("enforce: codemode calls and calls made inside a script are never blocked", async () => {
	const pi = setup({ after: 0 });
	assert.deepEqual(await pi.emit("tool_call", call("codemode"), cloud()), [undefined]);
	assert.deepEqual(await pi.emit("tool_call", call("read", "parent-1"), cloud()), [undefined]);
	assert.deepEqual(await pi.emit("tool_call", call("ask_question"), cloud()), [undefined]);
	const [blocked] = await pi.emit("tool_call", call("bash"), cloud());
	assert.equal(blocked.block, true);
});

test("model-only tools such as tool_search are never counted or blocked", async () => {
	const pi = setup({ after: 0, maxBlocks: 2 });
	for (let i = 0; i < 5; i++) assert.deepEqual(await pi.emit("tool_call", call("tool_search"), cloud()), [undefined]);
	assert.deepEqual(await pi.emit("tool_call", call("codemode"), cloud()), [undefined]);
	// an unknown tool is not treated as direct either: fail-safe, do not trap it
	assert.deepEqual(await pi.emit("tool_call", call("mystery"), cloud()), [undefined]);
	const [blocked] = await pi.emit("tool_call", call("read"), cloud());
	assert.equal(blocked.block, true);
	assert.match(blocked.reason, /1 direct tool calls are enough/);
});

test("enforce: after maxBlocks the model is left alone, and a new prompt starts over", async () => {
	const pi = setup({ after: 1, maxBlocks: 2 });
	await pi.emit("tool_call", call("read"), cloud());
	assert.equal((await pi.emit("tool_call", call("bash"), cloud()))[0].block, true);
	assert.equal((await pi.emit("tool_call", call("bash"), cloud()))[0].block, true);
	assert.deepEqual(await pi.emit("tool_call", call("bash"), cloud()), [undefined], "gave up after two blocks");

	const ev = userStart();
	await pi.emit("before_agent_start", ev, cloud());
	assert.deepEqual(await pi.emit("tool_call", call("read"), cloud()), [undefined], "counter reset for the new prompt");
});

test("nudge: a note is appended to the next tool result, once per prompt", async () => {
	const pi = setup({ mode: "nudge", after: 2 });
	for (let i = 0; i < 5; i++) await pi.emit("tool_call", call("read"), local());
	const msg = { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "contents" }], isError: false };
	const [out] = await pi.emit("message_end", { type: "message_end", message: msg }, local());
	assert.equal(out.message.content.length, 2);
	assert.equal(out.message.content[0].text, "contents");
	assert.match(out.message.content[1].text, /\[codemode-steer\] You have made 5 direct tool calls/);
	assert.match(out.message.content[1].text, /raw JavaScript/);
	const [again] = await pi.emit("message_end", { type: "message_end", message: msg }, local());
	assert.equal(again, undefined, "only one nudge per prompt");
});

test("hint and off modes never block or nudge", async () => {
	for (const mode of ["hint", "off"] as const) {
		const pi = setup({ mode, after: 0 });
		for (let i = 0; i < 5; i++) assert.equal((await pi.emit("tool_call", call("bash"), cloud()))[0], undefined);
		const [out] = await pi.emit("message_end", { type: "message_end", message: { role: "toolResult", content: [] } }, cloud());
		assert.equal(out, undefined);
	}
});

test("without tool metadata nothing is blocked, rather than guessing", async () => {
	const pi = fakePi();
	(pi as any).getActiveTools = () => ["read", "bash", "codemode", "tool_search"];
	(pi as any).getAllTools = () => undefined;
	codemodeSteer(pi as any, { config: config({ after: 0 }) });
	for (let i = 0; i < 3; i++) assert.deepEqual(await pi.emit("tool_call", call("tool_search"), cloud()), [undefined]);
	assert.deepEqual(await pi.emit("tool_call", call("bash"), cloud()), [undefined]);
});

test("agent_settled records the counters and /codemode-steer reports them", async () => {
	const pi = setup({ after: 0, maxBlocks: 1 });
	await pi.emit("tool_call", call("read"), cloud());
	await pi.emit("tool_call", call("bash"), cloud());
	await pi.emit("agent_settled", { type: "agent_settled" }, cloud());
	const entry = (pi as any).calls.find((c: any) => c.method === "appendEntry");
	assert.equal(entry.args[0], CUSTOM_TYPE);
	assert.deepEqual([entry.args[1].direct, entry.args[1].blocks, entry.args[1].gaveUp], [2, 1, true]);

	const ctx = fakeCtx({ model: { provider: "deepseek" } });
	await pi.commands.get("codemode-steer").handler("", ctx);
	assert.match(ctx.notes[0].message, /codemode-steer enforce/);
	assert.match(ctx.notes[0].message, /2 direct calls, 1 blocked, gave up/);
});
