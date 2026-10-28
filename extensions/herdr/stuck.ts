// "Is this agent stuck, or waiting on a prompt?" — a small helper over herdr's plain status and,
// when a classifier is registered, over that classifier too.
//
// HRN-15's lfm3 extension registers d1-2B as the classifier lfm3/d1-2b. Nothing is imported from
// it: if it is loaded, the model is found in the model registry and used; if it is missing, off, or
// the local server is down, the answer falls back to herdr's status alone.
import type { HerdrConfig, StuckModel } from "./config.ts";
import type { CommandRunner } from "./exec.ts";
import { ToolError } from "./errors.ts";
import { listAgents, readAgent, type AgentSummary } from "./herdr.ts";

export interface ClassifierRegistryLike {
	getModelOfType(type: "classifier", provider: string, id: string): unknown;
	classify(model: unknown, context: unknown, options?: { signal?: AbortSignal }): Promise<ClassifierResultLike>;
}

export interface ClassifierResultLike {
	stopReason?: string;
	errorMessage?: string;
	answers?: Record<string, unknown>;
}

export interface StuckDeps {
	config: HerdrConfig;
	run: CommandRunner;
	registry?: ClassifierRegistryLike;
}

export interface StuckResult {
	target: string;
	name?: string;
	status: string;
	stuck: boolean | null;
	waiting: boolean | null;
	source: "classifier" | "status";
	model?: string;
	confidence?: number;
	reason: string;
	recentOutput?: string;
}

function findAgent(agents: AgentSummary[], target: string): AgentSummary | undefined {
	const exact = agents.find(
		(agent) => agent.name === target || agent.paneId === target || agent.terminalId === target || agent.session === target,
	);
	if (exact) return exact;
	const lower = target.toLowerCase();
	return agents.find((agent) =>
		[agent.name, agent.paneId, agent.terminalId, agent.title, agent.cwd]
			.filter(Boolean)
			.some((field) => String(field).toLowerCase() === lower),
	);
}

function statusAnswer(status: string): { stuck: boolean | null; waiting: boolean | null; reason: string } {
	if (status === "blocked") return { stuck: true, waiting: true, reason: "herdr status is blocked" };
	if (status === "idle") return { stuck: false, waiting: false, reason: "herdr status is idle" };
	if (status === "done") return { stuck: false, waiting: false, reason: "herdr status is done" };
	if (status === "working") return { stuck: false, waiting: false, reason: "herdr status is working" };
	return { stuck: null, waiting: null, reason: `herdr status is ${status || "unknown"}` };
}

function probability(answer: unknown): number | undefined {
	if (!answer || typeof answer !== "object") return undefined;
	const raw = (answer as { probability?: unknown }).probability;
	if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
	return Math.max(0, Math.min(1, raw));
}

function resolveModel(registry: ClassifierRegistryLike | undefined, wanted: StuckModel | undefined): unknown | undefined {
	if (!registry || !wanted) return undefined;
	try {
		return registry.getModelOfType("classifier", wanted.provider, wanted.id);
	} catch {
		return undefined;
	}
}

/**
 * Read the agent's status and recent output, then ask the configured classifier (default
 * lfm3/d1-2b, HRN-15) whether it is stuck or waiting. Falls back to the plain status.
 */
export async function agentStuck(
	deps: StuckDeps,
	target: string,
	options: { lines?: number; signal?: AbortSignal } = {},
): Promise<StuckResult> {
	const agents = await listAgents(deps.config, deps.run, {}, { signal: options.signal });
	const agent = findAgent(agents, target);
	if (!agent) {
		throw new ToolError("agent_not_found", `no herdr agent matches ${target}`);
	}
	const status = agent.status;
	const read = await readAgent(deps.config, deps.run, agent.paneId || target, {
		lines: options.lines ?? 120,
		signal: options.signal,
	});
	const fallback = statusAnswer(status);
	const base: StuckResult = {
		target,
		name: agent.name,
		status,
		...fallback,
		source: "status",
		recentOutput: read.text.slice(-8_000),
	};

	const model = resolveModel(deps.registry, deps.config.stuckModel);
	if (!model) {
		const wanted = deps.config.stuckModel ? ` (${deps.config.stuckModel.provider}/${deps.config.stuckModel.id})` : "";
		return { ...base, reason: `${fallback.reason}; classifier${wanted} is not registered, so this is the status alone` };
	}

	try {
		const result = await deps.registry!.classify(
			model,
			{
				state: {
					agent: {
						name: agent.name,
						program: agent.agent,
						title: agent.title,
						display: agent.display,
						cwd: agent.cwd,
					},
					status,
					recentOutput: read.text.slice(-12_000),
				},
				questions: {
					stuck: {
						type: "bool",
						instructions:
							"Is this coding agent stuck: has it stopped making progress, or is it waiting for an answer, a permission or an approval it cannot give itself?",
						criteria: {
							true: "Stopped, looping, failed, or waiting on a prompt or permission",
							false: "Working normally, or finished",
						},
					},
					waiting: {
						type: "bool",
						instructions:
							"Is the terminal output showing a prompt, question, permission request or approval that is waiting for a human or another agent to answer?",
						criteria: {
							true: "A question or permission prompt is on screen and unanswered",
							false: "No unanswered prompt is on screen",
						},
					},
				},
			},
			{ signal: options.signal },
		);
		if (result.stopReason && result.stopReason !== "stop") {
			return {
				...base,
				reason: `${fallback.reason}; classifier failed (${result.errorMessage ?? result.stopReason}), so this is the status alone`,
			};
		}
		const stuck = probability(result.answers?.stuck);
		const waiting = probability(result.answers?.waiting);
		if (stuck === undefined || waiting === undefined) {
			return { ...base, reason: `${fallback.reason}; classifier returned no usable answer, so this is the status alone` };
		}
		const isStuck = stuck >= 0.5;
		const isWaiting = waiting >= 0.5;
		const decision = (p: number, answer: boolean) => (answer ? p : 1 - p);
		return {
			...base,
			stuck: isStuck,
			waiting: isWaiting,
			source: "classifier",
			model:
				deps.config.stuckModel ?
					`${deps.config.stuckModel.provider}/${deps.config.stuckModel.id}`
				:	undefined,
			confidence: Math.min(decision(stuck, isStuck), decision(waiting, isWaiting)),
			reason: `classifier: stuck ${(stuck * 100).toFixed(0)}%, waiting ${(waiting * 100).toFixed(0)}%`,
		};
	} catch (e) {
		if (options.signal?.aborted) throw new ToolError("aborted", "the call was aborted");
		return { ...base, reason: `${fallback.reason}; classifier failed (${(e as Error).message}), so this is the status alone` };
	}
}
