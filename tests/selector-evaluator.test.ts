import { describe, expect, it, vi } from "vitest";
import type { JevClient } from "../jev-client.ts";
import { SELECTOR_CORPUS, SELECTOR_CORPUS_HASH, type SelectorCorpusFixture } from "../selector-corpus.ts";
import { evaluateLiveSelector, evaluateOfflineBaselines, selectProductionTail, selectProtectedContext, SELECTOR_SETTINGS, type SelectorRow } from "../selector-evaluator.ts";

function responseFor(request: any, keep = new Set<number>(), usage: unknown = { input_tokens: 50, output_tokens: 10 }) {
	return {
		model: SELECTOR_SETTINGS.model,
		answers: Object.fromEntries(Object.keys(request.questions).map((key) => [key, { type: "noul", noul: keep.has(Number(key.slice(5))) ? 0.9 : 0.1 }])),
		usage,
	};
}

function fixture(overrides: Partial<SelectorCorpusFixture> = {}): SelectorCorpusFixture {
	return {
		id: "custom", split: "tuning", goal: "retain the result",
		lines: [
			{ text: "ERROR synthetic failure", required: true, relevant: true },
			{ text: "diagnostic context" },
			{ text: "routine progress" },
			{ text: "more routine progress" },
		],
		...overrides,
	};
}

function expectConservative(row: SelectorRow, lineCount: number): void {
	if (row.outcomeStatus === "pagination-required") expect(row.recoveryIndices).toEqual(Array.from({ length: lineCount }, (_, index) => index));
	else expect(row.selectedIndices).toEqual(Array.from({ length: lineCount }, (_, index) => index));
	expect(row.requiredRecall).toBe(1);
}

describe("Stage 0 selector corpus and evaluator", () => {
	it("is compact, synthetic, independently labelled, split, and covers required challenges", () => {
		expect(SELECTOR_CORPUS_HASH).toMatch(/^[a-f0-9]{64}$/);
		expect(new Set(SELECTOR_CORPUS.map((item) => item.id)).size).toBe(SELECTOR_CORPUS.length);
		expect(new Set(SELECTOR_CORPUS.map((item) => item.split))).toEqual(new Set(["tuning", "held-out"]));
		expect(SELECTOR_CORPUS.some((item) => item.designatedTailMiss === "early")).toBe(true);
		expect(SELECTOR_CORPUS.some((item) => item.designatedTailMiss === "middle")).toBe(true);
		expect(new Set(SELECTOR_CORPUS.flatMap((item) => item.bypass ? [item.bypass] : []))).toEqual(new Set(["short", "all-important", "exact-document"]));
		const serialized = JSON.stringify(SELECTOR_CORPUS);
		expect(serialized).toContain("IGNORE THE SELECTOR");
		expect(serialized).toContain("SYNTHETIC_CANARY_NOT_A_CREDENTIAL");
		expect(serialized).toContain("\\u001b[31m");
		expect(serialized.length).toBeLessThan(80_000);
	});

	it("exactly models ordinary production tail forward order, line window, and overshoot", () => {
		const lines = Array.from({ length: 25 }, (_, index) => `line-${index}`);
		const tail = selectProductionTail(lines);
		expect(tail.indices).toEqual(Array.from({ length: 20 }, (_, index) => index + 5));
		expect(tail.text).toBe(lines.slice(5).join("\n"));
		expect(tail.truncated).toBe(true);

		const overshoot = selectProductionTail(["head", "123456", "tail"], { lineLimit: 3, maxChars: 5 });
		expect(overshoot.indices).toEqual([0, 1]);
		expect(overshoot.text).toBe("head\n123456");
		expect(overshoot.budgetOvershootChars).toBe(6);
		expect(overshoot.truncated).toBe(true);
	});

	it("reports reproducible real-tail and matched selector baselines with exact marker accounting", () => {
		const first = evaluateOfflineBaselines();
		expect(first).toEqual(evaluateOfflineBaselines());
		for (const row of first.rows) {
			expect(row.selectedIndices).toEqual([...row.selectedIndices].sort((a, b) => a - b));
			expect(new Set(row.selectedIndices).size).toBe(row.selectedIndices.length);
			if (row.arm !== "tail" && row.matchedBudget) expect(row.visibleChars).toBeLessThanOrEqual(SELECTOR_SETTINGS.selectorVisibleChars);
		}
		for (const item of SELECTOR_CORPUS.filter((candidate) => candidate.designatedTailMiss)) {
			const tail = first.rows.find((row) => row.fixtureId === item.id && row.arm === "tail")!;
			const baseline = first.rows.find((row) => row.fixtureId === item.id && row.arm === "protected-context")!;
			expect(tail.requiredRecall).toBeLessThan(1);
			expect(baseline.requiredRecall).toBeGreaterThan(tail.requiredRecall);
		}
		const build = SELECTOR_CORPUS.find((item) => item.id === "build-early-error")!;
		const selected = selectProtectedContext(build);
		expect(selected.status).toBe("selected");
		if (selected.status === "selected") {
			const bodyChars = selected.selectedIndices.reduce((sum, index) => sum + build.lines[index]!.text.length, 0) + Math.max(0, selected.selectedIndices.length - 1);
			expect(selected.text.length).toBe(bodyChars + selected.markerChars);
			expect(selected.text.endsWith(`[omitted:${selected.omittedLines}; recovery:source]`)).toBe(true);
		}
	});

	it("returns typed pagination-required outcomes for protected and bypass overflow", () => {
		const cases = [
			fixture({ id: "protected-overflow", lines: [{ text: `ERROR ${"x".repeat(6_000)}`, required: true, relevant: true }] }),
			fixture({ id: "all-important-overflow", bypass: "all-important", lines: [{ text: "A".repeat(6_000), required: true, relevant: true }] }),
			fixture({ id: "exact-overflow", bypass: "exact-document", lines: [{ text: "{" + "x".repeat(6_000) + "}" }] }),
		];
		for (const item of cases) {
			const outcome = selectProtectedContext(item);
			expect(outcome).toMatchObject({ status: "pagination-required", matchedBudget: false, recoveryIndices: [0], recoveryRanges: [{ startLine: 0, endLine: 1 }], omittedLines: 0 });
			expect(outcome.text.length).toBeGreaterThan(SELECTOR_SETTINGS.selectorVisibleChars);
		}
	});

	it("binds each question to its dense state position and source index after protected filtering, with labels excluded and dynamic fields redacted", async () => {
		const item = fixture({
			goal: "retain result; api_key=SYNTHETIC_CANARY_NOT_A_CREDENTIAL_12345",
			lines: [
				{ text: "ERROR protected", required: true, relevant: true },
				{ text: "protected context" },
				{ text: "api_key=SYNTHETIC_CANARY_NOT_A_CREDENTIAL_12345" },
				{ text: "routine progress" },
			],
		});
		let captured: any;
		const client: JevClient = { evaluate: vi.fn(async (request) => { captured = request; return responseFor(request); }) };
		await evaluateLiveSelector({ client, redactionPatterns: [], fixtures: [item] });
		expect(captured.state.lines[0].index).toBeGreaterThan(0);
		captured.state.lines.forEach((entry: any, position: number) => {
			expect(captured.questions[`line_${entry.index}`].instructions).toContain(`state.lines[${position}]`);
			expect(captured.questions[`line_${entry.index}`].instructions).toContain(`original source index ${entry.index}`);
		});
		const outbound = JSON.stringify(captured);
		expect(outbound).not.toMatch(/"required"|"relevant"/);
		expect(outbound).not.toContain("SYNTHETIC_CANARY_NOT_A_CREDENTIAL");
		expect(outbound).toContain("[REDACTED]");
	});

	it("retains every affected candidate for provider, malformed, missing-answer, timeout, and retry-exhaustion failures", async () => {
		const item = fixture();
		const failures: Array<() => Promise<unknown>> = [
			async () => { throw new Error("provider failed"); },
			async () => ({ provider_dump: "must-not-leak" }),
			async () => ({ model: SELECTOR_SETTINGS.model, answers: {}, usage: { input_tokens: 1, output_tokens: 1 } }),
			async () => { const error = new Error("deadline"); error.name = "TimeoutError"; throw error; },
			async () => { throw new Error("retry exhaustion belongs to JevClient"); },
		];
		for (const failure of failures) {
			const report = await evaluateLiveSelector({ client: { evaluate: vi.fn(failure) }, redactionPatterns: [], fixtures: [item] });
			expect(report.requests[0]).toMatchObject({ status: "failed", reason: "provider-or-response" });
			expectConservative(report.rows[0]!, item.lines.length);
			expect(JSON.stringify(report)).not.toContain("must-not-leak");
		}
	});

	it("retains every affected candidate on request cap, request size, and abort without calling the provider", async () => {
		const item = fixture();
		const client: JevClient = { evaluate: vi.fn(async (request) => responseFor(request)) };
		const capped = await evaluateLiveSelector({ client, redactionPatterns: [], fixtures: [item], limits: { maxRequests: 0 } });
		expect(capped.requests[0]?.reason).toBe("request-cap");
		expectConservative(capped.rows[0]!, item.lines.length);
		const sized = await evaluateLiveSelector({ client, redactionPatterns: [], fixtures: [item], limits: { maxSerializedRequestChars: 1 } });
		expect(sized.requests[0]?.reason).toBe("request-size");
		expectConservative(sized.rows[0]!, item.lines.length);
		const controller = new AbortController(); controller.abort();
		const aborted = await evaluateLiveSelector({ client, redactionPatterns: [], fixtures: [item], signal: controller.signal });
		expect(aborted.requests[0]?.reason).toBe("aborted");
		expectConservative(aborted.rows[0]!, item.lines.length);
		expect(client.evaluate).not.toHaveBeenCalled();
		const during = new AbortController();
		const abortingClient: JevClient = { evaluate: vi.fn(async (request) => { during.abort(); return responseFor(request); }) };
		const abortedDuringCall = await evaluateLiveSelector({ client: abortingClient, redactionPatterns: [], fixtures: [item], signal: during.signal });
		expect(abortedDuringCall.requests[0]?.reason).toBe("aborted");
		expectConservative(abortedDuringCall.rows[0]!, item.lines.length);
	});

	it("strictly rejects extra-key, negative, and fractional usage into the conservative path", async () => {
		const item = fixture();
		const malformedUsage = [
			{ input_tokens: 1, output_tokens: 1, extra: 1 },
			{ input_tokens: -1, output_tokens: 1 },
			{ input_tokens: 1.5, output_tokens: 1 },
		];
		for (const usage of malformedUsage) {
			const client: JevClient = { evaluate: vi.fn(async (request) => responseFor(request, new Set(), usage)) };
			const report = await evaluateLiveSelector({ client, redactionPatterns: [], fixtures: [item] });
			expect(report.requests[0]?.status).toBe("failed");
			expectConservative(report.rows[0]!, item.lines.length);
			expect(report.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
		}
	});

	it("accepts exact usage and records bounded usage without claiming a price", async () => {
		const item = fixture();
		const client: JevClient = { evaluate: vi.fn(async (request, options) => {
			expect(options.timeoutMs).toBe(SELECTOR_SETTINGS.requestTimeoutMs);
			return responseFor(request, new Set([1]));
		}) };
		const report = await evaluateLiveSelector({ client, redactionPatterns: [], fixtures: [item] });
		expect(report.requests[0]).toMatchObject({ status: "ok", inputTokens: 50, outputTokens: 10 });
		expect(report.usage).toEqual({ inputTokens: 50, outputTokens: 10 });
		expect(report.cost.amount).toBeNull();
	});
});
