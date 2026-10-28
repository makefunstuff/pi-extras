// Reading pi sessions and what they say about a run.
//
// `session.messages` / `sessionManager.getEntries()` give the entries of a live session; after a
// run the same entries are read back from the session folder (pi's JSONL format). Both come through
// here, so a bench and a later analysis script see the same shapes.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface SessionStats {
	assistant_turns: number;
	tool_calls: number;
	/** Calls to the codemode tool, and to every other tool (direct calls). */
	codemode_calls: number;
	direct_calls: number;
	codemode_turns: number;
	codemode_errors: number;
	/** Blocks and give-ups recorded by codemode-steer custom entries. */
	steer_blocks: number;
	steer_gave_up: number;
	tool_errors: number;
	tool_uniq: number;
	edit_calls: number;
	edit_errors: number;
	malformed_calls: number;
	in_miss: number;
	in_hit: number;
	in_write: number;
	out: number;
	reasoning: number;
	ctx_peak: number;
	ctx_mean: number;
	/** Sum of the per-turn request sizes: `mean = ctx_sum / assistant_turns` is what a report prints. */
	ctx_sum_over_turns: number;
	tokens_processed: number;
	compactions: number;
	compaction_ms: number;
	repeat_calls: number;
	repeat_max: number;
	top_repeats: string;
	/**
	 * Calls that read a file the session had already read before: the background rate of going back
	 * to a file. The context experiment compares this against the re-reads of files the router
	 * dropped (`refetch`, computed from the extension's log).
	 */
	rereads: number;
	reread_paths: number;
	reread_cases: string[];
	provider_errors: number;
	custom_messages: number;
	/** Messages a pi-extras extension added (a tip): counted by their custom type. */
	tips: number;
	models: string[];
	stop: string | null;
	error_turns: number;
	last_error: string;
}

const textOf = (content: any[]): string => (content ?? []).map((c: any) => (typeof c?.text === "string" ? c.text : "")).join(" ");

/** A tool call as the model asked for it: identity is (name, arguments). */
export function callKey(c: any): string {
	return JSON.stringify([c?.name, c?.arguments] ?? null, Object.keys((c?.arguments ?? {}) as object).sort());
}

/** The key of a call by its parts, for report scripts that group by (name, arguments). */
export const keyOf = (name: string, args: any) => JSON.stringify([name, args ?? null], Object.keys((args ?? {}) as object).sort());

function emptyStats(): SessionStats {
	return {
		assistant_turns: 0, tool_calls: 0, codemode_calls: 0, direct_calls: 0, codemode_turns: 0, codemode_errors: 0, steer_blocks: 0, steer_gave_up: 0, tool_errors: 0, tool_uniq: 0, edit_calls: 0, edit_errors: 0, malformed_calls: 0,
		in_miss: 0, in_hit: 0, in_write: 0, out: 0, reasoning: 0, ctx_peak: 0, ctx_mean: 0, ctx_sum_over_turns: 0, tokens_processed: 0,
		compactions: 0, compaction_ms: 0, repeat_calls: 0, repeat_max: 0, top_repeats: "—", provider_errors: 0, custom_messages: 0, tips: 0,
		rereads: 0, reread_paths: 0, reread_cases: [],
		models: [], stop: null, error_turns: 0, last_error: "",
	};
}

/** Stats of one session: turns, calls, errors, tokens, context growth, compactions, repeats. */
export function sessionStats(entries: any[]): SessionStats {
	const s = emptyStats();
	const ctx: number[] = [];
	const seen = new Set<string>();
	const counts = new Map<string, number>();
	const reread = new Map<string, number>();
	const names = new Set<string>();
	const models = new Set<string>();
	for (const e of entries as any[]) {
		if (e.type === "compaction") {
			s.compactions++;
			s.compaction_ms += Number(e.data?.ms ?? e.ms ?? 0);
		}
		if (e.type === "custom" || e.type === "custom_message") {
			s.custom_messages++;
			if (/tip/i.test(String((e as any).customType ?? ""))) s.tips += Number((e as any).data?.count ?? 1);
			if ((e as any).customType === "codemode-steer") {
				s.steer_blocks += Number((e as any).data?.blocks ?? 0);
				if ((e as any).data?.gaveUp) s.steer_gave_up++;
			}
		}
		const m = e.type === "message" ? e.message : undefined;
		if (!m) continue;
		if (m.role === "assistant") {
			const u = m.usage ?? {};
			s.assistant_turns++;
			s.in_miss += u.input ?? 0;
			s.in_hit += u.cacheRead ?? 0;
			s.in_write += u.cacheWrite ?? 0;
			s.out += u.output ?? 0;
			s.reasoning += u.reasoning ?? 0;
			if (m.model) models.add(m.model);
			if ((u.input ?? 0) + (u.cacheRead ?? 0)) ctx.push((u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0));
			s.stop = m.stopReason ?? null;
			s.provider_errors += m.stopReason === "error" ? 1 : 0;
			if (m.stopReason === "error") s.error_turns++;
			if (m.errorMessage) s.last_error = m.errorMessage;
			let madeCodemode = false;
			for (const c of m.content ?? []) {
				if (c?.type === "toolCall") {
					s.tool_calls++;
					if (c.name === "codemode") {
						s.codemode_calls++;
						madeCodemode = true;
					} else s.direct_calls++;
					names.add(c.name);
					const k = callKey(c);
					counts.set(k, (counts.get(k) ?? 0) + 1);
					if (counts.get(k)! > 1) s.repeat_calls++;
					const back = [...pathsOf(c)].filter((p) => seen.has(p));
					if (back.length) {
						s.rereads++;
						for (const p of back) reread.set(p, (reread.get(p) ?? 0) + 1);
						if (s.reread_cases.length < 10) s.reread_cases.push(`${back.join(", ")} <- ${c.name ?? "?"}`.slice(0, 160));
					}
					for (const p of pathsOf(c)) seen.add(p);
				}
				// a tool call the model wrote as plain text instead of calling
				if (c?.type === "text" && (String(c.text ?? "").includes("<tool_call>") || String(c.text ?? "").includes("<function="))) s.malformed_calls++;
			}
			if (madeCodemode) s.codemode_turns++;
		} else if (m.role === "toolResult") {
			s.edit_calls += m.toolName === "edit" ? 1 : 0;
			if (m.isError) {
				s.tool_errors++;
				s.edit_errors += m.toolName === "edit" ? 1 : 0;
			if (m.toolName === "codemode") s.codemode_errors++;
				const txt = textOf(m.content);
				if (txt.includes("Validation failed") || (/\bnot found\b/i.test(txt) && /\btool\b/i.test(txt))) s.malformed_calls++;
			}
		}
	}
	s.ctx_peak = ctx.length ? Math.max(...ctx) : 0;
	s.ctx_mean = ctx.length ? Math.round(ctx.reduce((a, b) => a + b, 0) / ctx.length) : 0;
	s.ctx_sum_over_turns = ctx.reduce((a, b) => a + b, 0);
	s.tokens_processed = s.in_miss + s.in_hit + s.out;
	s.tool_uniq = names.size;
	s.repeat_max = Math.max(0, ...counts.values());
	s.reread_paths = reread.size;
	s.top_repeats = [...counts.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, n]) => `${JSON.parse(k)[0]} ${n}x`).join(", ") || "—";
	s.models = [...models];
	return s;
}

export interface Call {
	id: string;
	name: string;
	key: string;
	/** The file paths the call reads (a read tool call, or a command that names files). */
	paths: Set<string>;
	text: string;
}

export const PATH_RE = /[\w./-]+\.(?:ts|tsx|js|mjs|cjs|json|jsonl|md|csv|txt|log|diff|ini|toml|sql)\b/g;
export const READERS_RE = /\b(cat|sed|head|tail|grep|rg|less|awk|wc|nl|node|npx|open)\b/;

function pathsOf(call: any): Set<string> {
	const a = call?.arguments ?? {};
	const text: string = a.command ?? a.code ?? a.path ?? a.filePath ?? "";
	const reads = call?.name === "read" || READERS_RE.test(text);
	if (!reads) return new Set();
	const out = new Set<string>();
	for (const m of text.match(PATH_RE) ?? []) out.add(m.replace(/^\.\//, ""));
	if (call?.name === "read" && a.path) out.add(String(a.path).replace(/^\.\//, ""));
	return out;
}

/** Every tool call of a session, in order, with the files it reads. */
export function callsOf(entries: any[]): Call[] {
	const out: Call[] = [];
	for (const e of entries as any[]) {
		const m = e.type === "message" ? e.message : undefined;
		if (m?.role !== "assistant") continue;
		for (const c of m.content ?? []) {
			if (c?.type !== "toolCall") continue;
			const a = c.arguments ?? {};
			out.push({
				id: c.id, name: c.name, key: callKey(c), paths: pathsOf(c),
				text: String(a.command ?? a.code ?? a.path ?? "").slice(0, 200),
			});
		}
	}
	return out;
}

/** Assistant turns in order: their text (text + thinking) and the calls they make. */
export function turnsOf(entries: any[]): { text: string; calls: Call[]; error: boolean }[] {
	const out: { text: string; calls: Call[]; error: boolean }[] = [];
	for (const e of entries as any[]) {
		const m = e.type === "message" ? e.message : undefined;
		if (m?.role === "assistant") {
			const text = (m.content ?? []).map((c: any) => (c?.type === "text" || c?.type === "thinking" ? String(c.text ?? "") : "")).join(" ");
			const calls: Call[] = [];
			for (const c of m.content ?? [])
				if (c?.type === "toolCall") {
					const a = c.arguments ?? {};
					calls.push({ id: c.id, name: c.name, key: callKey(c), paths: pathsOf(c), text: String(a.command ?? a.code ?? a.path ?? "").slice(0, 200) });
				}
			out.push({ text, calls, error: false });
		} else if (m?.role === "toolResult" && m.isError && out.length) out[out.length - 1].error = true;
	}
	return out;
}

/** Entries of a saved session folder (pi's JSONL session format), in file order, walked recursively. */
export function entriesOfSessionDir(dir: string): any[] {
	const out: any[] = [];
	if (!existsSync(dir)) return out;
	const files: string[] = [];
	const walk = (d: string) => {
		for (const name of readdirSync(d, { withFileTypes: true })) {
			const p = join(d, name.name);
			if (name.isDirectory()) walk(p);
			else if (name.name.endsWith(".jsonl")) files.push(p);
		}
	};
	walk(dir);
	for (const f of files.sort())
		for (const line of readFileSync(f, "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				out.push(JSON.parse(line));
			} catch {
				// a partially written line at the end of a killed run
			}
		}
	return out;
}

/** List prices of a provider, USD per 1M tokens: cache-hit input, cache-miss input, output. */
export interface Price {
	hit: number;
	miss: number;
	out: number;
	label?: string;
}

/** Prices the recorded measurements were costed at, per 1M tokens. */
export const PRICES: Record<string, Price> = {
	"openai-codex": { hit: 0.625, miss: 1.25, out: 10, label: "openai-codex/gpt-5.2 (list)" },
	deepseek: { hit: 0.22, miss: 0.33, out: 0.60, label: "deepseek-chat (list)" },
};

export function costUsd(s: Pick<SessionStats, "in_miss" | "in_hit" | "out">, price: Price): number {
	return Number((((s.in_miss * price.miss + s.in_hit * price.hit + s.out * price.out) / 1e6)).toFixed(5));
}
