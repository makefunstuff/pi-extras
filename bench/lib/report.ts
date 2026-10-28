// Summaries over the raw JSONL rows: the tables in results/summary.md.
//
// A run whose endpoint died (provider_error, no tokens) is excluded from the performance columns by
// default — its wall time is not the task's cost — while the pass rate is always counted over every
// run of the arm, so failures stay visible.
//
// Row fields are named by the runner that wrote them (`in_miss`/`in_hit` from the shared bench,
// `in`/`cache_read` from the recorded rows of the earlier benches), so a column reads the first name
// it finds.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fmt, mean, median, readRows, table } from "./util.ts";

export type Row = Record<string, any>;

export function loadArms(rawDir: string): Map<string, Row[]> {
	const out = new Map<string, Row[]>();
	if (!existsSync(rawDir)) return out;
	for (const f of readdirSync(rawDir).filter((f) => f.endsWith(".jsonl")).sort()) {
		const rows = readRows(join(rawDir, f));
		// where a row came from: a report needs the per-run artifacts next to its rows
		for (const r of rows) Object.defineProperty(r, "_file", { value: join(rawDir, f), enumerable: false });
		if (rows.length) out.set(f.replace(/\.jsonl$/, ""), rows);
	}
	return out;
}

/** The first of `keys` present on the row, as a number (NaN when the row has none). */
export function num(r: Row, ...keys: string[]): number {
	for (const k of keys) if (typeof r[k] === "number" && !Number.isNaN(r[k])) return r[k];
	return NaN;
}

export const passRate = (rows: Row[]) => [rows.filter((r) => r.passed).length, rows.length] as const;

/** Runs whose wall time measures the task: no dead endpoint, no timeout. */
export const perf = (rows: Row[]) => rows.filter((r) => !r.provider_error && !r.timed_out);

/** table(lines) with the header as the first line, which is how the tables read here. */
export const tbl = (lines: string[][]) => table(lines[0], lines.slice(1)).join("\n");

export const stats = (rows: Row[], ...keys: string[]) => {
	const vals = rows.map((r) => num(r, ...keys)).filter((x) => !Number.isNaN(x));
	return { n: vals.length, mean: vals.length ? mean(vals) : NaN, median: vals.length ? median(vals) : NaN, p95: p95(vals) };
};

export function p95(xs: number[]): number {
	if (!xs.length) return NaN;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor(0.95 * (s.length - 1)))];
}

/** Passes, wall clock, turns, calls, errors, tokens. */
export function coreTable(arms: [string, Row[]][], opts: { cost?: boolean } = {}): string {
	const head = ["arm", "pass", "wall s med", "wall s mean", "turns", "calls", "call err", "in", "out", "ctx peak"];
	if (opts.cost) head.push("cost $");
	const lines: string[][] = [head];
	for (const [arm, rows] of arms) {
		const p = perf(rows);
		const [np, n] = passRate(rows);
		const row = [
			arm,
			`${np}/${n}`,
			fmt(median(p.map((r) => num(r, "wall_s")))),
			fmt(mean(p.map((r) => num(r, "wall_s")))),
			fmt(mean(p.map((r) => num(r, "assistant_turns", "turns"))), 1),
			fmt(mean(p.map((r) => num(r, "tool_calls", "calls"))), 1),
			fmt(mean(p.map((r) => num(r, "tool_errors", "call_errors"))), 1),
			fmt(mean(p.map((r) => num(r, "in_miss", "in"))), 0),
			fmt(mean(p.map((r) => num(r, "out"))), 0),
			fmt(mean(p.map((r) => num(r, "ctx_peak"))), 0),
		];
		if (opts.cost) row.push(fmt(mean(p.map((r) => num(r, "cost", "agent_cost_usd"))), 3));
		lines.push(row);
	}
	return tbl(lines);
}


/** Codemode usage: how much of the work went through codemode instead of direct tool calls. */
export function codemodeTable(arms: [string, Row[]][]): string {
	const head = ["arm", "runs", "codemode calls", "direct calls", "codemode share", "codemode turns", "codemode errors", "steer blocks"];
	const lines: string[][] = [head];
	for (const [arm, rows] of arms) {
		const p = perf(rows);
		const cm = p.reduce((a, r) => a + (Number.isFinite(num(r, "codemode_calls")) ? num(r, "codemode_calls") : 0), 0);
		const direct = p.reduce((a, r) => a + (Number.isFinite(num(r, "direct_calls")) ? num(r, "direct_calls") : 0), 0);
		const turns = p.reduce((a, r) => a + (Number.isFinite(num(r, "codemode_turns")) ? num(r, "codemode_turns") : 0), 0);
		const errors = p.reduce((a, r) => a + (Number.isFinite(num(r, "codemode_errors")) ? num(r, "codemode_errors") : 0), 0);
		const blocks = p.reduce((a, r) => a + (Number.isFinite(num(r, "steer_blocks")) ? num(r, "steer_blocks") : 0), 0);
		const total = cm + direct;
		lines.push([arm, String(p.length), String(cm), String(direct), total ? `${((cm / total) * 100).toFixed(1)}%` : "–", String(turns), String(errors), String(blocks)]);
	}
	return tbl(lines);
}

/** Edit discipline: how many edit calls, and how many of them the harness had to reject. */
export function editTable(arms: [string, Row[]][], opts: { note?: (arm: string, rows: Row[]) => string } = {}): string {
	const head = ["arm", "runs", "edit calls", "edit calls rejected", "calls per run", "edits per run"];
	if (opts.note) head.push("note");
	const lines: string[][] = [head];
	for (const [arm, rows] of arms) {
		const p = perf(rows);
		const calls = p.reduce((a, r) => a + num(r, "edit_calls", "edits"), 0);
		const rej = p.reduce((a, r) => a + num(r, "edit_errors"), 0);
		const row = [arm, String(p.length), String(calls), `${rej} (${((rej / (calls || 1)) * 100).toFixed(1)}%)`, fmt(calls / (p.length || 1), 1), fmt((calls - rej) / (p.length || 1), 1)];
		if (opts.note) row.push(opts.note(arm, rows));
		lines.push(row);
	}
	return tbl(lines);
}

/** Tokens, cost per run, cost per passed task. */
export function costTable(arms: [string, Row[]][], opts: { gate?: (arm: string) => string } = {}): string {
	const head = ["arm", "in", "cache hit", "out", "ctx peak", "cost $ per run", "cost $ per passed task"];
	if (opts.gate) head.push("gate");
	const lines: string[][] = [head];
	for (const [arm, rows] of arms) {
		const p = perf(rows);
		const s = (...keys: string[]) => fmt(mean(p.map((r) => num(r, ...keys))), 0);
		const costMean = mean(p.map((r) => num(r, "cost", "agent_cost_usd")));
		const [np, n] = passRate(rows);
		const total = p.reduce((a, r) => a + num(r, "cost", "agent_cost_usd"), 0);
		const row = [arm, s("in_miss", "in"), s("in_hit", "cache_read"), s("out"), s("ctx_peak"), fmt(costMean, 3), np ? fmt(total / np, 3) : "—"];
		if (opts.gate) row.push(opts.gate(arm));
		lines.push(row);
	}
	return tbl(lines);
}

export function writeSummary(path: string, sections: string[], title = "# Summary") {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, [title, "", ...sections.map((s) => s.trimEnd())].join("\n").trimEnd() + "\n");
}

export function section(title: string, prose: string[], ...tables: string[]) {
	return [`## ${title}`, ...prose, ...tables].join("\n\n");
}
