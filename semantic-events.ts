import { createHash } from "node:crypto";
import type { MonitorEventPayload, SemanticConfig, SemanticDecision, SemanticAttentionState } from "./types.ts";
import { SEMANTIC_THRESHOLDS } from "./semantic-policy.ts";
import { getTerminalHandoffContext, type TerminalHandoffContext } from "./terminal-observation.ts";

type ContextualSemanticMetadata = NonNullable<MonitorEventPayload["semantic"]> & {
	handoffIdentity?: string;
	observedAt?: string;
	reason?: string;
	lifecycle?: TerminalHandoffContext["lifecycle"];
};
export type SemanticMonitorCandidate = Omit<MonitorEventPayload, "sessionId" | "eventId" | "timestamp" | "semantic"> & {
	semantic?: ContextualSemanticMetadata;
};

const ATTENTION_EVENTS: Partial<Record<SemanticAttentionState, string>> = {
	waiting_input: "input-required",
	waiting_approval: "approval-required",
	presenting_result: "result-ready",
	blocked: "intervention-required",
};

/** Pure classification of already-recorded semantic metadata into bounded monitor candidates. */
export function classifySemanticEvents(decision: SemanticDecision, config: SemanticConfig, suppliedContext?: TerminalHandoffContext): SemanticMonitorCandidate[] {
	const context = suppliedContext ?? getTerminalHandoffContext(decision.observationHash);
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
			lineOrDiff: relevantExcerpt(context, "JEV_RESPONSE_INVALID"),
			semantic: metadata(decision, "evaluator-error", "semantic-evaluator-error", context),
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
			lineOrDiff: relevantExcerpt(context, `Semantic watch matched: ${watch.id}`),
			semantic: { ...metadata(decision, "watch", `semantic-watch:${watch.id}`, context), watchId: watch.id, probability, threshold },
		});
	}
	if (decision.action?.choice === "notify_pi" && decision.action.outcome === "notified") {
		candidates.push({
			...base,
			triggerId: "semantic:action-control:notify_pi", eventType: "semantic-action-control",
			matchedText: "semantic-action-control", lineOrDiff: relevantExcerpt(context, "Semantic action requested Pi intervention"),
			semantic: { ...metadata(decision, "action-control", "semantic-action-control", context), controlChoice: "notify_pi", confidence: decision.action.confidence, probability: decision.action.probability },
		});
	}
	// A successful terminal action suppresses redundant built-in attention/uncertainty,
	// while independent user watches above remain truthful.
	if (decision.action?.outcome === "executed") return candidates;

	const selectedProbability = decision.answers.attention.probabilities[decision.answers.attention.value];
	if (config.attention === true) {
		const eventType = ATTENTION_EVENTS[decision.answers.attention.value];
		if (eventType) {
			if (decision.answers.attention.confidence >= SEMANTIC_THRESHOLDS.choice && selectedProbability >= SEMANTIC_THRESHOLDS.choice) {
				candidates.push({
					...base,
					triggerId: `semantic:attention:${eventType}`,
					eventType,
					matchedText: eventType,
					lineOrDiff: relevantExcerpt(context, `Semantic attention: ${eventType}`),
					semantic: {
						...metadata(decision, "attention", eventType, context), attentionState: decision.answers.attention.value,
						probability: selectedProbability, threshold: SEMANTIC_THRESHOLDS.choice, confidence: decision.answers.attention.confidence,
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
			lineOrDiff: relevantExcerpt(context, "Semantic state uncertain"),
			semantic: {
				...metadata(decision, "uncertain", "semantic-uncertain", context), probability: selectedProbability,
				threshold: SEMANTIC_THRESHOLDS.choice, confidence: decision.answers.attention.confidence,
			},
		});
	}
	return candidates;
}

function relevantExcerpt(context: TerminalHandoffContext | undefined, fallback: string): string {
	return context?.relevantExcerpt ?? fallback;
}

function metadata(decision: SemanticDecision, kind: NonNullable<MonitorEventPayload["semantic"]>["kind"], reason: string, context?: TerminalHandoffContext): ContextualSemanticMetadata {
	const base = { decisionId: decision.decisionId, generation: decision.generation, model: decision.model.slice(0, 100), kind };
	if (!context) return base;
	const handoffIdentity = createHash("sha256")
		.update(JSON.stringify({ reason, contentIdentity: context.contentIdentity }))
		.digest("hex").slice(0, 24);
	return { ...base, handoffIdentity, observedAt: decision.timestamp.slice(0, 100), reason, lifecycle: context.lifecycle };
}
