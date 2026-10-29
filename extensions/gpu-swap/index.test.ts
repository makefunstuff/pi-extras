// gpu-swap against a fake systemctl (test-fixtures/systemctl.mjs, units in a JSON file) and fake
// health endpoints (local HTTP servers that answer 200 once their unit has been active for its load
// time). Two "sessions" are two Swappers with their own ids on the same lease file.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { fakeCtx, fakePi } from "../../test/lib/fake-pi.ts";
import { DEFAULT_BACKENDS, loadConfig, type GpuSwapConfig } from "./config.ts";
import gpuSwap from "./index.ts";
import { readLease, withLease } from "./lease.ts";
import { Swapper } from "./swap.ts";

const FAKE_SYSTEMCTL = join(dirname(fileURLToPath(import.meta.url)), "test-fixtures", "systemctl.mjs");
const ROUTER = "local-ai-router.service";
const STRATA = "strata.service";
const KEY = "test-key";

interface Units {
	active: Record<string, number>;
	log: string[];
	failStart?: string[];
	conflicts?: Record<string, string[]>;
	loadMs: Record<string, number>;
}

let dir: string;
let stateFile: string;
let servers: Server[] = [];
let healthHits: Record<string, string[]>;

const units = (): Units => JSON.parse(readFileSync(stateFile, "utf8"));
const setUnits = (patch: Partial<Units>) => writeFileSync(stateFile, JSON.stringify({ ...units(), ...patch }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function healthServer(unit: string, needsKey: boolean): Promise<string> {
	const server = createServer((req, res) => {
		(healthHits[unit] ??= []).push(req.headers.authorization ?? "");
		if (needsKey && req.headers.authorization !== `Bearer ${KEY}`) return void res.writeHead(401).end();
		const s = units();
		const since = s.active[unit];
		res.writeHead(since && Date.now() - since >= (s.loadMs[unit] ?? 0) ? 200 : 503).end();
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	servers.push(server);
	return `http://127.0.0.1:${(server.address() as { port: number }).port}/health`;
}

async function makeConfig(over: Partial<GpuSwapConfig> = {}): Promise<GpuSwapConfig> {
	return {
		enabled: true,
		defaultBackend: "router",
		backends: {
			router: { ...DEFAULT_BACKENDS.router, health: await healthServer(ROUTER, false) },
			strata: { ...DEFAULT_BACKENDS.strata, health: await healthServer(STRATA, true) },
		},
		providers: { strata: "strata", "llama.cpp": "router" },
		readyTimeoutMs: 3_000,
		leaseWaitMs: 3_000,
		idleMs: 60_000,
		heartbeatMs: 60_000,
		staleMs: 60_000,
		pollMs: 25,
		leaseFile: join(dir, "lease", "lease.json"),
		systemctl: FAKE_SYSTEMCTL,
		...over,
	};
}

const deps = (statuses: string[] = []) => ({
	apiKey: async (provider: string) => (provider === "strata" ? KEY : undefined),
	status: (t: string | undefined) => void (t && statuses.push(t)),
});

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "gpu-swap-test-"));
	stateFile = join(dir, "units.json");
	healthHits = {};
	writeFileSync(
		stateFile,
		JSON.stringify({ active: { [ROUTER]: 1 }, log: [], loadMs: { [STRATA]: 200, [ROUTER]: 0 }, conflicts: { [ROUTER]: [STRATA], [STRATA]: [ROUTER] } }),
	);
	process.env.FAKE_SYSTEMCTL_STATE = stateFile;
});

afterEach(async () => {
	await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
	servers = [];
});

test("swap: stops the router, starts Strata, and waits until it answers (with its API key)", async () => {
	const statuses: string[] = [];
	const s = new Swapper(await makeConfig(), deps(statuses), "a");
	const t0 = Date.now();
	await s.ensure("strata");
	assert.ok(Date.now() - t0 >= 200, "returned only after the load time");
	assert.deepEqual(units().log.filter((l) => !l.startsWith("is-active")), [`stop ${ROUTER}`, `start ${STRATA}`]);
	assert.ok(units().active[STRATA] && !units().active[ROUTER]);
	assert.ok(healthHits[STRATA].includes(`Bearer ${KEY}`), "health check sends the provider's key");
	assert.match(statuses[0], /^Loading Strata… ~90 s/);
	const lease = readLease((s.config as GpuSwapConfig).leaseFile);
	assert.equal(lease.backend, "strata");
	assert.equal(lease.switching, undefined);
	assert.equal(lease.sessions.a.backend, "strata");
});

test("no swap when the needed backend already answers", async () => {
	const s = new Swapper(await makeConfig(), deps(), "a");
	await s.ensure("router");
	assert.deepEqual(units().log, []);
	assert.equal(readLease(s.config.leaseFile).backend, "router");
});

test("timeout: a backend that never answers fails with a clear error and leaves the lease unswitched", async () => {
	const config = await makeConfig({ readyTimeoutMs: 300 });
	setUnits({ loadMs: { [STRATA]: 60_000 } });
	const s = new Swapper(config, deps(), "a");
	await assert.rejects(s.ensure("strata"), /Strata did not answer http:\/\/127\.0\.0\.1:\d+\/health within 0\.3 s/);
	const lease = readLease(config.leaseFile);
	assert.equal(lease.switching, undefined);
	assert.equal(lease.backend, "strata", "its unit may still be up");
	assert.equal(lease.sessions.a.backend, undefined, "but nobody claims it");
	// so the next heartbeat stops it and the router comes back
	assert.equal(await s.maintain(), "strata");
	assert.ok(units().active[ROUTER] && !units().active[STRATA]);
});

test("Esc stops a request's wait at once, even when it joined the warm-up; the warm-up goes on", async () => {
	const config = await makeConfig();
	setUnits({ loadMs: { [STRATA]: 600 } });
	const s = new Swapper(config, deps(), "a");
	const warm = s.ensure("strata");
	const esc = new AbortController();
	const req = s.ensure("strata", esc.signal);
	setTimeout(() => esc.abort(), 100);
	const t0 = Date.now();
	await assert.rejects(req, /aborted/);
	assert.ok(Date.now() - t0 < 300);
	await warm;
	assert.ok(units().active[STRATA]);
});

test("Esc with no warm-up cancels the swap's wait too", async () => {
	const config = await makeConfig({ leaseWaitMs: 5_000 });
	const b = new Swapper(config, deps(), "b");
	await b.ensure("router");
	const a = new Swapper(config, deps(), "a");
	const esc = new AbortController();
	const req = a.ensure("strata", esc.signal);
	setTimeout(() => esc.abort(), 100);
	await assert.rejects(req, /aborted/);
	await sleep(100);
	assert.ok(!units().log.includes(`start ${STRATA}`), "no Strata start after the wait was given up");
});

test("picking another model during a warm-up cancels it instead of waiting on itself", async () => {
	const config = await makeConfig();
	setUnits({ loadMs: { [STRATA]: 5_000 } });
	const statuses: string[] = [];
	const s = new Swapper(config, deps(statuses), "a");
	const warm = s.ensure("strata");
	await sleep(100);
	const t0 = Date.now();
	await s.ensure("router");
	assert.ok(Date.now() - t0 < 1_000, "did not wait for the Strata load");
	await assert.rejects(warm, /aborted/);
	assert.ok(!statuses.some((t) => /another pi session/.test(t)));
	assert.ok(units().active[ROUTER] && !units().active[STRATA]);
	const lease = readLease(config.leaseFile);
	assert.equal(lease.backend, "router");
	assert.equal(lease.sessions.a.backend, "router");
});

test("a unit that stops while loading fails at once, naming the unit", async () => {
	const config = await makeConfig({ readyTimeoutMs: 5_000 });
	setUnits({ loadMs: { [STRATA]: 60_000 } });
	const s = new Swapper(config, deps(), "a");
	const p = s.ensure("strata");
	await sleep(100);
	spawnSync(FAKE_SYSTEMCTL, ["stop", STRATA]);
	const t0 = Date.now();
	await assert.rejects(p, /strata\.service stopped while Strata was loading/);
	assert.ok(Date.now() - t0 < 1_000);
});

test("lease held by another live session: waits, then fails naming the holder, and never stops it", async () => {
	const config = await makeConfig({ leaseWaitMs: 300 });
	const b = new Swapper(config, deps(), "b");
	await b.ensure("router"); // b uses the 27B on the router
	const statuses: string[] = [];
	const a = new Swapper(config, deps(statuses), "a");
	await assert.rejects(a.ensure("strata"), (e: Error) => {
		assert.match(e.message, /cannot load Strata: the GPUs are held by the llama\.cpp router for another pi session \(pid \d+, last request \d+ s ago\)/);
		assert.match(e.message, /never takes them from a live session/);
		return true;
	});
	assert.ok(statuses.some((t) => /^GPUs busy: llama\.cpp router in use by another pi session/.test(t)));
	assert.ok(!units().log.includes(`stop ${ROUTER}`), "the router was not stopped");
	assert.ok(units().active[ROUTER]);
});

test("a held lease is taken once the other session's claim goes idle", async () => {
	const config = await makeConfig({ idleMs: 300, leaseWaitMs: 3_000 });
	const b = new Swapper(config, deps(), "b");
	await b.ensure("router");
	const a = new Swapper(config, deps(), "a");
	const t0 = Date.now();
	await a.ensure("strata");
	assert.ok(Date.now() - t0 >= 250, "waited for b's idle time");
	assert.ok(units().active[STRATA]);
});

test("a busy session keeps its claim past the idle time", async () => {
	const config = await makeConfig({ idleMs: 100, leaseWaitMs: 400 });
	const b = new Swapper(config, deps(), "b");
	await b.ensure("router");
	b.markBusy(true); // a long request still running
	await sleep(150);
	const a = new Swapper(config, deps(), "a");
	await assert.rejects(a.ensure("strata"), /held by the llama\.cpp router/);
	b.markBusy(false);
});

test("idle switch-back: once nobody used Strata for the idle time, the router comes back", async () => {
	const config = await makeConfig({ idleMs: 200 });
	const a = new Swapper(config, deps(), "a");
	await a.ensure("strata");
	assert.equal(await a.maintain(), undefined, "still within the idle time");
	assert.ok(units().active[STRATA]);
	await sleep(250);
	assert.equal(await a.maintain(), "strata");
	assert.ok(units().active[ROUTER] && !units().active[STRATA]);
	assert.deepEqual(units().log.filter((l) => !l.startsWith("is-active")).slice(-2), [`stop ${STRATA}`, `start ${ROUTER}`]);
	const lease = readLease(config.leaseFile);
	assert.equal(lease.backend, "router");
	assert.equal(lease.switching, undefined);
});

test("no switch-back while another live session still uses Strata", async () => {
	const config = await makeConfig({ idleMs: 300 });
	const a = new Swapper(config, deps(), "a");
	const b = new Swapper(config, deps(), "b");
	await a.ensure("strata");
	await b.ensure("strata");
	assert.equal(await a.maintain(true), undefined, "a quits, b still uses it");
	assert.ok(units().active[STRATA]);
	assert.equal(await b.maintain(true), "strata", "the last session quits: switch back now");
	assert.ok(units().active[ROUTER]);
	assert.deepEqual(readLease(config.leaseFile).sessions, {});
});

test("stale lease cleanup: a dead process or an old heartbeat no longer blocks", async () => {
	const config = await makeConfig({ staleMs: 500, leaseWaitMs: 200 });
	const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]).stdout.toString();
	withLease(config.leaseFile, (lease) => {
		lease.backend = "router";
		lease.sessions.gone = { pid: Number(dead), backend: "router", heartbeat: Date.now(), lastUsed: Date.now(), busy: true };
		lease.sessions.silent = { pid: process.pid, backend: "router", heartbeat: Date.now() - 10_000, lastUsed: Date.now(), busy: true };
		lease.switching = { to: "router", by: "gone", since: Date.now() };
	});
	const a = new Swapper(config, deps(), "a");
	await a.ensure("strata");
	const lease = readLease(config.leaseFile);
	assert.deepEqual(Object.keys(lease.sessions), ["a"]);
	assert.equal(lease.backend, "strata");
});

test("two sessions needing Strata at once start it only once", async () => {
	const config = await makeConfig();
	const a = new Swapper(config, deps(), "a");
	const b = new Swapper(config, deps(), "b");
	await Promise.all([a.ensure("strata"), b.ensure("strata")]);
	assert.equal(units().log.filter((l) => l === `start ${STRATA}`).length, 1);
});

test("extension: model_select warms up, before_provider_request waits, quit switches back", async () => {
	const config = await makeConfig();
	const pi = fakePi();
	gpuSwap(pi as any, { config });
	const statuses: Array<string | undefined> = [];
	const ctx = fakeCtx({
		model: { provider: "strata", id: "swift" },
		signal: undefined,
		sessionManager: { getSessionId: () => "s1" },
		modelRegistry: { getApiKeyForProvider: async (p: string) => (p === "strata" ? KEY : undefined) },
	});
	ctx.ui.setStatus = (_k: string, t: string | undefined) => void statuses.push(t);
	await pi.emit("session_start", { type: "session_start" }, ctx);
	await pi.emit("model_select", { type: "model_select", model: { provider: "strata", id: "swift" }, source: "set" }, ctx);
	await sleep(100); // typing
	assert.ok(units().log.includes(`start ${STRATA}`), "the swap started on model_select");
	const t0 = Date.now();
	await pi.emit("before_provider_request", { type: "before_provider_request", payload: {} }, ctx);
	assert.ok(units().active[STRATA]);
	assert.ok(Date.now() - t0 < 400, "the request joined the warm-up instead of starting again");
	assert.equal(units().log.filter((l) => l === `start ${STRATA}`).length, 1);
	assert.ok(statuses.some((t) => t?.startsWith("Loading Strata")));
	assert.equal(statuses.at(-1), undefined, "status cleared");
	await pi.emit("agent_end", { type: "agent_end" }, ctx);

	// a cloud model: left alone
	await pi.emit("model_select", { type: "model_select", model: { provider: "deepseek", id: "x" }, source: "set" }, ctx);
	await pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
	assert.ok(units().active[ROUTER] && !units().active[STRATA], "router back after the last session quit");
});

test("extension: a request that times out reports the error and stops the turn", async () => {
	const config = await makeConfig({ readyTimeoutMs: 200 });
	setUnits({ loadMs: { [STRATA]: 60_000 } });
	const pi = fakePi();
	gpuSwap(pi as any, { config });
	const ctx = fakeCtx({
		model: { provider: "strata", id: "swift" },
		sessionManager: { getSessionId: () => "s1" },
		modelRegistry: { getApiKeyForProvider: async () => KEY },
	});
	let aborted = 0;
	ctx.abort = () => void aborted++;
	await pi.emit("before_provider_request", { type: "before_provider_request", payload: {} }, ctx);
	assert.equal(aborted, 1, "pi ignores a throw here, so the turn is aborted");
	assert.ok(ctx.notes.some((n: any) => n.level === "error" && /Strata did not answer/.test(n.message)));
});

test("extension: off by default, and unmapped providers are never touched", async () => {
	const pi = fakePi();
	gpuSwap(pi as any, { config: { ...(await makeConfig()), enabled: false } });
	assert.equal(pi.handlers.size, 0);
	const on = fakePi();
	gpuSwap(on as any, { config: await makeConfig() });
	const ctx = fakeCtx({ model: { provider: "openrouter", id: "x" } });
	await on.emit("before_provider_request", { type: "before_provider_request", payload: {} }, ctx);
	assert.deepEqual(units().log, []);
});

test("config: file and env, no built-in addresses", () => {
	const file = join(dir, "gpu-swap.json");
	writeFileSync(
		file,
		JSON.stringify({
			enabled: true,
			backends: { strata: { health: "http://h:1/v1/models" }, basalt: { unit: "basalt.service", label: "Basalt", health: "http://h:2/v1/models" } },
			providers: { basalt: "basalt", nope: "missing" },
			idleMinutes: 5,
			readyTimeoutSeconds: 120,
		}),
	);
	const warnings: string[] = [];
	const c = loadConfig({ PI_GPU_SWAP_CONFIG: file, PI_GPU_SWAP_HEALTH_ROUTER: "http://h:3/health", XDG_RUNTIME_DIR: dir }, (m) => warnings.push(m));
	assert.equal(c.enabled, true);
	assert.equal(c.idleMs, 300_000);
	assert.equal(c.readyTimeoutMs, 120_000);
	assert.equal(c.backends.strata.unit, "strata.service");
	assert.equal(c.backends.strata.health, "http://h:1/v1/models");
	assert.equal(c.backends.router.health, "http://h:3/health");
	assert.equal(c.providers.basalt, "basalt");
	assert.equal(c.providers.nope, undefined);
	assert.ok(warnings.some((w) => /unknown backend "missing"/.test(w)));
	assert.equal(c.leaseFile, join(dir, "pi-gpu-swap", "lease.json"));

	const d = loadConfig({ PI_GPU_SWAP_CONFIG: join(dir, "absent.json") });
	assert.equal(d.enabled, false);
	assert.equal(d.idleMs, 600_000);
	for (const b of Object.values(d.backends)) assert.equal(b.health, undefined, "no address is built in");
});

const extCtx = (provider: string) => {
	const ctx = fakeCtx({
		model: { provider, id: "m" },
		sessionManager: { getSessionId: () => "s1" },
		modelRegistry: { getApiKeyForProvider: async (p: string) => (p === "strata" ? KEY : undefined) },
	});
	return ctx;
};

test("extension: quitting while Strata still loads gives up the swap and brings the router back", async () => {
	const config = await makeConfig();
	setUnits({ loadMs: { [STRATA]: 60_000 } });
	const pi = fakePi();
	gpuSwap(pi as any, { config });
	const ctx = extCtx("strata");
	await pi.emit("model_select", { type: "model_select", model: { provider: "strata", id: "m" }, source: "set" }, ctx);
	await sleep(150);
	assert.ok(units().active[STRATA]);
	await pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
	assert.ok(units().active[ROUTER] && !units().active[STRATA], "router back at once");
	const lease = readLease(config.leaseFile);
	assert.deepEqual(lease.sessions, {});
	assert.equal(lease.switching, undefined);
	assert.equal(lease.backend, "router");
});

test("extension: a model pick during a run waits for the stream; the next request swaps", async () => {
	const config = await makeConfig();
	const pi = fakePi();
	gpuSwap(pi as any, { config });
	const ctx = extCtx("strata");
	await pi.emit("agent_start", { type: "agent_start" }, ctx);
	await pi.emit("before_provider_request", { type: "before_provider_request", payload: {} }, ctx);
	assert.ok(units().active[STRATA]);
	// the user picks the 27B while Strata still streams
	ctx.model = { provider: "llama.cpp", id: "qwen3.8-27b" };
	await pi.emit("model_select", { type: "model_select", model: ctx.model, source: "set" }, ctx);
	await sleep(150);
	assert.ok(units().active[STRATA] && !units().log.includes(`stop ${STRATA}`), "Strata not stopped under the stream");
	// pi uses the new model for the run's next turn: that request swaps
	await pi.emit("before_provider_request", { type: "before_provider_request", payload: {} }, ctx);
	assert.ok(units().active[ROUTER] && !units().active[STRATA]);
	await pi.emit("agent_end", { type: "agent_end" }, ctx);
	await pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
});

test("extension: picking a cloud model during a warm-up cancels it, and switch-back restores the router", async () => {
	const config = await makeConfig();
	setUnits({ loadMs: { [STRATA]: 60_000 } });
	const pi = fakePi();
	gpuSwap(pi as any, { config });
	const ctx = extCtx("strata");
	await pi.emit("model_select", { type: "model_select", model: { provider: "strata", id: "m" }, source: "cycle" }, ctx);
	await sleep(100);
	ctx.model = { provider: "deepseek", id: "x" };
	await pi.emit("model_select", { type: "model_select", model: ctx.model, source: "cycle" }, ctx);
	await sleep(100);
	const lease = readLease(config.leaseFile);
	assert.equal(lease.switching, undefined, "warm-up given up");
	assert.equal(lease.sessions[String(process.pid)].backend, undefined, "no claim left on Strata");
	await pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
	assert.ok(units().active[ROUTER] && !units().active[STRATA]);
});
