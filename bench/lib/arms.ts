// Arm definitions for benches: what a "side" of an A/B is (an extension, a config, a provider).
//
// An arm set is chosen with --bench; each set declares the tickets it runs and the arms that are
// comparable on them. Arms whose dependency is missing report why and are skipped — a bench that
// silently measures nothing is worse than one that says it cannot run.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { d3Context, readConfig, type D3Config } from "../../experimental/d3-context/extension/index.ts";
import { d3LogPath, parseD3Log } from "../../experimental/d3-context/bench/lib/log.ts";
import type { RunContext, RunHooks } from "./run.ts";
import { loadTickets, type Ticket } from "./tickets.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface Arm {
	name: string;
	/** Constant fields added to every row of this arm. */
	fields?: Record<string, any>;
	model?: string;
	extensionPaths?: string[];
	/** Fresh factories per run: a run's config (log path, flags) is its own. */
	factories?: (ctx: RunContext, cfg: ArmConfig) => any[];
	env?: (ctx: RunContext, cfg: ArmConfig) => Record<string, string>;
	hooks?: (ctx: RunContext, cfg: ArmConfig) => RunHooks;
	/** A string means: skip this arm, and say why. */
	available?: () => true | string;
	maxWorkers?: number;
}

export interface ArmSet {
	name: string;
	/** Root of the tickets this set runs (default bench/tickets). */
	ticketRoot: string;
	/** Root for results/raw/<arm>.jsonl and the bench cache. */
	resultsRoot: string;
	cacheName: string;
	defaultModel: string;
	arms: Arm[];
}

export interface ArmConfig {
	dryRun: boolean;
	[key: string]: any;
}

const ext = (p: string) => join(ROOT, p);

export const EXTENSIONS = {
	"verify-gate": ext("extensions/verify-gate/index.ts"),
	"loop-guard": ext("extensions/loop-guard/index.ts"),
	"thinking-guard": ext("extensions/thinking-guard/index.ts"),
	lessons: ext("extensions/lessons/index.ts"),
	"local-edit": ext("extensions/local-edit/index.ts"),
	"codemode-steer": ext("extensions/codemode-steer/index.ts"),
	"d3-context": ext("experimental/d3-context/extension/index.ts"),
};

/** The pi-extras arms: each extension against a plain pi, on the shared tickets. */
export function piExtrasSet(): ArmSet {
	return {
		name: "pi-extras",
		ticketRoot: join(ROOT, "bench", "tickets"),
		resultsRoot: join(ROOT, "bench", "results"),
		cacheName: "pi-extras",
		defaultModel: process.env.BENCH_MODEL ?? "deepseek-flash",
		arms: [
			{ name: "off", fields: { gate: "none" } },
			...Object.entries(EXTENSIONS)
				.filter(([name]) => name !== "d3-context")
				.map(([name, path]) => ({
					name,
					fields: { gate: name },
					extensionPaths: [path],
				})),
		],
	};
}

/** The d3-context arms: the context router against a plain pi, on the long tickets. */
export function d3ContextSet(): ArmSet {
	const cfg: D3Config = readConfig();
	return {
		name: "d3-context",
		ticketRoot: join(ROOT, "experimental", "d3-context", "bench", "tasks-long"),
		resultsRoot: join(ROOT, "experimental", "d3-context", "results"),
		cacheName: "d3-context",
		defaultModel: process.env.BENCH_MODEL ?? "deepseek-flash",
		arms: [
			{ name: "base", fields: { gate: "none" } },
			{
				name: "d3",
				fields: { gate: "d3", d3_model: cfg.model },
				available: () => (cfg.url ? true : "no D3 endpoint: set D3_URL (see experimental/d3-context/README.md)"),
				factories: (ctx) => [(pi: any) => d3Context(pi, { ...cfg, log: join(ctx.outDir, `${ctx.name}.${ctx.arm}.jsonl`) })],
				/** The arm measures its own effect: the router's numbers go in the row it writes. */
				hooks: (ctx) => ({
					after: () => {
						const log = parseD3Log(d3LogPath(ctx.outDir, ctx.task, ctx.round, ctx.arm));
						return {
							d3_checks: log.checks,
							d3_calls: log.calls,
							d3_dropped: log.drops,
							d3_summarised: log.summaries,
							d3_saved_chars: log.savedChars,
							d3_ms: Math.round(log.d3Ms),
							d3_errors: log.errors.length,
						};
					},
				}),
			},
		],
	};
}

export function armSet(name: string): ArmSet {
	switch (name) {
		case "pi-extras":
			return piExtrasSet();
		case "d3-context":
			return d3ContextSet();
		default:
			throw new Error(`unknown --bench ${name} (pi-extras | d3-context)`);
	}
}

export function pickTickets(root: string, spec: string): Ticket[] {
	const all = loadTickets(root);
	if (!all.length) throw new Error(`no tickets in ${root} (for the long tickets: node experimental/d3-context/bench/gen-long-tasks.ts)`);
	if (spec === "all" || !spec) return all;
	const want = spec.split(",").map((s) => s.trim()).filter(Boolean);
	const missing = want.filter((w) => !all.some((t) => t.name === w));
	if (missing.length) throw new Error(`no ticket named ${missing.join(", ")} in ${root}`);
	return all.filter((t) => want.includes(t.name));
}
