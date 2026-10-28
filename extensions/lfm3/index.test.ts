import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fakeCtx, fakePi } from "../../test/lib/fake-pi.ts";
import { classifySystemOne, formatAnswer, parseAnswers, probeServer, wireQuestions, type FetchLike } from "./client.ts";
import { configPath, DEFAULTS, loadConfig, normalizeBaseUrl } from "./config.ts";
import extension, { CHAT_MODEL, D1_MODEL, PROVIDER } from "./index.ts";

const tmp = mkdtempSync(join(tmpdir(), "lfm3-test-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

function fakeFetch(handler: (url: string, init?: any) => { status?: number; body?: unknown; text?: string }) {
	const calls: Array<{ url: string; init?: any }> = [];
	const fetchImpl: FetchLike = async (url, init) => {
		calls.push({ url, init });
		const r = handler(url, init);
		const body = r.text ?? JSON.stringify(r.body ?? {});
		return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, text: async () => body, json: async () => JSON.parse(body) };
	};
	return { fetch: fetchImpl, calls };
}

test("config: off by default, environment and file, environment wins", () => {
	assert.equal(loadConfig({}).enabled, false);
	assert.equal(loadConfig({}).baseUrl, DEFAULTS.baseUrl);
	assert.equal(loadConfig({ PI_LFM3: "on" }).enabled, true);
	assert.equal(loadConfig({ PI_LFM3: "off" }).enabled, false);
	assert.equal(loadConfig({ PI_LFM3: "yes" }).enabled, true, "any value that is not off is on");
	assert.equal(loadConfig({ PI_LFM3_URL: "http://127.0.0.1:9999/" }).baseUrl, "http://127.0.0.1:9999");
	assert.equal(loadConfig({ PI_LFM3_URL: "not a url" }).baseUrl, DEFAULTS.baseUrl);
	assert.equal(loadConfig({ PI_LFM3_TOOL: "off" }).tool, false);

	const file = join(tmp, "lfm3.json");
	writeFileSync(file, JSON.stringify({ enabled: true, d1Url: "http://127.0.0.1:1234", tool: false }));
	assert.equal(configPath({ PI_LFM3_CONFIG: file }), file);
	const c = loadConfig({ PI_LFM3_CONFIG: file });
	assert.equal(c.enabled, true);
	assert.equal(c.d1Url, "http://127.0.0.1:1234");
	assert.equal(c.tool, false);
	const env = loadConfig({ PI_LFM3_CONFIG: file, PI_LFM3_D1_URL: "http://127.0.0.1:5678" });
	assert.equal(env.d1Url, "http://127.0.0.1:5678", "environment wins over the file");
});

test("config: a broken file is ignored with a warning", () => {
	const file = join(tmp, "broken.json");
	writeFileSync(file, "{nope");
	const warnings: string[] = [];
	const c = loadConfig({ PI_LFM3_CONFIG: file }, (m) => warnings.push(m));
	assert.equal(c.enabled, false);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /ignoring/);
});

test("normalizeBaseUrl keeps http(s) and drops trailing slashes", () => {
	assert.equal(normalizeBaseUrl("http://127.0.0.1:18181///", "x"), "http://127.0.0.1:18181");
	assert.equal(normalizeBaseUrl("https://box.lan:8080", "x"), "https://box.lan:8080");
	assert.equal(normalizeBaseUrl("ftp://box", "x"), "x");
	assert.equal(normalizeBaseUrl("", "x"), "x");
});

test("wireQuestions maps bool to noul and keeps choice criteria", () => {
	assert.deepEqual(
		wireQuestions({
			stuck: { type: "bool", instructions: "Stuck?", criteria: { true: "yes", false: "no" } },
			team: { type: "choice", instructions: "Team?", criteria: { billing: "Charges", tech: "App faults" } },
		}),
		{
			stuck: { type: "noul", instructions: "Stuck?", criteria: { true: "yes", false: "no" } },
			team: { type: "choice", instructions: "Team?", criteria: { billing: "Charges", tech: "App faults" } },
		},
	);
});

test("parseAnswers reads bool, choice and score with probabilities", () => {
	const answers = parseAnswers(
		{
			stuck: { type: "noul", noul: 0.99 },
			team: { type: "choice", choice: "billing", probabilities: { billing: 0.9, tech: 0.1 }, confidence: 0.9 },
			urgency: { type: "score", score: 1.2, confidence: 0.7 },
		},
		{
			stuck: { type: "bool", instructions: "" },
			team: { type: "choice", instructions: "", criteria: { billing: "", tech: "" } },
			urgency: { type: "score", instructions: "", criteria: ["low", "high"] },
		},
	);
	assert.deepEqual(answers.stuck, { type: "bool", probability: 0.99 });
	assert.equal(answers.team.type === "choice" && answers.team.choice, "billing");
	assert.equal(answers.urgency.type === "score" && answers.urgency.score, 1.2);
	assert.throws(() => parseAnswers({}, { q: { type: "bool", instructions: "" } }), /no answer for q/);
});

test("formatAnswer shows a bool as yes/no with its probability", () => {
	assert.equal(formatAnswer({ type: "bool", probability: 0.87 }), "yes (0.87)");
	assert.equal(formatAnswer({ type: "bool", probability: 0.12 }), "no (0.12)");
	assert.match(formatAnswer({ type: "choice", choice: "billing", probabilities: { billing: 0.9, tech: 0.1 }, confidence: 0.9 }), /^billing \(0\.90; tech 0\.10\)$/);
});

test("classifySystemOne posts to /v1/systemone and reads the answers", async () => {
	const { fetch, calls } = fakeFetch(() => ({
		body: {
			answers: {
				stuck: { type: "noul", noul: 0.97 },
				team: { type: "choice", choice: "billing", probabilities: { billing: 0.91, tech: 0.09 }, confidence: 0.91 },
			},
			usage: { input_tokens: 120, output_tokens: 0 },
		},
	}));
	const r = await classifySystemOne(
		{ provider: "lfm3", id: "d1-2b", baseUrl: "http://127.0.0.1:18182/v1" },
		{
			state: { terminal: "waiting" },
			questions: {
				stuck: { type: "bool", instructions: "Stuck?" },
				team: { type: "choice", instructions: "Team?", criteria: { billing: "Charges", tech: "Faults" } },
			},
		},
		{ fetch, timeoutMs: 1000 },
	);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, "http://127.0.0.1:18182/v1/systemone");
	const body = JSON.parse(calls[0].init.body);
	assert.equal(body.model, "d1-2b");
	assert.deepEqual(body.state, { terminal: "waiting" });
	assert.equal(body.questions.stuck.type, "noul");
	assert.equal(body.questions.team.type, "choice");
	assert.equal(r.stopReason, "stop");
	assert.deepEqual(r.answers.stuck, { type: "bool", probability: 0.97 });
	assert.equal(r.usage?.input, 120);
	assert.equal(r.usage?.totalTokens, 120);
});

test("classifySystemOne turns a down server, a 500 and bad JSON into an error result", async () => {
	const down = await classifySystemOne({ provider: "lfm3", id: "d1-2b", baseUrl: "http://127.0.0.1:1/v1" }, { state: "x", questions: { q: { type: "bool", instructions: "?" } } }, { fetch: async () => { throw new Error("connect ECONNREFUSED"); } });
	assert.equal(down.stopReason, "error");
	assert.match(down.errorMessage!, /ECONNREFUSED/);

	const { fetch } = fakeFetch(() => ({ status: 500, body: { error: "boom" } }));
	const five = await classifySystemOne({ provider: "lfm3", id: "d1-2b", baseUrl: "http://127.0.0.1:18182/v1" }, { state: "x", questions: { q: { type: "bool", instructions: "?" } } }, { fetch });
	assert.equal(five.stopReason, "error");
	assert.match(five.errorMessage!, /HTTP 500/);

	const bad = await classifySystemOne(
		{ provider: "lfm3", id: "d1-2b", baseUrl: "http://127.0.0.1:18182/v1" },
		{ state: "x", questions: { q: { type: "bool", instructions: "?" } } },
		{ fetch: async () => ({ ok: true, status: 200, text: async () => "not json", json: async () => ({}) }) },
	);
	assert.equal(bad.stopReason, "error");
	assert.match(bad.errorMessage!, /invalid JSON/);
});

test("probeServer reads /health", async () => {
	const ok = await probeServer("http://127.0.0.1:18182/", { fetch: fakeFetch(() => ({ body: { status: "ok" } })).fetch });
	assert.deepEqual(ok, { ok: true, detail: "ok" });
	const no = await probeServer("http://127.0.0.1:18182", { fetch: fakeFetch(() => ({ status: 503, body: {} })).fetch });
	assert.equal(no.ok, false);
	assert.match(no.detail, /HTTP 503/);
});

function setup(config = { ...DEFAULTS, enabled: true }, fetchImpl?: FetchLike) {
	const pi = fakePi();
	extension(pi as any, { config, fetch: fetchImpl });
	return pi;
}

test("off by default: no provider and no tool, but the command is there", () => {
	const pi = setup({ ...DEFAULTS, enabled: false });
	assert.equal(pi.providers.size, 0);
	assert.equal(pi.tools.size, 0);
	assert.ok(pi.commands.has("lfm3"));
});

test("enabled: registers the chat model and the d1 classifier", () => {
	const pi = setup();
	const provider = pi.providers.get(PROVIDER);
	assert.ok(provider, "provider registered");
	assert.equal(provider.baseUrl, "http://127.0.0.1:18181/v1");
	assert.equal(provider.api, "openai-completions");
	const chat = provider.models.find((m: any) => m.type === "chat");
	const d1 = provider.models.find((m: any) => m.type === "classifier");
	assert.equal(chat.id, CHAT_MODEL);
	assert.equal(chat.reasoning, true);
	assert.equal(chat.maxTokens, 2048);
	assert.equal(d1.id, D1_MODEL);
	assert.equal(d1.api, "typesafe-system-one");
	assert.equal(d1.baseUrl, "http://127.0.0.1:18182/v1");
	assert.ok(provider.classifiers["typesafe-system-one"].classify);
	assert.ok(pi.tools.has("lfm3_decide"));
});

test("the tool asks the classifier and formats the answers", async () => {
	const pi = setup();
	const tool = pi.tools.get("lfm3_decide");
	const classified: any[] = [];
	const ctx = fakeCtx({
		modelRegistry: {
			getModelOfType: () => ({ provider: PROVIDER, id: D1_MODEL, baseUrl: "http://127.0.0.1:18182/v1" }),
			classify: async (_model: any, context: any) => {
				classified.push(context);
				return {
					stopReason: "stop",
					answers: {
						blocking: { type: "bool", probability: 0.93 },
						kind: { type: "choice", choice: "bug", probabilities: { bug: 0.8, feature: 0.2 }, confidence: 0.8 },
					},
					usage: { input: 80, output: 0 },
				};
			},
		},
	});
	const result = await tool.execute("t1", {
		state: "The fallback is never tested.",
		questions: [
			{ id: "blocking", type: "bool", instructions: "Is it blocking?" },
			{ id: "kind", type: "choice", instructions: "What kind?", options: ["bug", "feature"] },
		],
	}, undefined, undefined, ctx);
	assert.equal(classified.length, 1);
	assert.deepEqual(classified[0].questions.kind, { type: "choice", instructions: "What kind?", criteria: { bug: "bug", feature: "feature" } });
	assert.match(result.content[0].text, /blocking: yes \(0\.93\)/);
	assert.match(result.content[0].text, /kind: bug \(0\.80/);
	assert.equal(result.details.fallback, undefined);
});

test("the tool falls back when the classifier is missing or the server is down", async () => {
	const pi = setup();
	const tool = pi.tools.get("lfm3_decide");
	const missing = fakeCtx({ modelRegistry: { getModelOfType: () => undefined } });
	const a = await tool.execute("t1", { state: "x", questions: [{ id: "q", type: "bool", instructions: "?" }] }, undefined, undefined, missing);
	assert.equal(a.details.fallback, true);
	assert.match(a.content[0].text, /not registered/);

	const down = fakeCtx({
		modelRegistry: {
			getModelOfType: () => ({}),
			classify: async () => ({ stopReason: "error", errorMessage: "connect ECONNREFUSED", answers: {} }),
		},
	});
	const b = await tool.execute("t2", { state: "x", questions: [{ id: "q", type: "bool", instructions: "?" }] }, undefined, undefined, down);
	assert.equal(b.details.fallback, true);
	assert.match(b.content[0].text, /ECONNREFUSED/);
	assert.match(b.content[0].text, /own judgement/);
});

test("a choice question without options is refused before any request", async () => {
	const pi = setup();
	const tool = pi.tools.get("lfm3_decide");
	const ctx = fakeCtx({ modelRegistry: { getModelOfType: () => { throw new Error("must not be called"); } } });
	const r = await tool.execute("t1", { state: "x", questions: [{ id: "q", type: "choice", instructions: "?" }] }, undefined, undefined, ctx);
	assert.match(r.content[0].text, /at least two options/);
});

test("/lfm3 reports both servers and /lfm3 off unregisters the provider", async () => {
	const { fetch } = fakeFetch(() => ({ body: { status: "ok" } }));
	const pi = setup({ ...DEFAULTS, enabled: true }, fetch);
	const notes: string[] = [];
	const ctx = fakeCtx({ ui: { notify: (m: string) => notes.push(m), setStatus: () => {}, confirm: async () => false, select: async () => undefined, input: async () => undefined } });
	const command = pi.commands.get("lfm3");
	await command.handler("", ctx);
	assert.match(notes.at(-1)!, /lfm3 on/);
	assert.match(notes.at(-1)!, /chat  http:\/\/127\.0\.0\.1:18181 — ok/);
	assert.match(notes.at(-1)!, /d1    http:\/\/127\.0\.0\.1:18182 — ok/);
	await command.handler("off", ctx);
	assert.equal(pi.providers.size, 0);
	assert.match(notes.at(-1)!, /lfm3 off/);
	await command.handler("on", ctx);
	assert.ok(pi.providers.has(PROVIDER), "on registers again");
});

test("/lfm3 on from the off state registers the provider and the tool", async () => {
	const { fetch } = fakeFetch(() => ({ body: { status: "ok" } }));
	const pi = setup({ ...DEFAULTS, enabled: false, tool: true }, fetch);
	assert.equal(pi.providers.size, 0);
	assert.equal(pi.tools.size, 0);
	const ctx = fakeCtx();
	await pi.commands.get("lfm3").handler("on", ctx);
	assert.ok(pi.providers.has(PROVIDER));
	assert.ok(pi.tools.has("lfm3_decide"), "the tool follows the switch");
});
