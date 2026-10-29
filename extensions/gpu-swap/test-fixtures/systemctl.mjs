#!/usr/bin/env node
// A fake systemctl for the unit tests: start, stop and is-active on units kept in the JSON file
// named by FAKE_SYSTEMCTL_STATE. Every call is logged there. A unit in `failStart` refuses to start.
import { readFileSync, writeFileSync } from "node:fs";

const file = process.env.FAKE_SYSTEMCTL_STATE;
const state = JSON.parse(readFileSync(file, "utf8"));
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const [verb, unit] = args;
state.log.push(`${verb} ${unit}`);
const save = () => writeFileSync(file, JSON.stringify(state));
if (verb === "start") {
	if (state.failStart?.includes(unit)) {
		save();
		console.error(`Failed to start ${unit}`);
		process.exit(1);
	}
	for (const other of state.conflicts?.[unit] ?? []) delete state.active[other];
	state.active[unit] = Date.now();
	save();
} else if (verb === "stop") {
	delete state.active[unit];
	save();
} else if (verb === "is-active") {
	save();
	const on = !!state.active[unit];
	if (!process.argv.includes("--quiet")) console.log(on ? "active" : "inactive");
	process.exit(on ? 0 : 3);
} else {
	save();
	console.error(`fake systemctl: unknown verb ${verb}`);
	process.exit(1);
}
