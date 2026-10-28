// Bench-only extension: on session start, ask the registered d1-2B classifier every case and write
// one JSON row per case. Loaded with `pi -e` by classify.ts; it is not part of the package.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ClassifyCase } from "./baseline.ts";
import { answerFor, questionsFor } from "./questions.ts";

const cases = JSON.parse(readFileSync(new URL("./cases/classify.json", import.meta.url), "utf8")) as ClassifyCase[];

export default function collect(pi: ExtensionAPI) {
	let ran = false;
	pi.on("session_start", async (_event, ctx) => {
		if (ran) return;
		ran = true;
		const out = process.env.PI_LFM3_BENCH_OUT;
		if (!out) throw new Error("PI_LFM3_BENCH_OUT is not set");
		writeFileSync(out, "");
		const model = ctx.modelRegistry.getModelOfType("classifier", "lfm3", "d1-2b");
		for (const c of cases) {
			const t0 = performance.now();
			if (!model) {
				appendFileSync(
					out,
					`${JSON.stringify({ id: c.id, kind: c.kind, label: c.label, got: null, ok: false, ms: 0, stopReason: "error", errorMessage: "classifier lfm3/d1-2b is not registered" })}\n`,
				);
				continue;
			}
			const result = await ctx.modelRegistry.classify(model, { state: c.state, questions: questionsFor(c) });
			const ms = Math.round((performance.now() - t0) * 10) / 10;
			let got: boolean | string | number | null = null;
			let error = result.errorMessage;
			try {
				if (result.stopReason === "stop") got = answerFor(c, result.answers);
			} catch (e) {
				error = (e as Error).message;
			}
			const row = { id: c.id, kind: c.kind, label: c.label, got, ok: result.stopReason === "stop" && got === c.label, ms, stopReason: result.stopReason, errorMessage: error, answers: result.answers, usage: result.usage };
			appendFileSync(out, `${JSON.stringify(row)}\n`);
		}
	});
}
