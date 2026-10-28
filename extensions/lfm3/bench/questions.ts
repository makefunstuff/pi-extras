// The questions the bench asks d1-2B for each kind of case, and how its answer is read. The
// product uses the same three-question set for "stuck": a repeated failing command, a permission
// prompt and a question to the user are three different reasons an agent is not making progress,
// and asking all three in one request was much better than one generic question.
import type { ClassifierAnswer, ClassifierQuestion } from "../client.ts";
import type { ClassifyCase } from "./baseline.ts";

export function questionsFor(c: ClassifyCase): Record<string, ClassifierQuestion> {
	switch (c.kind) {
		case "stuck":
			return {
				repeat: { type: "bool", instructions: "Is the agent repeating the same failing command again and again without making progress?" },
				waiting: { type: "bool", instructions: "Is the agent waiting for the user to answer a question or choose an option before it can continue?" },
				permission: { type: "bool", instructions: "Is the agent waiting for a permission prompt or approval before it can continue?" },
			};
		case "permission":
			return {
				answer: { type: "bool", instructions: "Is the coding agent waiting for a permission prompt or for approval before it can continue?" },
			};
		case "blocking":
			return {
				answer: { type: "bool", instructions: "Is this review finding blocking, meaning the change must not be merged until the finding is fixed?" },
			};
		case "kind":
			return {
				answer: {
					type: "choice",
					instructions: "What kind of issue is this?",
					criteria: {
						bug: "Something is broken and should work",
						feature: "A new capability is requested",
						question: "The author asks how something works or how to do something",
						docs: "Documentation is wrong or missing",
						chore: "Maintenance, dependencies or refactoring",
					},
				},
			};
		case "repo":
			return {
				answer: {
					type: "choice",
					instructions: "Which repository does this issue belong to?",
					criteria: {
						"pi-extras": "The pi-extras extension package (edit tool, guards, local models)",
						herdr: "The Herdr terminal and its work board",
						"native-harness": "The native-harness check scripts and benches",
						other: "A different repository",
					},
				},
			};
		case "duplicate":
			return {
				answer: { type: "bool", instructions: "Are these two issues reporting the same problem?" },
			};
	}
}

/** The label the model chose, in the same shape as the case's label. */
export function answerFor(c: ClassifyCase, answers: Record<string, ClassifierAnswer>): boolean | string | number {
	if (c.kind === "stuck") {
		const yes = ["repeat", "waiting", "permission"].some((id) => {
			const a = answers[id];
			return a?.type === "bool" && a.probability >= 0.5;
		});
		return yes;
	}
	const a = answers.answer;
	if (!a) throw new Error(`no answer for ${c.id}`);
	if (a.type === "bool") return a.probability >= 0.5;
	if (a.type === "choice") return a.choice;
	return a.score;
}
