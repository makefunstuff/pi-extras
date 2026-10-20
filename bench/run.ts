#!/usr/bin/env node
// The shared bench: run tickets against pi in-process, one arm at a time, appending one row per run.
//
//   node bench/run.ts [options]
//     --bench NAME      pi-extras (default) | d3-context
//     --tasks a,b|all   tickets (default: all under the bench's ticket root)
//     --arms a,b        arms (default: every arm of the bench that is available)
//     --rounds N        rounds per ticket (default 1)
//     --first N         first round number, for extending an existing series
//     --model NAME      provider/model[:thinking] (default per bench)
//     --out PATH        raw rows (default <bench>/results/raw/<arm>.jsonl)
//     --ext PATH        load one more extension (repeatable)
//     --workers N       concurrent runs (default 2; arms with per-run in-process state use 1)
//     --timeout S       per-run wall-clock cap (default 1800)
//     --dry-run         seed and grade without calling a model: the CI check of the harness
//
// Rows are appended as runs finish, so an interrupted series keeps what it measured; finished
// (task, round) pairs are skipped on the next call.
import { join } from "node:path";
import { armSet, pickTickets, type Arm, type ArmConfig, type ArmSet } from "./lib/arms.ts";
import { makeAgentDir, runSeries } from "./lib/run.ts";
import { cacheDirFor, flag, opt, useTmpDir } from "./lib/util.ts";

// Bad input is a one-line message, not a stack trace: this is a long-running series, and the line
// that says what to fix is what a person reads. A typo in a flag name is refused too — an unknown
// flag is otherwise ignored, and a silently ignored `--task` (for `--tasks`) would run every ticket.
const FLAGS = ["bench", "tasks", "arms", "rounds", "first", "model", "out", "ext", "workers", "timeout", "dry-run"];
function die(msg: string): never {
	console.error(msg);
	process.exit(2);
}
function numOpt(name: string, def: number, min = 1): number {
	const raw = opt(name, String(def)) as string;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < min) die(`--${name} ${raw}: expected a whole number of at least ${min}`);
	return n;
}
const unknown = process.argv.slice(2).map((a) => a.split("=")[0]).find((a) => a.startsWith("--") && !FLAGS.includes(a.slice(2)));
if (unknown) die(`unknown option ${unknown}: ${FLAGS.map((f) => `--${f}`).join(" ")}`);

const dry = flag("dry-run");
const rounds = numOpt("rounds", 1);
const firstRound = numOpt("first", 1);
const workers = numOpt("workers", 2);
const timeoutS = numOpt("timeout", 1800, 1);
let set: ArmSet;
try {
	set = armSet(opt("bench", "pi-extras") as string);
} catch (e) {
	die((e as Error).message);
}
let tasks: ReturnType<typeof pickTickets>;
try {
	tasks = pickTickets(set.ticketRoot, opt("tasks", "all") as string);
} catch (e) {
	die((e as Error).message);
}
const want = opt("arms", "")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);
const missing = want.filter((w) => !set.arms.some((a) => a.name === w));
if (missing.length) {
	console.error(`no arm named ${missing.join(", ")} in bench ${set.name}: ${set.arms.map((a) => a.name).join(", ")}`);
	process.exit(2);
}
const arms = want.length ? set.arms.filter((a) => want.includes(a.name)) : set.arms;
const extensions = process.argv.slice(2).flatMap((a, i, all) => (all[i - 1] === "--ext" ? [a] : []));
const cfg: ArmConfig = { dryRun: !!dry };

useTmpDir(join(cacheDirFor(set.cacheName), "tmp"));
const cache = cacheDirFor(set.cacheName);
let agentDir = "";

const armHooks = (arm: Arm) => ({
	start: (ctx: any) => arm.hooks?.(ctx, cfg).start?.(ctx),
	after: (ctx: any) => arm.hooks?.(ctx, cfg).after?.(ctx),
});

for (const arm of arms) {
	const why = arm.available?.() ?? true;
	if (why !== true) {
		console.log(`== ${arm.name}: skipped, ${why}`);
		continue;
	}
	agentDir ||= makeAgentDir(cache, set.cacheName);
	const outPath = opt("out", "") || join(set.resultsRoot, "raw", `${arm.name}.jsonl`);
	console.log(`== ${set.name} / ${arm.name}: ${tasks.map((t) => t.name).join(", ")} x ${rounds} round(s), model ${arm.model ?? opt("model", set.defaultModel)}${dry ? " (dry run)" : ""}`);
	const rows = await runSeries({
		arm: arm.name,
		tickets: tasks,
		rounds,
		firstRound,
		outPath,
		cache,
		agentDir,
		model: arm.model ?? opt("model", set.defaultModel),
		extensionPaths: [...(arm.extensionPaths ?? []), ...extensions],
		extensionFactories: arm.factories ? (ctx) => arm.factories(ctx, cfg) : undefined,
		env: arm.env ? (ctx) => arm.env!(ctx, cfg) : undefined,
		hooks: arm.hooks ? armHooks(arm) : undefined,
		workers: Math.min(workers, arm.maxWorkers ?? workers),
		timeoutS,
		dryRun: dry,
		fields: { bench: set.name, ...arm.fields },
	});
	const passed = rows.filter((r) => r.passed).length;
	if (rows.length) console.log(`== ${arm.name}: ${passed}/${rows.length} passed${dry ? " (dry: the seeded tree as it stands)" : ""}`);
}
