// A real `pi -p` run against a scripted OpenAI-compatible mock: four direct reads are allowed, the
// fifth is blocked, and the model then answers with a codemode call. No model credentials.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const textOf = (m) => (typeof m.content === "string" ? m.content : (m.content ?? []).map((c) => c.text ?? "").join(" "));
const hasBlock = (payload) => (payload.messages ?? []).some((m) => m.role === "tool" && /\[codemode-steer\]/.test(textOf(m)));

export default {
	name: "blocks a fifth direct call and accepts codemode",
	args: ["--tools", "+codemode", "--no-mcp", "--no-session", "--approve"],
	timeoutMs: 120_000,
	cwd: () => {
		const dir = mkdtempSync(join(tmpdir(), "codemode-steer-smoke-"));
		for (const f of ["a.txt", "b.txt", "c.txt"]) writeFileSync(join(dir, f), `${f}\n`);
		return dir;
	},
	prompt: "Read a.txt, b.txt and c.txt, then report.",
	respond(_payload, n) {
		if (n < 5) return { toolCalls: [{ name: "read", arguments: { path: `${["a", "b", "c", "a", "b"][n]}.txt` } }] };
		if (n === 5) {
			if (!hasBlock(_payload)) return { content: "NO_BLOCK" };
			return { toolCalls: [{ name: "codemode", arguments: { code: 'const r = await tools.read({ path: "a.txt" }); return r;' } }] };
		}
		return { content: "SMOKE_DONE" };
	},
	check(res, mock) {
		if (mock.requests.length < 7) throw new Error(`expected 7 requests, got ${mock.requests.length}`);
		const after = mock.requests[5];
		if (!hasBlock(after)) throw new Error("the fifth direct call was not blocked");
		const tools = (after.tools ?? []).map((t) => t.function?.name);
		if (!tools.includes("codemode")) throw new Error(`codemode not declared: ${tools.join(", ")}`);
		if (!res.stdout.includes("SMOKE_DONE")) throw new Error("the run did not finish");
		const afterCode = textOf((mock.requests[6].messages ?? []).find((m) => m.role === "tool") ?? {});
		if (!afterCode.includes("a.txt")) throw new Error("the tool call inside the codemode script did not run");
	},
};
