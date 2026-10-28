#!/usr/bin/env node
// The Watcher bench: run the board's own Watcher prompt through headless pi on LFM3-1.7B and grade
// what comes back. One pi process per case, exactly the one-shot the board uses (`-p`, no session,
// no tools, no skills, no context files), with this extension loaded.
//
//   node extensions/lfm3/bench/watcher.ts [--model lfm3/lfm3-1.7b] [--out rows.jsonl]
//
// Needs the CPU servers from README.md. Writes one JSON row per case and prints the summary.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { watcherBaseline, type WatcherCase } from "./baseline.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const EXT = join(REPO, "extensions/lfm3/index.ts");
const SYSTEM = "You write short status lines for a dashboard that shows coding agents at work. You reply with JSON only.";

/** Keep the public rows free of the machine's own paths. */
export function sanitize(text: string): string {
	return text.replaceAll(REPO, "<repo>").replace(/\/home\/[^/\s]+/g, "~");
}

export function watcherPrompt(c: WatcherCase): string {
	const about: string = (c.desc ?? "").slice(0, 800);
	const part = [
		"--- 1 ---",
		c.role === "reviewer"
			? "This one is an adversarial reviewer checking finished work. Estimate progress through this review only, not through the agent's task."
			: "This one is a coding agent working on a task.",
		`Task: ${c.title}`,
	];
	if (about) part.push("What the task asks for:", about);
	part.push(`The ${c.role === "reviewer" ? "reviewer has been on this review" : "agent has been on this"} for ${c.mins} minutes.`);
	part.push(
		c.prev == null
			? "This is your first look at it."
			: `Your previous guess was ${c.prev} percent. Keep it unless something on the screen is a reason to change it. Raise it as work gets done. Lower it when new work shows up: ${
					c.role === "reviewer" ? "more to check than it looked" : "a failing test, a merge conflict, review findings to fix, a bigger job than it looked"
				}`,
	);
	part.push(`The last lines on the ${c.role}'s terminal right now:`, c.tail);
	return [
		"You are watching an agent at work. Write its status for a dashboard.",
		"The percent is the share of the whole job's time that is already spent: the dashboard works out the minutes left from it and the time spent so far, so do not guess high while much is left to do.",
		part.join("\n"),
		"--- end ---",
		'Each status line is written like these examples: "Updating file locations and running checks", "Waiting for the PR review on GitHub", "Fixing the two failing tests".',
		'Reply with only this JSON and nothing else: [{"n": <the number above>, "msg": "<what it is doing right now: at most 8 plain words, present tense, no tool or command names>", "progress": <whole number 0 to 99: your best guess of how far through its current assignment it is>}]',
	].join("\n");
}

interface Run {
	text: string;
	ms: number;
	usage?: unknown;
	code: number | null;
	stderr: string;
}

function piBin(): string {
	const local = join(REPO, "node_modules/.bin/pi");
	if (existsSync(local)) return local;
	return "pi";
}

async function runPi(prompt: string, model: string, agentDir: string, timeoutMs: number): Promise<Run> {
	const args = [
		"-p",
		"--mode",
		"json",
		"--offline",
		"--no-session",
		"--no-tools",
		"--no-skills",
		"--no-context-files",
		"--no-extensions",
		"-e",
		EXT,
		"--model",
		model,
		"--thinking",
		"off",
		"--append-system-prompt",
		SYSTEM,
		prompt,
	];
	const t0 = Date.now();
	return await new Promise((resolve) => {
		const child = spawn(piBin(), args, { cwd: REPO, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_LFM3: "on" }, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
		}, timeoutMs);
		child.stdout.on("data", (d) => (stdout += d));
		child.stderr.on("data", (d) => (stderr += d));
		child.on("close", (code) => {
			clearTimeout(timer);
			const events = stdout
				.split("\n")
				.filter(Boolean)
				.map((line) => {
					try {
						return JSON.parse(line);
					} catch {
						return null;
					}
				})
				.filter(Boolean);
			const end = events.filter((e: any) => e.type === "turn_end").at(-1) as any;
			const text = end?.message?.content?.filter((b: any) => b.type === "text").map((b: any) => b.text).join("") ?? "";
			resolve({ text, ms: Date.now() - t0, usage: end?.message?.usage, code, stderr: stderr.slice(-1000) });
		});
	});
}

/** The first JSON array or object in a reply, or null. */
export function parseWatcherJson(text: string): { n?: number; msg?: string; progress?: number } | null {
	for (const [open, close] of [
		["[", "]"],
		["{", "}"],
	] as const) {
		const a = text.indexOf(open);
		const b = text.lastIndexOf(close);
		if (a < 0 || b <= a) continue;
		try {
			const value = JSON.parse(text.slice(a, b + 1));
			const one = Array.isArray(value) ? value[0] : value;
			if (one && typeof one === "object") return one;
		} catch {
			// keep trying the other bracket
		}
	}
	return null;
}

export interface WatcherRow {
	id: string;
	role: string;
	ms: number;
	jsonOk: boolean;
	nOk: boolean;
	msgOk: boolean;
	progressOk: boolean;
	words: number | null;
	msg: string | null;
	progress: number | null;
	want: string;
	range: [number, number];
	baseline: { msg: string; msgOk: boolean; progress: number; progressOk: boolean };
	text: string;
	usage?: unknown;
	code: number | null;
	error?: string;
}

async function main() {
	const argv = process.argv.slice(2);
	const arg = (name: string, fallback: string) => {
		const i = argv.indexOf(name);
		return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
	};
	const model = arg("--model", "lfm3/lfm3-1.7b");
	const out = arg("--out", join(REPO, "extensions/lfm3/bench/results/watcher.jsonl"));
	const timeoutMs = Number(arg("--timeout-ms", "60000"));
	const cases = JSON.parse(readFileSync(new URL("./cases/watcher.json", import.meta.url), "utf8")) as WatcherCase[];
	const agentDir = mkdtempSync(join(tmpdir(), "lfm3-watcher-"));
	const rows: WatcherRow[] = [];
	try {
		for (const c of cases) {
			const run = await runPi(watcherPrompt(c), model, agentDir, timeoutMs);
			const parsed = parseWatcherJson(run.text);
			const jsonOk = !!parsed && typeof parsed.msg === "string" && Number.isFinite(Number(parsed.progress));
			const nOk = jsonOk && Number(parsed!.n) === 1;
			const msgOk = jsonOk && new RegExp(c.want, "i").test(parsed!.msg!);
			const progress = jsonOk ? Number(parsed!.progress) : null;
			const progressOk = progress !== null && progress >= c.range[0] && progress <= c.range[1];
			const words = jsonOk ? parsed!.msg!.trim().split(/\s+/).length : null;
			const b = watcherBaseline(c);
			const row: WatcherRow = {
				id: c.id,
				role: c.role,
				ms: run.ms,
				jsonOk,
				nOk,
				msgOk,
				progressOk,
				words,
				msg: parsed?.msg ? sanitize(parsed.msg) : null,
				progress,
				want: c.want,
				range: c.range,
				baseline: { msg: b.msg, msgOk: new RegExp(c.want, "i").test(b.msg), progress: b.progress, progressOk: b.progress >= c.range[0] && b.progress <= c.range[1] },
				text: sanitize(run.text).slice(0, 600),
				usage: run.usage,
				code: run.code,
				error: run.stderr || undefined,
			};
			rows.push(row);
			const mark = row.jsonOk && row.nOk && row.msgOk && row.progressOk ? "pass" : "FAIL";
			console.log(`${mark.padEnd(4)} ${c.id.padEnd(16)} ${String(row.ms).padStart(6)} ms  msg=${JSON.stringify(row.msg)} progress=${row.progress} n=${parsed?.n}`);
		}
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
	writeFileSync(out, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
	const n = rows.length;
	const pct = (k: keyof WatcherRow) => `${rows.filter((r) => r[k]).length}/${n}`;
	const med = (values: number[]) => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];
	const p90 = (values: number[]) => values.slice().sort((a, b) => a - b)[Math.floor(values.length * 0.9)];
	const summary = {
		cases: n,
		json: pct("jsonOk"),
		n: pct("nOk"),
		msg: pct("msgOk"),
		progress: pct("progressOk"),
		baselineMsg: `${rows.filter((r) => r.baseline.msgOk).length}/${n}`,
		baselineProgress: `${rows.filter((r) => r.baseline.progressOk).length}/${n}`,
		medianMs: med(rows.map((r) => r.ms)),
		p90Ms: p90(rows.map((r) => r.ms)),
		out,
	};
	console.log(JSON.stringify(summary, null, 1));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
