// Baselines for the LFM3 bench: what a rule written by hand gets on the same cases, and the
// elapsed-share guess for a Watcher progress percent. They are deliberately simple; the point is
// to show what the local model adds over the obvious non-model path.
export interface WatcherCase {
	id: string;
	role: "agent" | "reviewer";
	title: string;
	desc: string;
	mins: number;
	prev: number | null;
	tail: string;
	want: string;
	range: [number, number];
}

export interface ClassifyCase {
	id: string;
	kind: "stuck" | "permission" | "blocking" | "kind" | "repo" | "duplicate";
	state: string;
	label: boolean | string;
}

/** The hand-written status line a regex would pick. */
export function watcherBaseline(c: WatcherCase): { msg: string; progress: number } {
	const t = c.tail;
	let msg: string;
	if (/Allow .*command\?|Waiting for your answer|needs your approval|Do you want to proceed|Allow this action|\[y\/N\]/i.test(t)) msg = "Waiting for permission";
	else if (/CONFLICT|merge conflict/i.test(t)) msg = "Resolving the merge conflict";
	else if (/gh pr create|pull\/new|pull request/i.test(t)) msg = "Opening the pull request";
	else if (c.role === "reviewer") msg = "Reviewing the pull request";
	else if (/✖|FAIL|failed/i.test(t)) msg = "Fixing the failing tests";
	else if (/npm test|node --test|pytest|Running tests/i.test(t)) msg = "Running the tests";
	else if (/git commit|git push/i.test(t)) msg = "Committing and pushing";
	else if (/gh pr checks|pending/i.test(t)) msg = "Waiting for CI";
	else if (/cmake --build|Building CXX|Built target/i.test(t)) msg = "Building the project";
	else if (/read\(|web_fetch|docs\//i.test(t)) msg = "Reading the documentation";
	else msg = "Editing the code";
	// The obvious guess without a model: the share of an assumed 30-minute job already spent,
	// or the previous guess if there is one.
	const progress = c.prev ?? Math.max(5, Math.min(90, Math.round((100 * c.mins) / (c.mins + 30))));
	return { msg, progress };
}

const words = (s: string) =>
	s
		.toLowerCase()
		.replace(/[^a-z0-9 ]+/g, " ")
		.split(/\s+/)
		.filter((w) => w.length > 2 && !["the", "and", "for", "with", "that", "this", "are", "was", "not", "but", "its", "from", "has", "have", "when", "what", "which"].includes(w));

function overlap(a: string, b: string): number {
	const A = new Set(words(a));
	const B = new Set(words(b));
	if (!A.size || !B.size) return 0;
	let shared = 0;
	for (const w of A) if (B.has(w)) shared++;
	return shared / Math.min(A.size, B.size);
}

/** The decision a hand-written rule gives, in the same shape as the model's answer. */
export function classifyBaseline(c: ClassifyCase): boolean | string {
	const s = c.state;
	switch (c.kind) {
		case "stuck": {
			const lines = s.split("\n").map((l) => l.trim()).filter(Boolean);
			for (const line of lines) if (lines.filter((x) => x === line).length >= 3) return true;
			return /Waiting for your answer|Which do you want|Retrying in|ETIMEDOUT|needs your approval|Allow .*command\?/i.test(s);
		}
		case "permission":
			return /Allow .*command|Do you want to proceed|Allow this action|\[y\/N\]|Permission denied|needs your approval|Waiting for your answer/i.test(s);
		case "blocking":
			if (/^(Nit|Suggestion|Praise|Question):/im.test(s)) return false;
			return /^Finding:/im.test(s);
		case "kind": {
			const title = (s.match(/^Title: (.*)$/m)?.[1] ?? s.split("\n")[0]).trim();
			if (/^(Add|Support|Allow|Make|Provide|Introduce|Let)\b/i.test(title)) return "feature";
			if (/^(How|Does|Is|Can|Why|What)\b/i.test(title)) return "question";
			if (/readme|document|docs?\b/i.test(title)) return "docs";
			return "bug";
		}
		case "repo":
			if (/pi-extras|local-edit|extensions?\//i.test(s)) return "pi-extras";
			if (/board|herdr|sidebar|doing-now/i.test(s)) return "herdr";
			if (/scripts\/check|check script|native-harness|bench/i.test(s)) return "native-harness";
			return "other";
		case "duplicate": {
			const [a, b] = s.split(/\nIssue B:/i);
			return overlap(a ?? "", b ?? "") >= 0.35;
		}
	}
}
