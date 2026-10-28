// End to end: pi -p with codemode on, the model finds herdr_agent_list in the codemode description
// and calls it from a script. The herdr CLI is a fake script, so no daemon is needed.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MOCK_MODEL, textOf } from "../../test/lib/harness.mjs";

const fakeDir = mkdtempSync(join(process.env.PI_EXTRAS_TMP ?? tmpdir(), "herdr-smoke-"));
const fakeHerdr = join(fakeDir, "herdr");
writeFileSync(
	fakeHerdr,
	`#!/bin/sh
if [ "$1 $2" = "agent list" ]; then
  printf '%s\\n' '{"id":"cli:agent:list","result":{"agents":[{"name":"sw-a","agent":"pi","agent_status":"blocked","pane_id":"w1:p1","title":"Waiting","focused":false}]}}'
  exit 0
fi
if [ "$1 $2" = "agent read" ] && [ "$3" = "nosuch" ]; then
  printf '%s\\n' '{"id":"cli:agent:read","error":{"code":"agent_not_found","message":"agent target nosuch not found"}}'
  exit 1
fi
if [ "$1 $2" = "agent read" ]; then
  printf '%s\\n' 'Do you want to continue? [y/N]'
  exit 0
fi
printf '%s\\n' '{"error":{"code":"unexpected","message":"unexpected call"}}'
exit 1
`,
);
chmodSync(fakeHerdr, 0o755);
process.on("exit", () => rmSync(fakeDir, { recursive: true, force: true }));

export default {
	name: "herdr: codemode finds and calls herdr_agent_list",
	args: ["--tools", "+codemode"],
	env: { PI_HERDR_BIN: fakeHerdr },
	prompt: "List the blocked herdr agents.",
	respond(body, n) {
		if (n === 0) {
			const codemode = body.tools?.find((t) => t.function?.name === "codemode");
			assert.ok(codemode, "codemode is offered");
			assert.match(codemode.function.description, /herdr_agent_list/, "the herdr tools are listed by codemode");
			assert.match(codemode.function.description, /herdr_board_list/, "the board tools are listed too");
			return {
				toolCalls: [
					{
						name: "codemode",
						arguments: { code: "const { agents } = await tools.herdr_agent_list({ status: 'blocked' }); return agents.map((a) => a.name);" },
					},
				],
			};
		}
		const result = body.messages.filter((m) => m.role === "tool").map(textOf).join("\n");
		if (n === 1) {
			assert.match(result, /sw-a/, "the script saw the fake agent");
			return {
				toolCalls: [
					{
						name: "codemode",
						arguments: {
							code: "try { await tools.herdr_agent_read({ target: 'nosuch' }); return 'NO_ERROR'; } catch (e) { return 'CAUGHT ' + e.message; }",
						},
					},
				],
			};
		}
		assert.match(result, /CAUGHT agent_not_found/, "a failed tool call rejects in codemode");
		return { content: "FOUND sw-a AND CAUGHT agent_not_found" };
	},
	check({ stdout }) {
		assert.match(stdout, /FOUND sw-a AND CAUGHT agent_not_found/);
	},
	model: MOCK_MODEL,
};
