// The d1-2B client: llama.cpp answers typed questions over one state at /v1/systemone, with no
// generated tokens. This is the wire format pi's "typesafe-system-one" classifier API uses: `bool`
// travels as `noul`, and every answer carries a calibrated probability.
//
// The functions take a fetch implementation, so unit tests use a fake and never open a socket.
export interface FetchResponseLike {
	ok: boolean;
	status: number;
	text(): Promise<string>;
	json(): Promise<unknown>;
}
export type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<FetchResponseLike>;

export type ClassifierQuestion =
	| { type: "bool"; instructions: string; criteria?: { true: string; false: string } }
	| { type: "choice"; instructions: string; criteria: Record<string, string> }
	| { type: "score"; instructions: string; criteria: string[] };

export type ClassifierAnswer =
	| { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
	| { type: "score"; score: number; confidence: number }
	| { type: "bool"; probability: number };

export interface ClassifyContext {
	state: unknown;
	questions: Record<string, ClassifierQuestion>;
	/** d1 takes pictures too, but this extension only wires the text path. */
	images?: unknown[];
}

export interface ClassifyModel {
	provider: string;
	id: string;
	baseUrl: string;
}

export interface ClassifyResult {
	api: "typesafe-system-one";
	provider: string;
	model: string;
	answers: Record<string, ClassifierAnswer>;
	usage?: { input: number; output: number; totalTokens: number; cost: { total: number } };
	stopReason: "stop" | "error" | "aborted";
	errorMessage?: string;
	timestamp: number;
}

export interface ClassifyOptions {
	fetch?: FetchLike;
	timeoutMs?: number;
	signal?: AbortSignal;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const number = (v: unknown, what: string): number => {
	if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`d1-2B returned no ${what}`);
	return v;
};

/** A request signal that also ends after timeoutMs. */
export function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** pi's classifier questions in llama.cpp's wire format. */
export function wireQuestions(questions: Record<string, ClassifierQuestion>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(questions).map(([id, q]) => {
			if (q.type === "bool") return [id, { type: "noul", instructions: q.instructions, criteria: q.criteria }];
			return [id, { type: q.type, instructions: q.instructions, criteria: q.criteria }];
		}),
	);
}

/** Read llama.cpp's answers back into pi's classifier shape. */
export function parseAnswers(answers: unknown, questions: Record<string, ClassifierQuestion>): Record<string, ClassifierAnswer> {
	if (!isRecord(answers)) throw new Error("d1-2B returned no answers");
	const out: Record<string, ClassifierAnswer> = {};
	for (const [id, q] of Object.entries(questions)) {
		const a = answers[id];
		if (!isRecord(a)) throw new Error(`d1-2B returned no answer for ${id}`);
		if (q.type === "bool") {
			out[id] = { type: "bool", probability: number(a.noul, `answer for ${id}`) };
		} else if (q.type === "choice") {
			if (typeof a.choice !== "string") throw new Error(`d1-2B returned no choice for ${id}`);
			if (!isRecord(a.probabilities)) throw new Error(`d1-2B returned no probabilities for ${id}`);
			const probabilities = Object.fromEntries(
				Object.entries(a.probabilities).map(([label, p]) => [label, number(p, `probability for ${id}.${label}`)]),
			);
			out[id] = { type: "choice", choice: a.choice, probabilities, confidence: number(a.confidence, `confidence for ${id}`) };
		} else {
			out[id] = { type: "score", score: number(a.score, `score for ${id}`), confidence: number(a.confidence, `confidence for ${id}`) };
		}
	}
	return out;
}

function usageOf(raw: unknown): ClassifyResult["usage"] {
	if (!isRecord(raw)) return undefined;
	const input = Number(raw.input_tokens ?? raw.input ?? 0);
	const output = Number(raw.output_tokens ?? raw.output ?? 0);
	if (!Number.isFinite(input) && !Number.isFinite(output)) return undefined;
	return { input: Number.isFinite(input) ? input : 0, output: Number.isFinite(output) ? output : 0, totalTokens: (Number.isFinite(input) ? input : 0) + (Number.isFinite(output) ? output : 0), cost: { total: 0 } };
}

/**
 * Ask d1-2B its questions about one state. Never throws: a server that is down or slow becomes a
 * result with stopReason "error", so the caller can fall back to its own judgement.
 */
export async function classifySystemOne(model: ClassifyModel, context: ClassifyContext, options: ClassifyOptions = {}): Promise<ClassifyResult> {
	const out: ClassifyResult = {
		api: "typesafe-system-one",
		provider: model.provider,
		model: model.id,
		answers: {},
		stopReason: "stop",
		timestamp: Date.now(),
	};
	const fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
	const timeoutMs = options.timeoutMs ?? 15000;
	try {
		if (context.images?.length) throw new Error("d1-2B through llama.cpp does not take images in this extension");
		const url = `${model.baseUrl.replace(/\/+$/, "")}/systemone`;
		const res = await fetchImpl(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: model.id, state: context.state, questions: wireQuestions(context.questions) }),
			signal: withTimeout(options.signal, timeoutMs),
		});
		const body = await res.text();
		if (!res.ok) throw new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
		let parsed: unknown;
		try {
			parsed = JSON.parse(body);
		} catch {
			throw new Error("d1-2B returned invalid JSON");
		}
		if (!isRecord(parsed)) throw new Error("d1-2B returned an unexpected response");
		out.usage = usageOf(parsed.usage);
		out.answers = parseAnswers(parsed.answers, context.questions);
		return out;
	} catch (e) {
		out.stopReason = options.signal?.aborted ? "aborted" : "error";
		out.errorMessage = options.signal?.aborted ? "aborted" : (e as Error)?.message ?? String(e);
		return out;
	}
}

export interface Health {
	ok: boolean;
	detail: string;
}

/** GET <root>/health, the check llama-server answers while it is up. */
export async function probeServer(root: string, options: { fetch?: FetchLike; timeoutMs?: number } = {}): Promise<Health> {
	const fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
	const timeoutMs = options.timeoutMs ?? 700;
	try {
		const res = await fetchImpl(`${root.replace(/\/+$/, "")}/health`, { signal: AbortSignal.timeout(timeoutMs) });
		if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
		let status = "ok";
		try {
			const body = await res.json();
			if (isRecord(body) && typeof body.status === "string") status = body.status;
		} catch {
			// a 200 is enough; some builds do not return JSON here
		}
		return { ok: true, detail: status };
	} catch (e) {
		return { ok: false, detail: (e as Error)?.message ?? String(e) };
	}
}

/** A one-line answer for a status line: yes/no with probability, or the chosen label. */
export function formatAnswer(answer: ClassifierAnswer): string {
	if (answer.type === "bool") return `${answer.probability >= 0.5 ? "yes" : "no"} (${answer.probability.toFixed(2)})`;
	if (answer.type === "choice") {
		const others = Object.entries(answer.probabilities)
			.filter(([label]) => label !== answer.choice)
			.sort(([, a], [, b]) => b - a)
			.slice(0, 3)
			.map(([label, p]) => `${label} ${p.toFixed(2)}`);
		return `${answer.choice} (${answer.confidence.toFixed(2)}${others.length ? `; ${others.join(", ")}` : ""})`;
	}
	return `${answer.score} (${answer.confidence.toFixed(2)})`;
}
