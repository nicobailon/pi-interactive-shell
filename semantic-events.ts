import type { MonitorEventPayload, SemanticAnswers, SemanticConfig, SemanticDecision, SemanticAttentionState } from "./types.ts";
import { SEMANTIC_THRESHOLDS } from "./semantic-policy.ts";

export type SemanticMonitorCandidate = Omit<MonitorEventPayload, "sessionId" | "eventId" | "timestamp">;

const ATTENTION_EVENTS: Partial<Record<SemanticAttentionState, { eventType: string; condition: keyof SemanticAnswers }>> = {
	waiting_input: { eventType: "input-required", condition: "requestsInput" },
	waiting_approval: { eventType: "approval-required", condition: "requestsApproval" },
	presenting_result: { eventType: "result-ready", condition: "presentsResult" },
	blocked: { eventType: "intervention-required", condition: "requiresIntervention" },
};

/** Pure classification of already-recorded semantic metadata into bounded monitor candidates. */
export function classifySemanticEvents(decision: SemanticDecision, config: SemanticConfig): SemanticMonitorCandidate[] {
	const base = {
		strategy: "semantic" as const,
		stream: "pty" as const,
	};
	if (decision.kind === "skipped") return [];
	if (decision.kind === "evaluator-error") {
		if (config.attention !== true) return [];
		return [{
			...base,
			triggerId: "semantic:evaluator-error",
			eventType: "semantic-evaluator-error",
			matchedText: "semantic-evaluator-error",
			lineOrDiff: "JEV_RESPONSE_INVALID",
			semantic: metadata(decision, "evaluator-error"),
		}];
	}

	const candidates: SemanticMonitorCandidate[] = [];
	for (const watch of config.watches ?? []) {
		const probability = decision.answers.watches[watch.id];
		const threshold = watch.threshold ?? SEMANTIC_THRESHOLDS.noul;
		if (probability === undefined || probability < threshold) continue;
		candidates.push({
			...base,
			triggerId: `semantic:watch:${watch.id}`,
			eventType: "semantic-watch",
			matchedText: `watch:${watch.id}`,
			lineOrDiff: `Semantic watch matched: ${watch.id}`,
			semantic: { ...metadata(decision, "watch"), watchId: watch.id, probability, threshold },
		});
	}
	if (decision.action?.choice === "notify_pi" && decision.action.outcome === "notified") {
		candidates.push({
			...base,
			triggerId: "semantic:action-control:notify_pi", eventType: "semantic-action-control",
			matchedText: "semantic-action-control", lineOrDiff: "Semantic action requested Pi intervention",
			semantic: { ...metadata(decision, "action-control"), controlChoice: "notify_pi", confidence: decision.action.confidence, probability: decision.action.probability },
		});
	}
	// A successful terminal action suppresses redundant built-in attention/uncertainty,
	// while independent user watches above remain truthful.
	if (decision.action?.outcome === "executed") return candidates;

	const selectedProbability = decision.answers.attention.probabilities[decision.answers.attention.value];
	if (config.attention === true) {
		const selected = ATTENTION_EVENTS[decision.answers.attention.value];
		if (selected) {
			const conditionProbability = decision.answers[selected.condition] as number;
			if (decision.answers.attention.confidence >= SEMANTIC_THRESHOLDS.choice && selectedProbability >= SEMANTIC_THRESHOLDS.choice && conditionProbability >= SEMANTIC_THRESHOLDS.noul) {
				candidates.push({
					...base,
					triggerId: `semantic:attention:${selected.eventType}`,
					eventType: selected.eventType,
					matchedText: selected.eventType,
					lineOrDiff: `Semantic attention: ${selected.eventType}`,
					semantic: {
						...metadata(decision, "attention"), attentionState: decision.answers.attention.value,
						probability: conditionProbability, threshold: SEMANTIC_THRESHOLDS.noul, confidence: decision.answers.attention.confidence,
					},
				});
			}
		}
	}

	if (config.uncertain === "notify" && (decision.route === "uncertain" || decision.answers.attention.confidence < SEMANTIC_THRESHOLDS.choice || selectedProbability < SEMANTIC_THRESHOLDS.choice)) {
		candidates.push({
			...base,
			triggerId: "semantic:uncertain",
			eventType: "semantic-uncertain",
			matchedText: "semantic-uncertain",
			lineOrDiff: "Semantic state uncertain",
			semantic: {
				...metadata(decision, "uncertain"), probability: selectedProbability,
				threshold: SEMANTIC_THRESHOLDS.choice, confidence: decision.answers.attention.confidence,
			},
		});
	}
	return candidates;
}

function metadata(decision: SemanticDecision, kind: NonNullable<MonitorEventPayload["semantic"]>["kind"]): NonNullable<MonitorEventPayload["semantic"]> {
	return { decisionId: decision.decisionId, generation: decision.generation, model: decision.model.slice(0, 100), kind };
}
