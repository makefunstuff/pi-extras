import assert from "node:assert/strict";
import { test } from "node:test";
import { readConfig } from "./config.ts";

test("env supplies both binaries and the switches", () => {
	const config = readConfig(
		{
			PI_HERDR_BIN: "/opt/herdr",
			PI_HERDR_PROJECTS_BIN: "/opt/herdr-projects",
			PI_HERDR_WRITES: "on",
			PI_HERDR_EXPOSURE: "direct",
			PI_HERDR_STUCK_MODEL: "off",
			PI_HERDR_TIMEOUT_MS: "1234",
			PI_HERDR_MAX_OUTPUT: "9000",
		},
		{ exists: () => false },
	);
	assert.equal(config.herdrBin, "/opt/herdr");
	assert.equal(config.boardBin, "/opt/herdr-projects");
	assert.equal(config.writes, true);
	assert.equal(config.exposure, "direct");
	assert.equal(config.timeoutMs, 1234);
	assert.equal(config.maxOutput, 9000);
	assert.equal(config.stuckModel, undefined);
});

test("defaults are read-only, codemode, and lfm3/d1-2b", () => {
	const config = readConfig({ PATH: "" }, { exists: () => false, home: "/tmp/home" });
	assert.equal(config.herdrBin, "herdr");
	assert.equal(config.boardBin, undefined);
	assert.equal(config.writes, false);
	assert.equal(config.exposure, "codemode");
	assert.equal(config.timeoutMs, 20_000);
	assert.deepEqual(config.stuckModel, { provider: "lfm3", id: "d1-2b" });
});

test("PATH is searched for herdr and herdr-projects", () => {
	const found = new Set(["/one/herdr", "/two/herdr-projects"]);
	const config = readConfig(
		{ PATH: "/one:/two", HOME: "/tmp/home" },
		{ exists: (path) => found.has(path), home: "/tmp/home" },
	);
	assert.equal(config.herdrBin, "/one/herdr");
	assert.equal(config.boardBin, "/two/herdr-projects");
});

test("the board is found in its conventional data folder, or one named by env", () => {
	const exists = new Set(["/tmp/home/.herdr-projects/data/bin/herdr-projects"]);
	assert.equal(
		readConfig({ PATH: "" }, { exists: (p) => exists.has(p), home: "/tmp/home" }).boardBin,
		"/tmp/home/.herdr-projects/data/bin/herdr-projects",
	);
	const config = readConfig(
		{ PATH: "", HERDR_PROJECTS_DATA_DIR: "/srv/board" },
		{ exists: (p) => p === "/srv/board/bin/herdr-projects", home: "/tmp/home" },
	);
	assert.equal(config.boardDataDir, "/srv/board");
	assert.equal(config.boardBin, "/srv/board/bin/herdr-projects");
});

test("unknown exposure falls back to codemode and a bad stuck model is ignored", () => {
	const config = readConfig(
		{ PATH: "", PI_HERDR_EXPOSURE: "loud", PI_HERDR_STUCK_MODEL: "no-slash" },
		{ exists: () => false },
	);
	assert.equal(config.exposure, "codemode");
	assert.equal(config.stuckModel, undefined);
});

test("PI_HERDR_WRITES accepts the usual on forms and nothing else", () => {
	const on = (value: string) => readConfig({ PATH: "", PI_HERDR_WRITES: value }, { exists: () => false }).writes;
	for (const value of ["1", "on", "true", "yes", "all"]) assert.equal(on(value), true, value);
	for (const value of ["0", "off", "false", "no", "", "maybe"]) assert.equal(on(value), false, value);
});
