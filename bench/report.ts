#!/usr/bin/env node
// Summarise a bench's raw rows into a summary table.
//
//   node bench/report.ts [--bench NAME] [--out FILE]
//
// The default output is `bench/results/<bench>/summary.md`, under the bench's own working area:
// the summary a recorded experiment ships in its `results/` is data, and this script never
// overwrites it. The experiment's committed report is its own (for d3-context, the context report
// in `experimental/d3-context/bench/context-report.ts`).
import { join } from "node:path";
import { armSet } from "./lib/arms.ts";
import { coreTable, costTable, editTable, loadArms, passRate, section, writeSummary } from "./lib/report.ts";
import { opt } from "./lib/util.ts";

const args = process.argv.slice(2);
// A bad --bench is a one-line message, not a stack trace.
let set: ReturnType<typeof armSet>;
try {
	set = armSet(args.reduce((a: string, s, i, all) => (all[i - 1] === "--bench" ? s : a), "pi-extras"));
} catch (e) {
	console.error((e as Error).message);
	process.exit(2);
}
const out = opt("out", join("bench", "results", set.name, "summary.md"))!;
const arms = [...loadArms(join(set.resultsRoot, "raw")).entries()];
if (!arms.length) {
	console.error(`no raw rows under ${join(set.resultsRoot, "raw")}`);
	process.exit(1);
}
const tasks = new Set(arms.flatMap(([, rows]) => rows.map((r) => r.task))).size;
writeSummary(
	out,
	[
		section(
			"Bench",
			[
				`\`node bench/run.ts --bench ${set.name}\` drives pi in-process through its SDK (\`createAgentSession\`) on the tickets of \`${set.ticketRoot}\`, grading each final tree with the ticket's hidden tests (\`node --test\`).`,
				`Rows: \`${join(set.resultsRoot, "raw")}/*.jsonl\`. Regenerate with \`node bench/report.ts --bench ${set.name}\`; this table is a working view, the summary an experiment records in its own \`results/\` is data.`,
				`Passes are over every run; performance columns exclude provider failures and timeouts.`,
				arms.map(([arm, rows]) => `- \`${arm}\`: ${passRate(rows).join("/")} passed on ${new Set(rows.map((r) => r.task)).size}/${tasks} task(s), ${rows.length} run(s)`).join("\n"),
			],
			coreTable(arms, { cost: true }),
		),
		section("Edits", ["How much of the work is harness-rejected edits."], editTable(arms)),
		section("Cost", ["Tokens per run, and the cost of a passed task at the endpoint's own accounting."], costTable(arms)),
	],
	`# ${set.name} bench summary`,
);
console.log(out);
