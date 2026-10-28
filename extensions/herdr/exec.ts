// One CLI invocation, without a shell: the tools pass an argument vector, never a command string,
// so a task title or an agent name can never become shell syntax.
import { spawn } from "node:child_process";

export interface RunOptions {
	timeoutMs?: number;
	maxOutput?: number;
	env?: NodeJS.ProcessEnv;
	cwd?: string;
	signal?: AbortSignal;
}

export interface CommandResult {
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	aborted: boolean;
	/** Set when the program could not be started at all (ENOENT and the like). */
	error?: string;
}

export type CommandRunner = (bin: string, args: string[], options?: RunOptions) => Promise<CommandResult>;

function append(current: string, chunk: Buffer, limit: number): string {
	if (current.length >= limit) return current;
	const next = current + chunk.toString("utf8");
	return next.length > limit ? next.slice(0, limit) + "\n… output truncated (PI_HERDR_MAX_OUTPUT)" : next;
}

/** Spawn a program and collect its output, with a timeout and a hard output cap. */
export const runCommand: CommandRunner = (bin, args, options = {}) =>
	new Promise((resolve) => {
		const limit = options.maxOutput ?? 1_000_000;
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let aborted = false;
		let settled = false;
		let child;
		try {
			child = spawn(bin, args, {
				cwd: options.cwd,
				env: options.env ? { ...process.env, ...options.env } : process.env,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (e) {
			resolve({ code: null, stdout: "", stderr: "", timedOut: false, aborted: false, error: (e as Error).message });
			return;
		}

		const finish = (code: number | null, error?: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			resolve({ code, stdout, stderr, timedOut, aborted, error });
		};
		const stop = () => {
			if (!child.killed) child.kill("SIGKILL");
		};
		const onAbort = () => {
			aborted = true;
			stop();
		};
		const timer = setTimeout(() => {
			timedOut = true;
			stop();
		}, options.timeoutMs ?? 20_000);

		if (options.signal?.aborted) onAbort();
		else options.signal?.addEventListener("abort", onAbort, { once: true });

		child.stdout?.on("data", (chunk: Buffer) => (stdout = append(stdout, chunk, limit)));
		child.stderr?.on("data", (chunk: Buffer) => (stderr = append(stderr, chunk, limit)));
		child.on("error", (e: NodeJS.ErrnoException) => finish(null, e.code === "ENOENT" ? `${bin} was not found` : e.message));
		child.on("close", (code) => finish(code));
	});

/** JSON from a command, or undefined when the output is not JSON. */
export function parseJson(text: string): unknown {
	const trimmed = text.trim();
	if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) return undefined;
	try {
		return JSON.parse(trimmed);
	} catch {
		return undefined;
	}
}
