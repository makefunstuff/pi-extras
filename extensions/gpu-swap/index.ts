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
	// A pick during an agent run must not stop the backend under a stream still running: its warm-up
	// waits for the run's end. The run's next request (pi switches models between turns) still swaps.
	let running = false;
	let pendingWarm: string | undefined;

	const status = (text: string | undefined) => {
		try {
			ui?.setStatus(STATUS_KEY, text);
		} catch {}
	};
	const notify = (message: string, level: "info" | "warning" | "error") => {
		try {
			ui?.notify(message, level);
		} catch {} // a ctx pi has already replaced
	};

	const session = (ctx: ExtensionContext): Swapper => {
		ui = ctx.ui;
		if (!swapper) {
			// The registry itself, not ctx: pi invalidates ctx on /new or /reload while a warm-up still runs.
			const registry = ctx.modelRegistry;
			swapper = new Swapper(config, {
				apiKey: async (provider) => registry.getApiKeyForProvider(provider),
				status,
			});
		}
		return swapper;
	};

	const startHeartbeat = (s: Swapper) => {
		if (heartbeat) return;
		let lastWarning = "";
		heartbeat = setInterval(() => {
			s.maintain().then(
				(from) => {
					lastWarning = "";
					if (from) notify(`gpu-swap: ${s.label(from)} idle; ${s.label(config.defaultBackend)} is back`, "info");
				},
				(e) => {
					const m = `gpu-swap: ${(e as Error).message}`;
					if (m !== lastWarning) notify(m, "warning"); // once, not every heartbeat
					lastWarning = m;
				},
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
		if (!target) {
			// A cloud pick: give up a warm-up nobody needs now (switch-back stops what it started).
			void swapper?.cancel();
			return;
		}
		const s = session(ctx);
		startHeartbeat(s);
		if (running) pendingWarm = target;
		else warm(s, target);
	});

	pi.on("agent_start", () => {
		running = true;
	});

	// Awaited by pi before each provider request: hold the request until its backend answers.
	pi.on("before_provider_request", async (_event, ctx) => {
		// A newer model pick can cancel the swap this request waits on: then wait for the current model's.
		for (let attempt = 0; attempt < 3; attempt++) {
			const target = backendFor(config, ctx.model?.provider);
			if (!target) return undefined;
			const s = session(ctx);
			startHeartbeat(s);
			try {
				s.markBusy(true);
				await s.ensure(target, ctx.signal);
				return undefined;
			} catch (e) {
				if (ctx.signal?.aborted) return undefined; // Esc
				if (isAbort(e)) continue;
				// pi catches a throw here and sends the request anyway, so stop the turn instead.
				notify((e as Error).message, "error");
				ctx.abort();
				return undefined;
			}
		}
		return undefined;
	});

	pi.on("agent_end", () => {
		running = false;
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
		if (event.reason !== "quit") return; // a swap in flight goes on, its claim with it
		await s.cancel(); // a swap still loading is given up (its backend is left in the lease for switch-back)
		await s.maintain(true).catch(() => undefined);
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
