import assert from "node:assert/strict";
import { test } from "node:test";
import type { HerdrConfig } from "./config.ts";
import type { CommandResult, CommandRunner } from "./exec.ts";
import { ToolError } from "./errors.ts";
import { listAgents, listPanes, listTabs, listWorkspaces, promptAgent, readAgent, readPane } from "./herdr.ts";
import { boardAdd, boardDetails, boardList, boardReport, boardShow, boardTell } from "./board.ts";

const config: HerdrConfig = {
	herdrBin: "herdr",
	boardBin: "herdr-projects",
	writes: false,
	exposure: "codemode",
	timeoutMs: 1000,
	maxOutput: 100_000,
	stuckModel: { provider: "lfm3", id: "d1-2b" },
};

interface Call {
	bin: string;
	args: string[];
	options?: any;
}

function runner(handler: (call: Call) => Partial<CommandResult> | string): CommandRunner & { calls: Call[] } {
	const calls: Call[] = [];
	const run: CommandRunner = async (bin, args, options) => {
		const call = { bin, args, options };
		calls.push(call);
		const result = handler(call);
		if (typeof result === "string") return { code: 0, stdout: result, stderr: "", timedOut: false, aborted: false };
		return { code: 0, stdout: "", stderr: "", timedOut: false, aborted: false, ...result };
	};
	return Object.assign(run, { calls });
}

test("agent list is unwrapped and filtered", async () => {
	const run = runner(() => ({
		stdout: JSON.stringify({
			id: "cli:agent:list",
			result: {
				agents: [
					{ name: "sw-a", agent: "pi", agent_status: "blocked", pane_id: "w1:p1", title: "Fix it", focused: false, workspace_id: "w1" },
					{ name: "sw-b", agent: "claude", agent_status: "working", pane_id: "w2:p1", title: "Review", focused: true, workspace_id: "w2" },
				],
			},
		}),
	}));
	const agents = await listAgents(config, run, { status: "blocked" });
	assert.equal(agents.length, 1);
	assert.equal(agents[0].name, "sw-a");
	assert.equal(agents[0].status, "blocked");
	assert.equal(agents[0].paneId, "w1:p1");
	assert.deepEqual(run.calls[0].args, ["agent", "list"]);
});

test("agent read asks for the source and line count, and returns text", async () => {
	const run = runner(() => "line one\nline two\n");
	const read = await readAgent(config, run, "sw-a", { lines: 12, source: "recent-unwrapped" });
	assert.equal(read.text, "line one\nline two\n");
	assert.deepEqual(run.calls[0].args, ["agent", "read", "sw-a", "--source", "recent-unwrapped", "--lines", "12"]);
});

test("a herdr error envelope becomes a typed error", async () => {
	const run = runner(() => ({
		code: 1,
		stdout: JSON.stringify({ id: "cli:agent:get", error: { code: "agent_not_found", message: "agent target nope not found" } }),
	}));
	await assert.rejects(
		() => listAgents(config, run),
		(error: unknown) => error instanceof ToolError && error.code === "agent_not_found" && /nope/.test(error.message),
	);
});

test("workspaces, panes and tabs map their snake_case fields", async () => {
	const run = runner(({ args }) => {
		if (args[0] === "workspace") return { stdout: JSON.stringify({ result: { workspaces: [{ workspace_id: "wA", label: "ops", focused: true, pane_count: 2, tab_count: 1 }] } }) };
		if (args[0] === "pane") return { stdout: JSON.stringify({ result: { panes: [{ pane_id: "wA:p1", workspace_id: "wA", agent_status: "idle", focused: false }] } }) };
		return { stdout: JSON.stringify({ result: { tabs: [{ tab_id: "wA:t1", workspace_id: "wA", title: "one", number: 1 }] } }) };
	});
	const workspaces = await listWorkspaces(config, run);
	assert.deepEqual(workspaces[0], { id: "wA", label: "ops", focused: true, paneCount: 2, tabCount: 1 });
	const panes = await listPanes(config, run, { workspace: "wA" });
	assert.equal(panes[0].id, "wA:p1");
	assert.equal(panes[0].agentStatus, "idle");
	const tabs = await listTabs(config, run, { workspace: "wA" });
	assert.equal(tabs[0].title, "one");
	assert.deepEqual(run.calls[1].args, ["pane", "list", "--workspace", "wA"]);
	assert.deepEqual(run.calls[2].args, ["tab", "list", "--workspace", "wA"]);
});

test("pane read is plain text", async () => {
	const run = runner(() => "hello\n");
	const read = await readPane(config, run, "wA:p1");
	assert.equal(read.text, "hello\n");
	assert.deepEqual(run.calls[0].args, ["pane", "read", "wA:p1", "--source", "recent", "--lines", "80"]);
});

test("prompt passes wait, until and timeout", async () => {
	const run = runner(() => ({ stdout: JSON.stringify({ result: { submitted: true } }) }));
	const result = await promptAgent(config, run, "sw-a", "do it", { wait: true, until: ["idle", "blocked"], timeoutMs: 5000 });
	assert.deepEqual(result, { target: "sw-a", result: { submitted: true } });
	assert.deepEqual(run.calls[0].args, ["agent", "prompt", "sw-a", "do it", "--wait", "--until", "idle", "--until", "blocked", "--timeout", "5000"]);
});

test("board list passes its filters and --json, and returns the array", async () => {
	const run = runner(() => ({ stdout: JSON.stringify([{ id: "r/1", state: "working", title: "A" }]) }));
	const tasks = await boardList(config, run, { archived: true, all: true, query: "fix" });
	assert.equal(tasks.length, 1);
	assert.deepEqual(run.calls[0].args, ["list", "--archived", "--all", "--query", "fix", "--json"]);
	assert.equal(run.calls[0].bin, "herdr-projects");
});

test("board details and show request JSON", async () => {
	const run = runner(({ args }) => ({ stdout: JSON.stringify(args[0] === "details" ? { task: { id: "r/1" } } : { settings: [{ name: "merge.by", value: "you" }] }) }));
	assert.deepEqual(await boardDetails(config, run, "r/1"), { task: { id: "r/1" } });
	assert.deepEqual(await boardShow(config, run, "r/1"), { settings: [{ name: "merge.by", value: "you" }] });
	assert.deepEqual(run.calls[0].args, ["details", "r/1", "--json"]);
	assert.deepEqual(run.calls[1].args, ["show", "r/1", "--json"]);
});

test("board write commands build the documented flags", async () => {
	const run = runner(() => ({ stdout: JSON.stringify({ id: "r/2", state: "todo", title: "B" }) }));
	assert.equal((await boardAdd(config, run, "B", { description: "desc", repo: "r", delegate: true, after: ["r/1"], research: true })).id, "r/2");
	assert.deepEqual(run.calls[0].args, ["add", "B", "--desc", "desc", "--repo", "r", "--delegate", "--after", "r/1", "--research", "--json"]);
	await boardTell(config, run, "r/2", "hello");
	assert.deepEqual(run.calls[1].args, ["tell", "r/2", "hello", "--json"]);
	await boardReport(config, run, "r/2", { state: "blocked", kind: "question", msg: "Need a login", progress: 50.4, eta: 3 });
	assert.deepEqual(run.calls[2].args, ["report", "r/2", "--state", "blocked", "--kind", "question", "--msg", "Need a login", "--progress", "50", "--eta", "3", "--json"]);
});

test("a missing board binary is explained", async () => {
	await assert.rejects(
		() => boardList({ ...config, boardBin: undefined }, async () => ({ code: 0, stdout: "[]", stderr: "", timedOut: false, aborted: false })),
		(error: unknown) => error instanceof ToolError && error.code === "board_not_found",
	);
});

test("a board's plain-text failure becomes a tool error", async () => {
	const run = runner(() => ({ code: 1, stdout: "No task r/nope", stderr: "" }));
	await assert.rejects(
		() => boardDetails(config, run, "r/nope"),
		(error: unknown) => error instanceof ToolError && error.code === "board_failed" && /No task/.test(error.message),
	);
});
