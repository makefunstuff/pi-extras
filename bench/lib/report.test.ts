import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { codemodeTable, coreTable, costTable, editTable, loadArms, num, passRate, p95, perf, section, stats, writeSummary } from "./report.ts";
import { appendRow } from "./util.ts";

const t = () => mkdtempSync(join(tmpdir(), "pi-bench-report-"));

// the shared runner's names (in_miss/in_hit/turns/edits) and the recorded rows' names (in/cache_read/turns/edits)
const rows = [
	{ arm: "off", task: "a", round: 1, passed: true, wall_s: 100, assistant_turns: 10, tool_calls: 8, tool_errors: 1, in_miss: 1000, in_hit: 20000, out: 200, ctx_peak: 21000, edit_calls: 4, edit_errors: 0, cost: 0.02 },
	{ arm: "off", task: "b", round: 1, passed: false, wall_s: 300, assistant_turns: 30, tool_calls: 20, tool_errors: 6, in_miss: 3000, in_hit: 40000, out: 600, ctx_peak: 43000, edit_calls: 10, edit_errors: 4, cost: 0.06 },
	{ arm: "off", task: "c", round: 1, passed: false, wall_s: 900, assistant_turns: 0, tool_calls: 0, tool_errors: 0, in_miss: 0, in_hit: 0, out: 0, ctx_peak: 0, edit_calls: 0, edit_errors: 0, cost: 0, provider_error: true },
	{ arm: "gate", task: "a", round: 1, passed: true, wall_s: 90, turns: 9, calls: 7, call_errors: 0, in: 900, cache_read: 18000, out: 180, ctx_peak: 18900, edits: 3, edit_errors: 0, cost: 0.018 },
];

test("rows are read per arm file, and the old field names are understood", () => {
	const dir = t();
	appendRow(join(dir, "off.jsonl"), rows[0]);
	appendRow(join(dir, "off.jsonl"), rows[1]);
	appendRow(join(dir, "gate.jsonl"), rows[3]);
	writeFileSync(join(dir, "notes.md"), "not rows");
	const arms = loadArms(dir);
	assert.deepEqual([...arms.keys()], ["gate", "off"]);
	assert.equal(arms.get("off")!.length, 2);
	assert.equal(num(rows[3], "in_miss", "in"), 900);
	assert.equal(num(rows[0], "in_miss", "in"), 1000);
	assert.equal(num(rows[0], "nope", "tool_calls"), 8);
	assert.ok(Number.isNaN(num(rows[0], "nope", "also_nope")));
	assert.equal(loadArms(join(dir, "nope")).size, 0);
});

test("the pass rate counts every run; the performance columns do not", () => {
	assert.deepEqual(passRate(rows.slice(0, 3)), [1, 3]);
	assert.equal(perf(rows.slice(0, 3)).length, 2); // the provider failure is out of the timings
	assert.deepEqual(passRate(perf(rows.slice(0, 3))), [1, 2]);
});

test("stats: mean, median, p95", () => {
	const s = stats(rows.slice(0, 3), "wall_s");
	assert.equal(s.n, 3);
	assert.equal(s.median, 300);
	assert.equal(s.p95, 300);
	assert.equal(stats(rows, "nope").n, 0);
	assert.ok(Number.isNaN(stats(rows, "nope").mean));
	assert.equal(p95([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 9);
	assert.ok(Number.isNaN(p95([])));
});

test("the tables carry both naming conventions and say what they mean", () => {
	const arms: [string, any[]][] = [["off", rows.slice(0, 3)], ["gate", [rows[3]]]];

	const core = coreTable(arms, { cost: true }).split("\n");
	assert.match(core[0], /\| arm \| pass \| wall s med \| .* \| ctx peak \| cost \$ \|/);
	assert.match(core[2], /\| off +\| 1\/3/); // the pass rate is over all three runs
	assert.match(core[2], /200/); // mean out over the two measured runs: (200+600)/2
	const gate = core[3];
	assert.match(gate, /1\/1/);
	assert.match(gate, /900/); // `in` from the old field name

	const edits = editTable(arms).split("\n");
	assert.match(edits[2], /off +\| 2 +\| 14 +\| 4 \(28\.6%\)/);
	assert.match(edits[3], /gate +\| 1 +\| 3 +\| 0 \(0\.0%\)/);

	const cost = costTable(arms, { gate: (a) => (a === "gate" ? "on" : "off") }).split("\n");
	assert.match(cost[0], /cache hit/);
	assert.match(cost[2], /off +\| 2,000 +\| 30,000/); // (1000+3000)/2, (20000+40000)/2
	assert.match(cost[3], /on/);

	// a table with no measured runs prints – rather than a made-up zero
	const empty = coreTable([["dead", [rows[2]]]]).split("\n");
	assert.match(empty[2], /–/);
});

test("the codemode table counts the share and the steer blocks", () => {
	const cmRows = [
		{ arm: "off", passed: true, codemode_calls: 0, direct_calls: 8, codemode_turns: 0, codemode_errors: 0, steer_blocks: 0 },
		{ arm: "steer", passed: true, codemode_calls: 6, direct_calls: 2, codemode_turns: 3, codemode_errors: 1, steer_blocks: 2 },
	];
	const lines = codemodeTable([["off", [cmRows[0]]], ["steer", [cmRows[1]]]]).split("\n");
	assert.match(lines[0], /\| arm \| runs \| codemode calls \| direct calls \| codemode share \|/);
	assert.match(lines[2], /off +\| 1 +\| 0 +\| 8 +\| 0\.0%/);
	assert.match(lines[3], /steer +\| 1 +\| 6 +\| 2 +\| 75\.0% +\| 3 +\| 1 +\| 2/);
	const none = codemodeTable([["old", [{ arm: "old", passed: true }]]]).split("\n");
	assert.match(none[2], /–/);
});

test("a summary is a title, sections and tables", () => {
	const dir = t();
	const p = join(dir, "summary.md");
	writeSummary(p, [section("Bench", ["prose"], coreTable([["off", rows.slice(0, 3)]])), section("Edits", [], editTable([["off", rows.slice(0, 3)]]))], "# Off bench");
	const md = readFileSync(p, "utf8");
	assert.match(md, /^# Off bench\n/);
	assert.match(md, /## Bench\n\nprose\n\n\| arm \|/);
	assert.match(md, /## Edits\n\n\| arm \|/);
	assert.ok(!md.endsWith("\n\n"));
});
