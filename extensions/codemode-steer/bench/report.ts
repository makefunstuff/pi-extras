#!/usr/bin/env node
// Summarise the recorded codemode-steer eval rows into results/summary.md.
// The rows come from the shared bench (`bench/run.ts`); this script only presents them here.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { codemodeTable, coreTable, loadArms, passRate, section, writeSummary } from "../../../bench/lib/report.ts";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "results", "summary.md");
const arms = [...loadArms(join(here, "results")).entries()];
if (!arms.length) {
	console.error(`no rows in ${join(here, "results")}`);
	process.exit(1);
}
writeSummary(
	out,
	[
		section(
			"Codemode",
			[
				"3 tickets (`bulk-rename`, `cli-json`, `config-rename`), 2 rounds, 6 runs per arm, DeepSeek Flash. Hidden `node:test` graders; the same eval in both arms.",
				"Share is codemode calls / (codemode + direct calls). Steer blocks are direct calls codemode-steer stopped.",
			],
			codemodeTable(arms),
		),
		section("Runs", [arms.map(([arm, rows]) => `- \`${arm}\`: ${passRate(rows).join("/")} passed, ${rows.length} run(s)`).join("\n")], coreTable(arms)),
	],
	"# codemode-steer eval",
);
console.log(out);
