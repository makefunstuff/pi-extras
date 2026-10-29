// The swap itself, free of pi: given a backend a request needs, make it the one that holds the GPUs
// and wait until it answers, without ever taking the GPUs from another live session; and switch back
// to the default backend once nobody uses the other one.
import { execFile } from "node:child_process";
import type { BackendConfig, GpuSwapConfig } from "./config.ts";
import { claimActive, prune, withLease, type Lease, type LeaseTiming, type SessionEntry } from "./lease.ts";

export interface SwapDeps {
	/** API key of a pi provider, sent with health checks (Strata's endpoint needs one). */
	apiKey?: (provider: string) => Promise<string | undefined>;
	/** The status line: text while waiting, undefined to clear it. */
	status?: (text: string | undefined) => void;
}

export class SwapError extends Error {}

const ABORTED = "gpu-swap: aborted";
/** The wait was given up (Esc, or a newer model pick), not a failure to report. */
export const isAbort = (e: unknown) => e instanceof SwapError && e.message === ABORTED;

type Decision =
	| { kind: "ready" }
	| { kind: "wait"; text: string }
	| { kind: "blocked"; holder: string; by: SessionEntry[] }
	| { kind: "switch"; from?: string };

const COMMAND_TIMEOUT_MS = 120_000;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new SwapError(ABORTED));
		const t = setTimeout(done, ms);
		function done() {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}
		function onAbort() {
			clearTimeout(t);
			reject(new SwapError(ABORTED));
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function run(argv: string[], timeoutMs = COMMAND_TIMEOUT_MS): Promise<{ ok: boolean; out: string }> {
	return new Promise((resolve) => {
		execFile(argv[0], argv.slice(1), { timeout: timeoutMs }, (error, stdout, stderr) => {
			const out = `${stdout}${stderr}`.trim();
			resolve({ ok: !error, out: error && !out ? error.message : out });
		});
	});
}

/** `p`, or a rejection as soon as `signal` aborts (the work behind `p` goes on). */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal, onAbort: () => void): Promise<T> {
	if (signal.aborted) {
		onAbort();
		return Promise.reject(new SwapError(ABORTED));
	}
	return new Promise((resolve, reject) => {
		const abort = () => {
			onAbort();
			reject(new SwapError(ABORTED));
		};
		signal.addEventListener("abort", abort, { once: true });
		p.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

interface Inflight {
	promise: Promise<void>;
	controller: AbortController;
	/** Callers that can give up (a request with its signal). */
	waiters: number;
	/** A caller that never gives up (the warm-up). */
	kept: boolean;
}

const secs = (ms: number) => `${Number((ms / 1000).toFixed(ms < 10_000 ? 1 : 0))} s`;
const ago = (ms: number) => (ms < 90_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);

export class Swapper {
	readonly id: string;
	private inflight = new Map<string, Inflight>();
	private timing: LeaseTiming;

	/** `id` names this pi process in the lease (one entry per process, so /new or /resume keeps its claim). */
	readonly config: GpuSwapConfig;
	private deps: SwapDeps;

	constructor(config: GpuSwapConfig, deps: SwapDeps = {}, id = String(process.pid)) {
		this.config = config;
		this.deps = deps;
		this.id = id;
		this.timing = { idleMs: config.idleMs, staleMs: config.staleMs, switchMs: config.readyTimeoutMs + Math.max(COMMAND_TIMEOUT_MS, config.readyTimeoutMs) + 30_000 };
	}

	setStatus(fn: SwapDeps["status"]) {
		this.deps.status = fn;
	}

	label(name: string | undefined): string {
		return (name && this.config.backends[name]?.label) ?? name ?? "unknown";
	}

	private me(lease: Lease, now = Date.now()): SessionEntry {
		const s = (lease.sessions[this.id] ??= { pid: process.pid, heartbeat: now, lastUsed: now });
		s.heartbeat = now;
		return s;
	}

	private lease<T>(fn: (lease: Lease, now: number) => T): T {
		return withLease(this.config.leaseFile, (lease) => {
			const now = Date.now();
			prune(lease, this.timing, now);
			return fn(lease, now);
		});
	}

	/** The backend answers its health URL (or, without one, its unit is active). */
	async healthy(name: string): Promise<boolean> {
		const b = this.config.backends[name];
		if (!b) return false;
		if (!b.health) return b.unit ? (await run([this.config.systemctl, "is-active", "--quiet", b.unit], 10_000)).ok : false;
		const provider = b.authProvider ?? Object.entries(this.config.providers).find(([, n]) => n === name)?.[0];
		const key = provider ? await this.deps.apiKey?.(provider).catch(() => undefined) : undefined;
		try {
			const res = await fetch(b.health, {
				headers: key ? { authorization: `Bearer ${key}` } : {},
				signal: AbortSignal.timeout(3_000),
			});
			await res.body?.cancel();
			return res.ok;
		} catch {
			return false;
		}
	}

	private async unitDown(b: BackendConfig): Promise<boolean> {
		if (!b.unit || b.start) return false;
		const r = await run([this.config.systemctl, "is-active", b.unit], 10_000);
		return /^(failed|inactive)$/m.test(r.out);
	}

	private async switchTo(target: string, from: string | undefined, startTimeoutMs = Math.max(COMMAND_TIMEOUT_MS, this.config.readyTimeoutMs)): Promise<string[]> {
		const notes: string[] = [];
		const others = from ? [from] : Object.keys(this.config.backends);
		for (const name of others) {
			if (name === target) continue;
			const b = this.config.backends[name];
			const stop = b?.stop ?? (b?.unit ? [this.config.systemctl, "stop", b.unit] : undefined);
			if (!stop) continue;
			const r = await run(stop, Math.min(COMMAND_TIMEOUT_MS, startTimeoutMs));
			if (!r.ok) notes.push(`${stop.join(" ")}: ${r.out}`);
		}
		const b = this.config.backends[target];
		const start = b.start ?? [this.config.systemctl, "start", b.unit!];
		const r = await run(start, startTimeoutMs);
		if (!r.ok) throw new SwapError(`gpu-swap: ${start.join(" ")} failed: ${r.out}${notes.length ? `\n${notes.join("\n")}` : ""}`);
		return notes;
	}

	/**
	 * Make `target` hold the GPUs and answer, then return. Rejects with a SwapError on timeout or a
	 * held lease. A pick of another backend cancels this session's earlier swap. With `signal` the
	 * caller can stop waiting; the swap itself is cancelled only when no caller is left (a warm-up,
	 * started without a signal, always stays).
	 */
	ensure(target: string, signal?: AbortSignal): Promise<void> {
		for (const [other, e] of this.inflight) if (other !== target) e.controller.abort();
		let entry = this.inflight.get(target);
		if (!entry) {
			const controller = new AbortController();
			const earlier = Promise.allSettled([...this.inflight.values()].map((e) => e.promise));
			const promise: Promise<void> = earlier
				.then(() => this.acquire(target, controller.signal))
				.finally(() => {
					if (this.inflight.get(target)?.promise === promise) this.inflight.delete(target);
					if (!this.inflight.size) this.deps.status?.(undefined);
				});
			entry = { promise, controller, waiters: 0, kept: false };
			this.inflight.set(target, entry);
		}
		if (!signal) {
			entry.kept = true;
			return entry.promise;
		}
		const e = entry;
		e.waiters++;
		return untilAborted(e.promise, signal, () => {
			if (--e.waiters === 0 && !e.kept) e.controller.abort();
		});
	}

	private async acquire(target: string, signal?: AbortSignal): Promise<void> {
		const b = this.config.backends[target];
		if (!b) throw new SwapError(`gpu-swap: unknown backend "${target}"`);
		const started = Date.now();
		const leaseDeadline = started + this.config.leaseWaitMs;
		const loading = () => `Loading ${b.label}…${b.loadSeconds ? ` ~${b.loadSeconds} s` : ""} (${ago(Date.now() - started)})`;
		for (;;) {
			if (signal?.aborted) throw new SwapError(ABORTED);
			const healthy = await this.healthy(target);
			const d = this.lease((lease, now): Decision => {
				const me = this.me(lease, now);
				const sw = lease.switching;
				// Someone else's switch to another backend: wait for it to finish first.
				if (sw && sw.to !== target) {
					return { kind: "blocked", holder: sw.to, by: [lease.sessions[sw.by]].filter(Boolean) };
				}
				const blockers = Object.entries(lease.sessions)
					.filter(([id, s]) => id !== this.id && s.backend && s.backend !== target && claimActive(s, s.backend, this.timing, now))
					.map(([, s]) => s);
				if (healthy) {
					// It answers, so it already holds the GPUs (whatever the lease said).
					lease.backend = target;
					me.backend = target;
					me.lastUsed = now;
					return { kind: "ready" };
				}
				if (sw && sw.to === target) {
					me.backend = target;
					me.lastUsed = now;
					return { kind: "wait", text: loading() };
				}
				if (blockers.length) return { kind: "blocked", holder: blockers[0].backend!, by: blockers };
				const from = lease.backend;
				lease.switching = { to: target, by: this.id, since: now };
				lease.backend = target;
				me.backend = target;
				me.lastUsed = now;
				return { kind: "switch", from: from === target ? undefined : from };
			});

			if (d.kind === "ready") return;
			if (d.kind === "wait") {
				this.deps.status?.(d.text);
				await sleep(this.config.pollMs, signal);
				continue;
			}
			if (d.kind === "blocked") {
				const who = d.by.map((s) => `pid ${s.pid}, last request ${ago(Date.now() - s.lastUsed)} ago`).join("; ");
				const holder = this.label(d.holder);
				if (Date.now() >= leaseDeadline) {
					throw new SwapError(
						`gpu-swap: cannot load ${b.label}: the GPUs are held by the ${holder} for another pi session` +
							`${who ? ` (${who})` : ""}. gpu-swap never takes them from a live session; try again once it is idle, or pick a model on the ${holder}.`,
					);
				}
				this.deps.status?.(`GPUs busy: ${holder} in use by another pi session${who ? ` (${who})` : ""}; waiting… (${ago(Date.now() - started)})`);
				await sleep(this.config.pollMs, signal);
				continue;
			}

			// Our switch: stop the holder, start the target, wait until it answers.
			this.deps.status?.(loading());
			const timer = setInterval(() => this.deps.status?.(loading()), 1_000);
			try {
				const notes = await this.switchTo(target, d.from);
				const readyDeadline = Date.now() + this.config.readyTimeoutMs;
				for (;;) {
					if (await this.healthy(target)) break;
					if (await this.unitDown(b)) {
						throw new SwapError(`gpu-swap: ${b.unit} stopped while ${b.label} was loading (journalctl -u ${b.unit})${notes.length ? `\n${notes.join("\n")}` : ""}`);
					}
					if (Date.now() >= readyDeadline) {
						throw new SwapError(
							`gpu-swap: ${b.label} did not answer${b.health ? ` ${b.health}` : ""} within ${secs(this.config.readyTimeoutMs)}${notes.length ? `\n${notes.join("\n")}` : ""}`,
						);
					}
					await sleep(this.config.pollMs, signal);
				}
				this.lease((lease, now) => {
					if (lease.switching?.by === this.id) delete lease.switching;
					this.me(lease, now).lastUsed = now;
				});
				return;
			} catch (e) {
				this.lease((lease) => {
					if (lease.switching?.by === this.id) {
						delete lease.switching;
						// Its unit may be up (and the default one down): the switch-back stops it once nobody claims it.
						lease.backend = target;
					}
					const me = lease.sessions[this.id];
					if (me?.backend === target) delete me.backend;
				});
				throw e;
			} finally {
				clearInterval(timer);
			}
		}
	}

	/** A request is starting (true) or the agent is done (false). */
	markBusy(busy: boolean) {
		this.lease((lease, now) => {
			const me = this.me(lease, now);
			me.busy = busy;
			me.lastUsed = now;
		});
	}

	/**
	 * Heartbeat, stale-entry cleanup, and switch-back: once no live session has used the backend
	 * that holds the GPUs within the idle time, start the default one again. `leaving` removes this
	 * session first (session_shutdown).
	 */
	async maintain(leaving = false): Promise<string | undefined> {
		const def = this.config.defaultBackend;
		const from = this.lease((lease, now) => {
			if (leaving) delete lease.sessions[this.id];
			else {
				const me = this.me(lease, now);
				if (me.busy) me.lastUsed = now;
			}
			const holder = lease.backend;
			if (!holder || holder === def || !this.config.backends[def] || lease.switching) return undefined;
			if (Object.values(lease.sessions).some((s) => claimActive(s, holder, this.timing, now))) return undefined;
			if (leaving) this.me(lease, now); // the switch needs an owner while it runs
			lease.switching = { to: def, by: this.id, since: now };
			lease.backend = def;
			return holder;
		});
		if (!from) return undefined;
		try {
			// On quit pi waits for this with its screen already gone: keep it short.
			await this.switchTo(def, from, leaving ? 30_000 : undefined);
		} catch (e) {
			this.lease((lease) => {
				if (lease.switching?.by === this.id) lease.backend = from; // try again on the next heartbeat
			});
			throw e;
		} finally {
			this.lease((lease) => {
				if (lease.switching?.by === this.id) delete lease.switching;
				if (leaving) delete lease.sessions[this.id];
			});
		}
		return from;
	}
}
