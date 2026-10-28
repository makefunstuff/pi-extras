import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyBaseline, watcherBaseline, type ClassifyCase, type WatcherCase } from "./baseline.ts";
import { parseWatcherJson, sanitize, watcherPrompt } from "./watcher.ts";

const watcher: WatcherCase = {
	id: "permission",
	role: "agent",
	title: "Clean up the cache",
	desc: "Remove the stale cache.",
	mins: 3,
	prev: 20,
	tail: "Allow Bash command? (y/n)",
	want: "wait|approv|permission",
	range: [15, 50],
};

test("watcherPrompt carries the task, the previous guess and the exact reply shape", () => {
	const p = watcherPrompt(watcher);
	assert.match(p, /You are watching an agent at work/);
	assert.match(p, /Task: Clean up the cache/);
	assert.match(p, /previous guess was 20 percent/);
	assert.match(p, /Allow Bash command/);
	assert.match(p, /Reply with only this JSON and nothing else: \[\{"n": <the number above>/);
});

test("watcherPrompt marks a reviewer and uses the first-look line without a guess", () => {
	const p = watcherPrompt({ ...watcher, role: "reviewer", prev: null });
	assert.match(p, /adversarial reviewer/);
	assert.match(p, /This is your first look at it/);
	assert.doesNotMatch(p, /previous guess/);
});

test("parseWatcherJson takes the first array, an object, or a code fence", () => {
	assert.deepEqual(parseWatcherJson('```json\n[{"n":1,"msg":"Running tests","progress":40}]\n```'), { n: 1, msg: "Running tests", progress: 40 });
	assert.deepEqual(parseWatcherJson('{"n":1,"msg":"x","progress":2}'), { n: 1, msg: "x", progress: 2 });
	assert.equal(parseWatcherJson("no json here"), null);
	assert.equal(parseWatcherJson("<tool_call><function=bash>"), null);
});

test("sanitize keeps the machine's paths out of the public rows", () => {
	assert.equal(sanitize("cd /home/user/work && ls"), "cd ~/work && ls");
	assert.doesNotMatch(sanitize("x /home/user/.cache/y"), /\/home\/alice/);
});

test("watcherBaseline picks the obvious line and an elapsed-share percent", () => {
	assert.deepEqual(watcherBaseline(watcher), { msg: "Waiting for permission", progress: 20 });
	const tests = watcherBaseline({ ...watcher, id: "tests", tail: "$ npm test\nℹ pass 42", prev: null });
	assert.match(tests.msg, /Running the tests/);
	assert.equal(tests.progress, Math.round((100 * 3) / 33));
});

test("classifyBaseline reads the same shapes as the model", () => {
	const cases: ClassifyCase[] = [
		{ id: "s", kind: "stuck", state: "$ lint\n✖ 3\n$ lint\n✖ 3\n$ lint\n✖ 3", label: true },
		{ id: "p", kind: "permission", state: "Allow Bash command? (y/n)", label: true },
		{ id: "b", kind: "blocking", state: "Finding: the data is dropped before it is copied.", label: true },
		{ id: "n", kind: "blocking", state: "Nit: rename this helper.", label: false },
		{ id: "k", kind: "kind", state: "Title: Add a /lfm3 command", label: "feature" },
		{ id: "q", kind: "kind", state: "Title: How do I set watcher.agent?", label: "question" },
		{ id: "r", kind: "repo", state: "The board sidebar does not refresh.", label: "herdr" },
	];
	for (const c of cases) assert.equal(classifyBaseline(c), c.label, c.id);
});
