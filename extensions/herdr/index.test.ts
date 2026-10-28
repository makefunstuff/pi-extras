import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function runner(handler: () => string): CommandRunner & { calls: Array<{ bin: string; args: string[]; options?: any }> } {
	const calls: Array<{ bin: string; args: string[]; options?: any }> = [];
	const run: CommandRunner = async (bin, args, options) => {
		calls.push({ bin, args, options });
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
	await assert.rejects(
		() => pi.tools.get("herdr_agent_prompt").execute("id", { target: "sw-a", text: "hi", confirm: true }, undefined, undefined, {}),
		/writes_disabled/,
	);
	assert.equal(run.calls.length, 0);

	const enabled = setup({ writes: true });
	await assert.rejects(
		() => enabled.pi.tools.get("herdr_agent_prompt").execute("id", { target: "sw-a", text: "hi" }, undefined, undefined, {}),
		/confirmation_required/,
	);
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
	assert.ok(run.calls[0].options.timeoutMs > 100, "the process timeout outlives the CLI wait");
});

test("a real wait: true prompt outlives PI_HERDR_TIMEOUT_MS", async () => {
	const dir = mkdtempSync(join(tmpdir(), "herdr-test-"));
	const bin = join(dir, "herdr");
	writeFileSync(bin, '#!/bin/sh\nsleep 0.4\nprintf \'%s\\n\' \'{"result":{"submitted":true}}\'\n');
	chmodSync(bin, 0o755);
	try {
		const pi = fakePi();
		registerHerdr(pi as any, { config: { ...baseConfig, herdrBin: bin, timeoutMs: 100, writes: true } });
		const result = await pi.tools.get("herdr_agent_prompt").execute(
			"id",
			{ target: "sw-a", text: "hi", wait: true, timeoutMs: 60000, confirm: true },
			undefined,
			undefined,
			{},
		);
		assert.deepEqual(result.structuredContent, { target: "sw-a", result: { submitted: true } });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("prompt text that starts with -- cannot become an option", async () => {
	const { pi, run } = setup({ writes: true }, () => JSON.stringify({ result: { submitted: true } }));
	await pi.tools.get("herdr_agent_prompt").execute("id", { target: "sw-a", text: "--wait", wait: true, confirm: true }, undefined, undefined, {});
	assert.equal(run.calls[0].args[3], " --wait");
	assert.ok(run.calls[0].args.slice(4).includes("--wait"), "the real wait flag is still passed");
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
	assert.deepEqual(run.calls[0].args, ["add", "--desc=desc", "--delegate", "--after=r/1", "--json", "--", "B"]);
});

test("board titles and messages that start with -- are data", async () => {
	const { pi, run } = setup({ writes: true }, () => JSON.stringify({ id: "r/2", state: "todo", title: "--delegate" }));
	await pi.tools.get("herdr_board_add").execute("id", { title: "--delegate", confirm: true }, undefined, undefined, {});
	assert.deepEqual(run.calls[0].args, ["add", "--json", "--", "--delegate"]);
	await pi.tools.get("herdr_board_tell").execute("id", { id: "r/2", text: "--msg hi", confirm: true }, undefined, undefined, {});
	assert.deepEqual(run.calls[1].args, ["tell", "--json", "--", "r/2", "--msg hi"]);
});

test("a failed CLI call rejects instead of resolving", async () => {
	const pi = fakePi();
	const run: CommandRunner = async () => ({ code: 1, stdout: "", stderr: "socket gone", timedOut: false, aborted: false });
	registerHerdr(pi as any, { config: baseConfig, run });
	await assert.rejects(
		() => pi.tools.get("herdr_workspace_list").execute("id", {}, undefined, undefined, {}),
		/herdr_failed: socket gone/,
	);
});

test("an exposure override is applied to every tool", () => {
	const { pi } = setup({ exposure: "direct" });
	for (const name of TOOL_NAMES) assert.equal(pi.tools.get(name).exposure, "direct");
});
