// The lease: one JSON file every pi session on the machine shares. It records which backend holds
// the GPUs and which sessions use it. Each change is a read-modify-write under a lock directory
// (mkdir is atomic), and the file is replaced by rename, so a reader never sees half a file.
//
// A session's claim on a backend lasts while its heartbeat is fresh (and its process is alive) and
// it has sent a request within the idle time, or one is still running. Entries whose heartbeat is
// stale or whose process is gone are dropped by the next session that touches the file.
import { mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface SessionEntry {
	pid: number;
	/** Backend this session last acquired (its claim is on this one). */
	backend?: string;
	/** Last heartbeat (ms since epoch). */
	heartbeat: number;
	/** Last request start or end. */
	lastUsed: number;
	/** A request is running now. */
	busy?: boolean;
}

export interface Lease {
	/** Backend that holds the GPUs, as far as the sessions know. */
	backend?: string;
	/** A switch in progress: who started it, and when. */
	switching?: { to: string; by: string; since: number };
	sessions: Record<string, SessionEntry>;
}

export interface LeaseTiming {
	idleMs: number;
	staleMs: number;
	/** A switch older than this is treated as abandoned. */
	switchMs: number;
}

const LOCK_STALE_MS = 15_000;

function sleepSync(ms: number) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

export function readLease(file: string): Lease {
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		if (parsed && typeof parsed === "object" && parsed.sessions && typeof parsed.sessions === "object") return parsed as Lease;
	} catch {}
	return { sessions: {} };
}

/**
 * Run `fn` on the lease under the lock and write back what it leaves. Synchronous on purpose: the
 * lock is held for microseconds and never across an await.
 */
export function withLease<T>(file: string, fn: (lease: Lease) => T): T {
	const lock = `${file}.lock`;
	mkdirSync(dirname(file), { recursive: true });
	const deadline = Date.now() + 10_000;
	for (;;) {
		try {
			mkdirSync(lock);
			break;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
			try {
				if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmdirSync(lock); // a crashed holder
			} catch {}
			if (Date.now() > deadline) throw new Error(`gpu-swap: lease lock ${lock} is held too long`);
			sleepSync(10);
		}
	}
	try {
		const lease = readLease(file);
		const result = fn(lease);
		const tmp = `${file}.${process.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(lease, null, 2)}\n`);
		renameSync(tmp, file);
		return result;
	} finally {
		try {
			rmdirSync(lock);
		} catch {}
	}
}

/** Drop entries whose heartbeat is stale or whose process is gone, and an abandoned switch. Returns the dropped ids. */
export function prune(lease: Lease, timing: LeaseTiming, now = Date.now()): string[] {
	const dropped: string[] = [];
	for (const [id, s] of Object.entries(lease.sessions)) {
		if (now - s.heartbeat > timing.staleMs || !pidAlive(s.pid)) {
			delete lease.sessions[id];
			dropped.push(id);
		}
	}
	const sw = lease.switching;
	if (sw && (!lease.sessions[sw.by] || now - sw.since > timing.switchMs)) delete lease.switching;
	return dropped;
}

export function claimActive(s: SessionEntry, backend: string, timing: LeaseTiming, now = Date.now()): boolean {
	return s.backend === backend && (!!s.busy || now - s.lastUsed < timing.idleMs);
}

/** Sessions other than `self` with an active claim on `backend`. */
export function claimants(lease: Lease, backend: string, timing: LeaseTiming, self?: string, now = Date.now()): Array<[string, SessionEntry]> {
	return Object.entries(lease.sessions).filter(([id, s]) => id !== self && claimActive(s, backend, timing, now));
}
