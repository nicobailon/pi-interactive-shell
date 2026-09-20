import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { JevClient } from "../jev-client.ts";
import { SEMANTIC_CORPUS, SEMANTIC_CORPUS_CATEGORIES, type SemanticCorpusFixture } from "../semantic-corpus.ts";
import { CORPUS_EVALUATION_ERROR, evaluateSemanticCorpus, isCorpusEvaluationPassing } from "../semantic-evaluator.ts";

function response(fixture: SemanticCorpusFixture) {
	const expected = fixture.expected;
	const p = (value: boolean) => ({ type: "noul", noul: value ? 0.95 : 0.05 });
	const states = ["working", "waiting_input", "waiting_approval", "presenting_result", "blocked", "other"];
	const probabilities = Object.fromEntries(states.map((state) => [state, state === expected.attention ? 0.95 : 0.01]));
	return {
		model: "jev-1.13.0", usage: { input_tokens: 10, output_tokens: 2 },
		answers: {
			requests_input: p(expected.requestsInput), requests_approval: p(expected.requestsApproval),
			presents_result: p(expected.presentsResult), requires_intervention: p(expected.requiresIntervention), meaningful_progress: p(expected.meaningfulProgress),
			attention: { type: "choice", choice: expected.attention, confidence: expected.route === "uncertain" ? 0.2 : 0.95, probabilities },
		},
	};
}

describe("repository semantic corpus", () => {
	it("is typed, uniquely identified, action-free, and covers every required category", () => {
		expect(new Set(SEMANTIC_CORPUS.map((fixture) => fixture.id)).size).toBe(SEMANTIC_CORPUS.length);
		expect(new Set(SEMANTIC_CORPUS.map((fixture) => fixture.category))).toEqual(new Set(SEMANTIC_CORPUS_CATEGORIES));
		for (const fixture of SEMANTIC_CORPUS) {
			expect(fixture.observation.actions).toEqual([]);
			expect(fixture.observation.session.lifecycle).toBe("running");
			expect(fixture.expected).toMatchObject({ attention: expect.any(String), route: expect.stringMatching(/^(continue|notify|uncertain)$/) });
			expect(JSON.stringify(fixture.expected)).not.toMatch(/probability|confidence/i);
		}
		expect(JSON.stringify(SEMANTIC_CORPUS.find((item) => item.category === "secret-prompt"))).not.toMatch(/hunter|actual-secret|sk-/i);
	});

	it("uses only a fake JevClient seam and aggregates deterministic predictions", async () => {
		const evaluatorSource = readFileSync("semantic-evaluator.ts", "utf-8");
		expect(evaluatorSource).not.toContain("createJevClient");
		expect(evaluatorSource).not.toContain("TYPESAFE_API_KEY");
		const requests: any[] = [];
		const byRecent = new Map(SEMANTIC_CORPUS.map((fixture) => [fixture.observation.terminal.recentOutput, fixture]));
		const client: JevClient = { evaluate: vi.fn(async (request) => {
			requests.push(request);
			const observation = (request.state as any).observation;
			const fixture = byRecent.get(observation.terminal.recentOutput)!;
			return response(fixture);
		}) };
		let now = 0;
		const clock = vi.spyOn(Date, "now").mockImplementation(() => { now += 10; return now; });
		const report = await evaluateSemanticCorpus({ client, model: "jev-1.13.0", requestTimeoutMs: 10_000 });
		clock.mockRestore();
		expect(client.evaluate).toHaveBeenCalledTimes(SEMANTIC_CORPUS.length - 1);
		expect(report).toMatchObject({ fixtureCount: 10, evaluatedCount: 9, correctCount: 9, accuracy: 1, uncertaintyCount: 1, errorCount: 0, secretSkippedCount: 1 });
		expect(report.inputTokens).toEqual({ total: 90, average: 10, samples: 9 });
		expect(report.latency).toEqual({ totalMs: 90, averageMs: 10, maxMs: 10, samples: 9 });
		expect(Object.values(report.confusion).reduce((a, b) => a + b, 0)).toBe(9);
		expect(isCorpusEvaluationPassing(report)).toBe(true);
		for (const request of requests) {
			expect((request.state as any).observation.actions).toEqual([]);
			expect(request.questions).not.toHaveProperty("action");
			expect(Object.keys(request.questions).some((key) => key.startsWith("action_ready:"))).toBe(false);
		}
	});

	it("records fixed errors for malformed responses and request failures, then continues", async () => {
		const fixtures = SEMANTIC_CORPUS.filter((fixture) => !fixture.expected.secretPrompt).slice(0, 3);
		let call = 0;
		const client: JevClient = { evaluate: vi.fn(async () => {
			call += 1;
			if (call === 1) return { provider_body: "must-not-leak" };
			if (call === 2) throw new Error("provider body must-not-leak");
			return response(fixtures[2]!);
		}) };
		const report = await evaluateSemanticCorpus({ client, model: "jev-1.13.0", requestTimeoutMs: 999_999, fixtures });
		expect(report.errorCount).toBe(2);
		expect(report).toMatchObject({ evaluatedCount: 1, correctCount: 1, accuracy: 1, secretSkippedCount: 0 });
		expect(isCorpusEvaluationPassing(report)).toBe(false);
		expect(report.latency.samples).toBe(3);
		expect(report.predictions.map((item) => item.status)).toEqual(["error", "error", "evaluated"]);
		expect(report.predictions[0]?.error).toBe(CORPUS_EVALUATION_ERROR);
		expect(JSON.stringify(report)).not.toContain("must-not-leak");
		expect((client.evaluate as any).mock.calls.every((callArgs: any[]) => callArgs[1].timeoutMs === 30_000)).toBe(true);
	});
});
