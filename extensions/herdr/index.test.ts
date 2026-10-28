import assert from "node:assert/strict";
import { test } from "node:test";
import { fakePi } from "../../test/lib/fake-pi.ts";
import type { HerdrConfig } from "./config.ts";
import type { CommandRunner } from "./exec.ts";
import { registerHerdr, TOOL_NAMES } from "./index.ts";

const baseConfig: HerdrConfig = {
	herdrBin: "herdr",
	boardBin: "herdr-projects",
	writes: false,
	exposure: "codemode",
	timeoutMs: 1000,
	maxOutput: 100_000,
	stuckModel: { provider: "lfm3", id: "d1-2b" },
};

function runner(handler: () => string): CommandRunner & { calls: Array<{ bin: string; args: string[] }> } {
	const calls: Array<{ bin: string; args: string[] }> = [];
	const run: CommandRunner = async (bin, args) => {
		calls.push({ bin, args });
		return { code: 0, stdout: handler(), stderr: "", timedOut: false, aborted: false };
	};
	return Object.assign(run, { calls });
}

function setup(overrides: Partial<HerdrConfig> = {}, handler: () => string = () => "[]") {
	const pi = fakePi();
	const run = runner(handler);
	registerHerdr(pi as any, { config: { ...baseConfig, ...overrides }, run });
	return { pi, run };
}

test("all tools are registered once, in the herdr namespace, with output schemas", () => {
	const { pi } = setup();
	assert.deepEqual([...pi.tools.keys()].sort(), [...TOOL_NAMES].sort());
	for (const name of TOOL_NAMES) {
		const tool = pi.tools.get(name);
		assert.equal(tool.exposure, "codemode", `${name} is codemode-callable`);
		assert.equal(tool.namespace.name, "herdr");
		assert.ok(tool.parameters, `${name} has parameters`);
		assert.ok(tool.outputSchema, `${name} has an output schema`);
		assert.match(tool.description, /Read-only|WRITE/);
	}
	assert.equal(pi.tools.get("herdr_agent_list").annotations.readOnlyHint, true);
	assert.equal(pi.tools.get("herdr_agent_prompt").annotations.readOnlyHint, false);
	assert.equal(pi.tools.get("herdr_agent_prompt").annotations.destructiveHint, true);
});

test("a read-only tool returns structured JSON", async () => {
	const { pi, run } = setup({}, () =>
		JSON.stringify({ result: { agents: [{ name: "sw-a", agent_status: "blocked", pane_id: "w1:p1", focused: false }] } }),
	);
	const result = await pi.tools.get("herdr_agent_list").execute("id", { status: "blocked" }, undefined, undefined, {});
	assert.equal(result.isError, undefined);
	assert.deepEqual(result.structuredContent, {
		agents: [{ name: "sw-a", status: "blocked", paneId: "w1:p1", focused: false }],
		count: 1,
	});
	assert.equal(run.calls[0].args[0], "agent");
});

test("writes are off by default, and even enabled writes need confirm: true", async () => {
	const { pi, run } = setup();
	const off = await pi.tools.get("herdr_agent_prompt").execute("id", { target: "sw-a", text: "hi", confirm: true }, undefined, undefined, {});
	assert.equal(off.isError, true);
	assert.equal(off.structuredContent.error.code, "writes_disabled");
	assert.equal(run.calls.length, 0);

	const enabled = setup({ writes: true });
	const noConfirm = await enabled.pi.tools.get("herdr_agent_prompt").execute("id", { target: "sw-a", text: "hi" }, undefined, undefined, {});
	assert.equal(noConfirm.isError, true);
	assert.equal(noConfirm.structuredContent.error.code, "confirmation_required");
	assert.equal(enabled.run.calls.length, 0);
});

test("an enabled, confirmed prompt runs and returns its JSON", async () => {
	const { pi, run } = setup({ writes: true }, () => JSON.stringify({ result: { submitted: true } }));
	const result = await pi.tools.get("herdr_agent_prompt").execute(
		"id",
		{ target: "sw-a", text: "hi", wait: true, until: ["blocked"], timeoutMs: 100, confirm: true },
		undefined,
		undefined,
		{},
	);
	assert.equal(result.isError, undefined);
	assert.deepEqual(result.structuredContent, { target: "sw-a", result: { submitted: true } });
	assert.deepEqual(run.calls[0].args, ["agent", "prompt", "sw-a", "hi", "--wait", "--until", "blocked", "--timeout", "100"]);
});

test("board add wraps the board's task and passes the flags", async () => {
	const { pi, run } = setup({ writes: true }, () => JSON.stringify({ id: "r/2", state: "todo", title: "B" }));
	const result = await pi.tools.get("herdr_board_add").execute(
		"id",
		{ title: "B", description: "desc", delegate: true, after: ["r/1"], confirm: true },
		undefined,
		undefined,
		{},
	);
	assert.deepEqual(result.structuredContent, { ok: true, task: { id: "r/2", state: "todo", title: "B" } });
	assert.deepEqual(run.calls[0].args, ["add", "B", "--desc", "desc", "--delegate", "--after", "r/1", "--json"]);
});

test("a failed CLI call is a tool error with a code", async () => {
	const pi = fakePi();
	const run: CommandRunner = async () => ({ code: 1, stdout: "", stderr: "socket gone", timedOut: false, aborted: false });
	registerHerdr(pi as any, { config: baseConfig, run });
	const result = await pi.tools.get("herdr_workspace_list").execute("id", {}, undefined, undefined, {});
	assert.equal(result.isError, true);
	assert.equal(result.structuredContent.error.code, "herdr_failed");
	assert.match(result.structuredContent.error.message, /socket gone/);
});

test("an exposure override is applied to every tool", () => {
	const { pi } = setup({ exposure: "direct" });
	for (const name of TOOL_NAMES) assert.equal(pi.tools.get(name).exposure, "direct");
});
