import { describe, expect, it } from "vitest";
import { classifySemanticEvents } from "../semantic-events.ts";
import type { TerminalHandoffContext } from "../terminal-observation.ts";
import type { SemanticDecision, SemanticAttentionState } from "../types.ts";

function observation(options: {
	attention?: SemanticAttentionState;
	confidence?: number;
	selectedProbability?: number;
	conditions?: Partial<Record<"requestsInput" | "requestsApproval" | "presentsResult" | "requiresIntervention", number>>;
	watches?: Record<string, number>;
	route?: "continue" | "notify" | "uncertain";
} = {}): SemanticDecision {
	const attention = options.attention ?? "working";
	const probabilities = { working: 0.02, waiting_input: 0.02, waiting_approval: 0.02, presenting_result: 0.02, blocked: 0.02, other: 0.02 };
	probabilities[attention] = options.selectedProbability ?? 0.9;
	return {
		kind: "observation", sessionId: "s", decisionId: 7, timestamp: "2026-09-14T00:00:00Z",
		observationHash: "must-not-leak", generation: 4, model: "jev-1.13.0", latencyMs: 3, route: options.route ?? "continue",
		answers: {
			requestsInput: options.conditions?.requestsInput ?? 0.05,
			requestsApproval: options.conditions?.requestsApproval ?? 0.05,
			presentsResult: options.conditions?.presentsResult ?? 0.05,
			requiresIntervention: options.conditions?.requiresIntervention ?? 0.05,
			meaningfulProgress: 0.9, watches: options.watches ?? {},
			attention: { value: attention, confidence: options.confidence ?? 0.9, probabilities },
		},
	};
}

describe("semantic event classification", () => {
	it("keeps built-in attention and uncertainty default-off", () => {
		const decision = observation({ attention: "waiting_input", conditions: { requestsInput: 0.99 }, route: "uncertain", confidence: 0.2 });
		expect(classifySemanticEvents(decision, {})).toEqual([]);
	});

	it.each([
		["waiting_input", "requestsInput", "input-required"],
		["waiting_approval", "requestsApproval", "approval-required"],
		["presenting_result", "presentsResult", "result-ready"],
		["blocked", "requiresIntervention", "intervention-required"],
	] as const)("emits confident attention %s without requiring a duplicate Noul", (attention, condition, eventType) => {
		const event = classifySemanticEvents(observation({ attention, conditions: { [condition]: 0.05 } }), { attention: true });
		expect(event).toHaveLength(1);
		expect(event[0]).toMatchObject({ triggerId: `semantic:attention:${eventType}`, eventType, semantic: { kind: "attention", attentionState: attention, probability: 0.9, threshold: 0.7, confidence: 0.9 } });
		expect(JSON.stringify(event[0])).not.toContain("must-not-leak");
	});

	it("emits uncertainty only for explicit notify policy", () => {
		const decision = observation({ attention: "other", confidence: 0.69, selectedProbability: 0.69, route: "uncertain" });
		expect(classifySemanticEvents(decision, { uncertain: "continue" })).toEqual([]);
		expect(classifySemanticEvents(decision, { uncertain: "notify" })[0]).toMatchObject({ eventType: "semantic-uncertain", semantic: { kind: "uncertain", threshold: 0.7 } });
	});

	it("emits every independently satisfied watch at inclusive thresholds", () => {
		const events = classifySemanticEvents(observation({ watches: { first: 0.8, second: 0.6, low: 0.79 } }), {
			watches: [
				{ id: "first", condition: "one" },
				{ id: "second", condition: "two", threshold: 0.6 },
				{ id: "low", condition: "three" },
			],
		});
		expect(events.map((event) => event.triggerId)).toEqual(["semantic:watch:first", "semantic:watch:second"]);
		expect(events.map((event) => event.semantic?.watchId)).toEqual(["first", "second"]);
	});

	it("suppresses redundant built-in wake after an executed action but preserves watches", () => {
		const decision = observation({ attention: "waiting_input", conditions: { requestsInput: 0.99 }, watches: { independent: 0.9 } });
		decision.action = { choice: "confirm", actionId: "confirm", confidence: 0.96, probability: 0.96, readiness: 0.97, outcome: "executed", reason: "written-once", budgetCount: 1 };
		const events = classifySemanticEvents(decision, { attention: true, watches: [{ id: "independent", condition: "still true" }] });
		expect(events.map((event) => event.triggerId)).toEqual(["semantic:watch:independent"]);
	});

	it("turns notify_pi into one bounded candidate for the shared monitor sink", () => {
		const decision = observation();
		decision.action = { choice: "notify_pi", confidence: 0.96, probability: 0.96, outcome: "notified", reason: "shared-monitor-event", budgetCount: 0 };
		const events = classifySemanticEvents(decision, {});
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ triggerId: "semantic:action-control:notify_pi", semantic: { kind: "action-control", controlChoice: "notify_pi", confidence: 0.96, probability: 0.96 } });
		expect(JSON.stringify(events[0])).not.toContain("must-not-leak");
	});

	it("emits bounded evaluator errors only when attention is enabled and never skipped decisions", () => {
		const error: SemanticDecision = { kind: "evaluator-error", sessionId: "s", decisionId: 1, timestamp: "now", observationHash: "hash", generation: 1, model: "jev-1.13.0", latencyMs: 1, route: "error", error: "provider raw body" };
		expect(classifySemanticEvents(error, {})).toEqual([]);
		const events = classifySemanticEvents(error, { attention: true });
		expect(events[0]).toMatchObject({ eventType: "semantic-evaluator-error", semantic: { kind: "evaluator-error" } });
		expect(JSON.stringify(events)).not.toContain("provider raw body");
		const skipped: SemanticDecision = { kind: "skipped", sessionId: "s", decisionId: 2, timestamp: "now", observationHash: "hash", generation: 2, model: "jev-1.13.0", latencyMs: 0, route: "continue", reason: "secret-prompt" };
		expect(classifySemanticEvents(skipped, { attention: true, uncertain: "notify", watches: [{ id: "x", condition: "x" }] })).toEqual([]);
	});

	it("carries stable contextual identity and lifecycle metadata without private observation hashes", () => {
		const context: TerminalHandoffContext = { relevantExcerpt: "Proceed with deployment?", contentIdentity: "content-a", lifecycle: "running" };
		const first = classifySemanticEvents(observation({ attention: "waiting_input" }), { attention: true }, context)[0]!;
		const later = observation({ attention: "waiting_input" });
		later.decisionId = 99;
		later.generation = 100;
		later.timestamp = "2026-09-14T00:02:00Z";
		const second = classifySemanticEvents(later, { attention: true }, context)[0]!;

		expect(first.lineOrDiff).toBe("Proceed with deployment?");
		expect(first.semantic).toMatchObject({ lifecycle: "running", reason: "input-required", observedAt: "2026-09-14T00:00:00Z" });
		expect(second.semantic?.handoffIdentity).toBe(first.semantic?.handoffIdentity);
		expect(JSON.stringify(first)).not.toContain("must-not-leak");
	});

	it("changes contextual identity when a same-type question has new content", () => {
		const first = classifySemanticEvents(observation({ attention: "waiting_input" }), { attention: true }, {
			relevantExcerpt: "Deploy alpha?", contentIdentity: "alpha", lifecycle: "running",
		})[0]!;
		const second = classifySemanticEvents(observation({ attention: "waiting_input" }), { attention: true }, {
			relevantExcerpt: "Deploy beta?", contentIdentity: "beta", lifecycle: "running",
		})[0]!;
		expect(second.semantic?.handoffIdentity).not.toBe(first.semantic?.handoffIdentity);
	});
});
