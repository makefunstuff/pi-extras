#!/usr/bin/env node
// The classification bench: headless pi loads this extension and a bench-only collector; the
// collector asks d1-2B every case through pi's real classifier registry and writes the rows.
//
//   node extensions/lfm3/bench/classify.ts [--out rows.jsonl]
//
// Needs the d1-2B CPU server from README.md. Prints the accuracy, the same-case rule baseline,
// and the latency percentiles.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyBaseline, type ClassifyCase } from "./baseline.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const EXT = join(REPO, "extensions/lfm3/index.ts");
const COLLECT = join(REPO, "extensions/lfm3/bench/collect.ts");

function piBin(): string {
	const local = join(REPO, "node_modules/.bin/pi");
	return existsSync(local) ? local : "pi";
}

interface Row {
	id: string;
	kind: string;
	label: boolean | string;
	got: boolean | string | number | null;
	ok: boolean;
	ms: number;
	stopReason: string;
	errorMessage?: string;
	answers?: unknown;
	usage?: unknown;
}

async function runCollector(out: string, agentDir: string, timeoutMs: number) {
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
		"-e",
		COLLECT,
		"--model",
		"lfm3/lfm3-1.7b",
		"--thinking",
		"off",
		"benchmark",
	];
	return await new Promise<{ code: number | null; stderr: string }>((resolve) => {
		const child = spawn(piBin(), args, {
			cwd: REPO,
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_LFM3: "on", PI_LFM3_BENCH_OUT: out },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stderr = "";
		let stdout = "";
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.stdout.on("data", (d) => (stdout += d));
		child.stderr.on("data", (d) => (stderr += d));
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stderr: stderr.slice(-2000) });
		});
	});
}

async function main() {
	const argv = process.argv.slice(2);
	const arg = (name: string, fallback: string) => {
		const i = argv.indexOf(name);
		return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
	};
	const out = arg("--out", join(REPO, "extensions/lfm3/bench/results/classify.jsonl"));
	const timeoutMs = Number(arg("--timeout-ms", "180000"));
	const cases = JSON.parse(readFileSync(new URL("./cases/classify.json", import.meta.url), "utf8")) as ClassifyCase[];
	const tmp = mkdtempSync(join(tmpdir(), "lfm3-classify-"));
	const raw = join(tmp, "rows.jsonl");
	try {
		const run = await runCollector(raw, tmp, timeoutMs);
		if (!existsSync(raw)) throw new Error(`the collector wrote no rows (pi exit ${run.code})\n${run.stderr}`);
		const rows = readFileSync(raw, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Row);
		const byId = new Map(cases.map((c) => [c.id, c]));
		const enriched = rows.map((r) => {
			const c = byId.get(r.id);
			const baseline = c ? classifyBaseline(c) : null;
			return { ...r, baseline, baselineOk: c ? baseline === c.label : false };
		});
		writeFileSync(out, enriched.map((r) => JSON.stringify(r)).join("\n") + "\n");
		const n = enriched.length;
		const pct = (k: "ok" | "baselineOk") => `${enriched.filter((r) => r[k]).length}/${n}`;
		const med = (values: number[]) => (values.length ? values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)] : 0);
		const p90 = (values: number[]) => (values.length ? values.slice().sort((a, b) => a - b)[Math.floor(values.length * 0.9)] : 0);
		const kinds = [...new Set(enriched.map((r) => r.kind))];
		for (const kind of kinds) {
			const rs = enriched.filter((r) => r.kind === kind);
			console.log(`${kind.padEnd(10)} model ${rs.filter((r) => r.ok).length}/${rs.length}  baseline ${rs.filter((r) => r.baselineOk).length}/${rs.length}  median ${med(rs.map((r) => r.ms))} ms`);
		}
		for (const r of enriched.filter((r) => !r.ok)) console.log(`FAIL ${r.id}: got ${JSON.stringify(r.got)}, want ${JSON.stringify(r.label)} (${r.stopReason}${r.errorMessage ? `: ${r.errorMessage}` : ""})`);
		console.log(
			JSON.stringify(
				{
					cases: n,
					model: pct("ok"),
					baseline: pct("baselineOk"),
					medianMs: med(enriched.map((r) => r.ms)),
					p90Ms: p90(enriched.map((r) => r.ms)),
					out,
					pi: run.code,
				},
				null,
				1,
			),
		);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
