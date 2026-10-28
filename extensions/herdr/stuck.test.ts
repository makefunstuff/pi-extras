import assert from "node:assert/strict";
import { test } from "node:test";
import type { HerdrConfig } from "./config.ts";
import type { CommandRunner } from "./exec.ts";
import { agentStuck, type ClassifierRegistryLike } from "./stuck.ts";

const config: HerdrConfig = {
	herdrBin: "herdr",
	boardBin: "herdr-projects",
	writes: false,
	exposure: "codemode",
	timeoutMs: 1000,
	maxOutput: 100_000,
	stuckModel: { provider: "lfm3", id: "d1-2b" },
};

function herdrRun(status = "blocked", output = "Do you want to continue? [y/N]"): CommandRunner {
	return async (_bin, args) => {
		if (args[0] === "agent" && args[1] === "list") {
			return {
				code: 0,
				stdout: JSON.stringify({ result: { agents: [{ name: "sw-a", agent: "pi", agent_status: status, pane_id: "w1:p1", focused: false }] } }),
				stderr: "",
				timedOut: false,
				aborted: false,
			};
		}
		return { code: 0, stdout: output + "\n", stderr: "", timedOut: false, aborted: false };
	};
}

function registry(probability: { stuck: number; waiting: number }, stopReason = "stop"): ClassifierRegistryLike & { seen?: any } {
	const seen: any = {};
	return {
		seen,
		getModelOfType(type, provider, id) {
			assert.equal(type, "classifier");
			return provider === "lfm3" && id === "d1-2b" ? { provider, id } : undefined;
		},
		async classify(model: unknown, context: any) {
			seen.model = model;
			seen.context = context;
			if (stopReason !== "stop") return { stopReason, errorMessage: "connection refused" };
			return {
				stopReason,
				answers: {
					stuck: { type: "bool", probability: probability.stuck },
					waiting: { type: "bool", probability: probability.waiting },
				},
			};
		},
	};
}

test("the classifier decides when it is registered", async () => {
	const reg = registry({ stuck: 0.91, waiting: 0.87 });
	const result = await agentStuck({ config, run: herdrRun(), registry: reg }, "sw-a");
	assert.equal(result.source, "classifier");
	assert.equal(result.model, "lfm3/d1-2b");
	assert.equal(result.stuck, true);
	assert.equal(result.waiting, true);
	assert.ok(result.confidence && result.confidence > 0.8);
	assert.equal(reg.seen.context.state.status, "blocked");
	assert.match(reg.seen.context.state.recentOutput, /continue/);
});

test("with no classifier the answer is herdr's status alone", async () => {
	const result = await agentStuck({ config, run: herdrRun("blocked") }, "sw-a");
	assert.equal(result.source, "status");
	assert.equal(result.stuck, true);
	assert.equal(result.waiting, true);
	assert.match(result.reason, /not registered/);
});

test("idle and done fall back to not stuck", async () => {
	for (const [status, stuck] of [
		["idle", false],
		["done", false],
		["working", false],
	] as const) {
		const result = await agentStuck({ config, run: herdrRun(status) }, "sw-a");
		assert.equal(result.stuck, stuck, status);
		assert.equal(result.source, "status");
	}
});

test("a classifier that is down falls back to status and says why", async () => {
	const result = await agentStuck({ config, run: herdrRun("blocked"), registry: registry({ stuck: 0, waiting: 0 }, "error") }, "sw-a");
	assert.equal(result.source, "status");
	assert.equal(result.stuck, true);
	assert.match(result.reason, /classifier failed/);
});

test("an unknown target is a typed error", async () => {
	await assert.rejects(
		() => agentStuck({ config, run: herdrRun() }, "nobody"),
		(error: unknown) => (error as any)?.code === "agent_not_found",
	);
});

test("turning the model off keeps the status fallback", async () => {
	const result = await agentStuck({ config: { ...config, stuckModel: undefined }, run: herdrRun(), registry: registry({ stuck: 1, waiting: 1 }) }, "sw-a");
	assert.equal(result.source, "status");
	assert.equal(result.stuck, true);
});
