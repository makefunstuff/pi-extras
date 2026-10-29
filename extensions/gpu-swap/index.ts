// gpu-swap: picking a model swaps the GPU backend it needs.
//
// Strata and the llama.cpp router (or any backends set in the config) cannot hold the GPUs at the
// same time. When a picked model's provider needs the other backend, the swap starts at once, so
// loading overlaps typing; the next provider request waits until that backend answers, with a
// status line. A lease file shared by every pi session on the machine records who uses which
// backend, so a session never takes the GPUs from another live one. Once nobody has used the
// non-default backend for the idle time (or its last session ends), the default one comes back.
//
// Off by default: PI_GPU_SWAP=on or {"enabled": true} in <agent dir>/gpu-swap.json.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { backendFor, configPath, loadConfig, type GpuSwapConfig } from "./config.ts";
import { readLease } from "./lease.ts";
import { isAbort, Swapper } from "./swap.ts";

export const STATUS_KEY = "gpu-swap";
export const COMMAND = "gpu-swap";

export interface GpuSwapOptions {
	config?: GpuSwapConfig;
}

export default function gpuSwap(pi: ExtensionAPI, options: GpuSwapOptions = {}) {
	const warnings: string[] = [];
	const config = options.config ?? loadConfig(process.env, (m) => warnings.push(m));
	if (!config.enabled) return;

	let swapper: Swapper | undefined;
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	let ui: ExtensionContext["ui"] | undefined;
	// The model of the running agent loop: pi keeps it for the whole run even if another model is
	// picked meanwhile, so its requests must keep their backend. A pick during a run warms up after it.
	let runModel: ExtensionContext["model"];
	let pendingWarm: string | undefined;

	const status = (text: string | undefined) => ui?.setStatus(STATUS_KEY, text);
	const notify = (message: string, level: "info" | "warning" | "error") => ui?.notify(message, level);

	const session = (ctx: ExtensionContext): Swapper => {
		ui = ctx.ui;
		if (!swapper) {
			swapper = new Swapper(config, {
				apiKey: (provider) => ctx.modelRegistry.getApiKeyForProvider(provider),
				status,
			});
		}
		return swapper;
	};

	const startHeartbeat = (s: Swapper) => {
		if (heartbeat) return;
		heartbeat = setInterval(() => {
			s.maintain().then(
				(from) => from && notify(`gpu-swap: ${s.label(from)} idle; ${s.label(config.defaultBackend)} is back`, "info"),
				(e) => notify(`gpu-swap: ${(e as Error).message}`, "warning"),
			);
		}, config.heartbeatMs);
		heartbeat.unref?.();
	};

	pi.on("session_start", (_event, ctx) => {
		for (const w of warnings.splice(0)) notify(w, "warning");
		ui = ctx.ui;
		startHeartbeat(session(ctx));
	});

	// Warm-up: start the swap now, so loading overlaps typing. Errors surface here and again on the request.
	const warm = (s: Swapper, target: string) => s.ensure(target).catch((e) => !isAbort(e) && notify((e as Error).message, "error"));

	pi.on("model_select", (event, ctx) => {
		const target = backendFor(config, event.model?.provider);
		pendingWarm = undefined;
		if (!target) return;
		const s = session(ctx);
		startHeartbeat(s);
		if (runModel) pendingWarm = target; // never stop the backend under a running turn
		else warm(s, target);
	});

	pi.on("agent_start", (_event, ctx) => {
		runModel = ctx.model;
	});

	// Awaited by pi before each provider request: hold the request until its backend answers.
	pi.on("before_provider_request", async (_event, ctx) => {
		const target = backendFor(config, (runModel ?? ctx.model)?.provider);
		if (!target) return undefined;
		const s = session(ctx);
		startHeartbeat(s);
		try {
			s.markBusy(true);
			await s.ensure(target, ctx.signal);
		} catch (e) {
			// pi catches a throw here and sends the request anyway, so stop the turn instead.
			if (!ctx.signal?.aborted) {
				notify((e as Error).message, "error");
				ctx.abort();
			}
		}
		return undefined;
	});

	pi.on("agent_end", () => {
		runModel = undefined;
		if (!swapper) return;
		swapper.markBusy(false);
		if (pendingWarm) warm(swapper, pendingWarm);
		pendingWarm = undefined;
	});

	// pi quits: drop this process from the lease, and if it was the last user of the non-default
	// backend, switch back now. On /new, /resume, /fork or /reload the process (and its claim) stays.
	pi.on("session_shutdown", async (event) => {
		if (heartbeat) clearInterval(heartbeat);
		heartbeat = undefined;
		const s = swapper;
		swapper = undefined;
		if (!s) return;
		await s.cancel(); // a swap still loading is given up (its backend is left in the lease for switch-back)
		if (event.reason === "quit") await s.maintain(true).catch(() => undefined);
	});

	pi.registerCommand(COMMAND, {
		description: "Show which GPU backend holds the GPUs, which pi sessions use it, and the gpu-swap settings",
		handler: async (_args: string, ctx) => {
			const s = session(ctx);
			const lease = readLease(config.leaseFile);
			const now = Date.now();
			const health = await Promise.all(Object.keys(config.backends).map(async (n) => `${n}: ${(await s.healthy(n)) ? "answers" : "down"}`));
			const lines = [
				`gpu-swap on (config: ${configPath()}, lease: ${config.leaseFile})`,
				`holder: ${s.label(lease.backend)}${lease.switching ? ` (switching to ${s.label(lease.switching.to)})` : ""}`,
				`backends: ${health.join(", ")}`,
				...Object.entries(lease.sessions).map(
					([id, e]) => `  ${id === s.id ? "this session" : `pid ${e.pid}`}: ${s.label(e.backend)}${e.busy ? ", busy" : ""}, last request ${Math.round((now - e.lastUsed) / 1000)} s ago`,
				),
				`providers: ${Object.entries(config.providers).map(([p, b]) => `${p} -> ${b}`).join(", ")}; idle ${Math.round(config.idleMs / 60_000)} min`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
