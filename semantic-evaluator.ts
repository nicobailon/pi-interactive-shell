import type { JevClient } from "./jev-client.ts";
import { buildSemanticRequest, parseSemanticResult, routeSemanticAnswers } from "./semantic-supervisor.ts";
import { containsSecretPrompt } from "./terminal-observation.ts";
import type { SemanticAnswers, SemanticAttentionState } from "./types.ts";
import { SEMANTIC_CORPUS, type SemanticCorpusExpected, type SemanticCorpusFixture } from "./semantic-corpus.ts";
import { SEMANTIC_THRESHOLDS } from "./semantic-policy.ts";

export const CORPUS_EVALUATION_ERROR = "semantic evaluator request or response failed";

export interface CorpusPrediction {
	fixtureId: string;
	status: "evaluated" | "secret-skipped" | "error";
	attention?: SemanticAttentionState;
	route?: "continue" | "notify" | "uncertain";
	correct: boolean;
	atomicCorrect: boolean;
	latencyMs: number;
	inputTokens?: number;
	error?: typeof CORPUS_EVALUATION_ERROR;
}

export interface CorpusEvaluationReport {
	model: string;
	fixtureCount: number;
	evaluatedCount: number;
	correctCount: number;
	accuracy: number;
	atomicCorrectCount: number;
	atomicAccuracy: number;
	uncertaintyCount: number;
	errorCount: number;
	secretSkippedCount: number;
	latency: { totalMs: number; averageMs: number; maxMs: number; samples: number };
	inputTokens: { total: number; average: number; samples: number };
	confusion: Record<string, number>;
	predictions: CorpusPrediction[];
}

export function isCorpusEvaluationPassing(report: CorpusEvaluationReport): boolean {
	return report.errorCount === 0 && report.evaluatedCount > 0 && report.correctCount === report.evaluatedCount
		&& report.predictions.every((item) => item.status !== "secret-skipped" || item.correct);
}

export async function evaluateSemanticCorpus(options: {
	client: JevClient;
	model: string;
	requestTimeoutMs: number;
	fixtures?: readonly SemanticCorpusFixture[];
}): Promise<CorpusEvaluationReport> {
	const fixtures = options.fixtures ?? SEMANTIC_CORPUS;
	const timeoutMs = Math.max(1_000, Math.min(30_000, Math.trunc(options.requestTimeoutMs)));
	const predictions: CorpusPrediction[] = [];
	const confusion: Record<string, number> = {};
	for (const fixture of fixtures) {
		if (containsSecretPrompt(fixture.observation)) {
			const correct = fixture.expected.secretPrompt === true;
			predictions.push({ fixtureId: fixture.id, status: "secret-skipped", correct, atomicCorrect: correct, latencyMs: 0 });
			continue;
		}
		const started = Date.now();
		try {
			const raw = await options.client.evaluate(buildSemanticRequest(fixture.observation, {}, options.model), {
				signal: new AbortController().signal, timeoutMs,
			});
			const parsed = parseSemanticResult(raw, {}, options.model);
			const route = routeSemanticAnswers(parsed.answers, {});
			const correct = matchesOperationalOutcome(parsed.answers, route, fixture.expected);
			const atomicCorrect = matchesAtomicExpected(parsed.answers, route, fixture.expected);
			const key = `${fixture.expected.attention}->${parsed.answers.attention.value}`;
			confusion[key] = (confusion[key] ?? 0) + 1;
			predictions.push({ fixtureId: fixture.id, status: "evaluated", attention: parsed.answers.attention.value, route, correct, atomicCorrect, latencyMs: Date.now() - started, inputTokens: parsed.inputTokens });
		} catch {
			predictions.push({ fixtureId: fixture.id, status: "error", correct: false, atomicCorrect: false, latencyMs: Date.now() - started, error: CORPUS_EVALUATION_ERROR });
		}
	}
	const evaluated = predictions.filter((item) => item.status === "evaluated");
	const tokenSamples = evaluated.filter((item) => item.inputTokens !== undefined);
	const tokenTotal = tokenSamples.reduce((sum, item) => sum + item.inputTokens!, 0);
	const latencySamples = predictions.filter((item) => item.status !== "secret-skipped");
	const latencyTotal = latencySamples.reduce((sum, item) => sum + item.latencyMs, 0);
	return {
		model: options.model, fixtureCount: fixtures.length, evaluatedCount: evaluated.length,
		correctCount: evaluated.filter((item) => item.correct).length,
		accuracy: evaluated.length ? evaluated.filter((item) => item.correct).length / evaluated.length : 0,
		atomicCorrectCount: evaluated.filter((item) => item.atomicCorrect).length,
		atomicAccuracy: evaluated.length ? evaluated.filter((item) => item.atomicCorrect).length / evaluated.length : 0,
		uncertaintyCount: evaluated.filter((item) => item.route === "uncertain").length,
		errorCount: predictions.filter((item) => item.status === "error").length,
		secretSkippedCount: predictions.filter((item) => item.status === "secret-skipped").length,
		latency: { totalMs: latencyTotal, averageMs: latencySamples.length ? latencyTotal / latencySamples.length : 0, maxMs: Math.max(0, ...latencySamples.map((item) => item.latencyMs)), samples: latencySamples.length },
		inputTokens: { total: tokenTotal, average: tokenSamples.length ? tokenTotal / tokenSamples.length : 0, samples: tokenSamples.length },
		confusion, predictions,
	};
}

function matchesOperationalOutcome(answers: SemanticAnswers, route: "continue" | "notify" | "uncertain", expected: SemanticCorpusExpected): boolean {
	if (answers.attention.value !== expected.attention) return false;
	if (expected.route === "notify") return route === "notify";
	if (expected.route === "uncertain") return route === "uncertain";
	return route !== "notify";
}

function matchesAtomicExpected(answers: SemanticAnswers, route: "continue" | "notify" | "uncertain", expected: SemanticCorpusExpected): boolean {
	return answers.attention.value === expected.attention && route === expected.route
		&& (answers.requestsInput >= SEMANTIC_THRESHOLDS.noul) === expected.requestsInput
		&& (answers.requestsApproval >= SEMANTIC_THRESHOLDS.noul) === expected.requestsApproval
		&& (answers.presentsResult >= SEMANTIC_THRESHOLDS.noul) === expected.presentsResult
		&& (answers.requiresIntervention >= SEMANTIC_THRESHOLDS.noul) === expected.requiresIntervention
		&& (answers.meaningfulProgress >= SEMANTIC_THRESHOLDS.noul) === expected.meaningfulProgress;
}
