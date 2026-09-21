import { describe, expect, it, vi } from "vitest";
import type { JevClient } from "../jev-client.ts";
import { SELECTOR_CORPUS, SELECTOR_CORPUS_HASH } from "../selector-corpus.ts";
import { evaluateLiveSelector, evaluateOfflineBaselines, SELECTOR_SETTINGS } from "../selector-evaluator.ts";

function responseFor(request: any, keep = new Set<number>()) {
	return {
		model: SELECTOR_SETTINGS.model,
		answers: Object.fromEntries(Object.keys(request.questions).map((key) => [key, { type: "noul", noul: keep.has(Number(key.slice(5))) ? 0.9 : 0.1 }])),
		usage: { input_tokens: 50, output_tokens: 10 },
	};
}

describe("Stage 0 selector corpus and evaluator", () => {
	it("is compact, synthetic, independently labelled, split, and covers required challenges", () => {
		expect(SELECTOR_CORPUS_HASH).toMatch(/^[a-f0-9]{64}$/);
		expect(new Set(SELECTOR_CORPUS.map((fixture) => fixture.id)).size).toBe(SELECTOR_CORPUS.length);
		expect(new Set(SELECTOR_CORPUS.map((fixture) => fixture.split))).toEqual(new Set(["tuning", "held-out"]));
		expect(SELECTOR_CORPUS.some((fixture) => fixture.designatedTailMiss === "early")).toBe(true);
		expect(SELECTOR_CORPUS.some((fixture) => fixture.designatedTailMiss === "middle")).toBe(true);
		expect(new Set(SELECTOR_CORPUS.flatMap((fixture) => fixture.bypass ? [fixture.bypass] : []))).toEqual(new Set(["short", "all-important", "exact-document"]));
		const serialized = JSON.stringify(SELECTOR_CORPUS);
		expect(serialized).toContain("IGNORE THE SELECTOR");
		expect(serialized).toContain("SYNTHETIC_CANARY_NOT_A_CREDENTIAL");
		expect(serialized).toContain("\\u001b[31m");
		expect(serialized.length).toBeLessThan(20_000);
		for (const fixture of SELECTOR_CORPUS) expect(fixture.lines.some((item) => item.required) || fixture.bypass === "exact-document").toBe(true);
	});

	it("reports reproducible matched-budget tail and protected-context baselines", () => {
		const first = evaluateOfflineBaselines();
		const second = evaluateOfflineBaselines();
		expect(first).toEqual(second);
		for (const row of first.rows) {
			expect(row.visibleChars).toBeLessThanOrEqual(SELECTOR_SETTINGS.visibleChars);
			expect(row.selectedIndices).toEqual([...row.selectedIndices].sort((a, b) => a - b));
			expect(new Set(row.selectedIndices).size).toBe(row.selectedIndices.length);
		}
		for (const fixture of SELECTOR_CORPUS.filter((item) => item.designatedTailMiss)) {
			const tail = first.rows.find((row) => row.fixtureId === fixture.id && row.arm === "tail")!;
			const baseline = first.rows.find((row) => row.fixtureId === fixture.id && row.arm === "protected-context")!;
			expect(tail.requiredRecall).toBeLessThan(1);
			expect(baseline.requiredRecall).toBeGreaterThan(tail.requiredRecall);
		}
		for (const fixture of SELECTOR_CORPUS.filter((item) => item.bypass)) {
			const rows = first.rows.filter((row) => row.fixtureId === fixture.id);
			expect(rows.every((row) => row.omittedLines === 0)).toBe(true);
		}
	});

	it("uses only the injected client, redacts every outbound string, and records bounded usage", async () => {
		const fixture = SELECTOR_CORPUS.find((item) => item.id === "prompt-injection-secret")!;
		const requests: any[] = [];
		const client: JevClient = { evaluate: vi.fn(async (request, options) => {
			requests.push({ request, options });
			return responseFor(request, new Set([10, 11]));
		}) };
		const report = await evaluateLiveSelector({ client, redactionPatterns: [], fixtures: [fixture] });
		expect(client.evaluate).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(requests)).not.toContain("SYNTHETIC_CANARY_NOT_A_CREDENTIAL");
		expect(JSON.stringify(requests)).toContain("[REDACTED]");
		expect(requests[0].options.timeoutMs).toBe(SELECTOR_SETTINGS.requestTimeoutMs);
		expect(report.usage).toEqual({ inputTokens: 50, outputTokens: 10 });
		expect(report.cost.amount).toBeNull();
		expect(report.requests[0]).toMatchObject({ status: "ok", inputTokens: 50, outputTokens: 10 });
	});

	it("treats malformed provider output as an opaque failure without raw dumps", async () => {
		const fixture = SELECTOR_CORPUS.find((item) => item.id === "build-early-error")!;
		const client: JevClient = { evaluate: vi.fn(async () => ({ provider_dump: "must-not-leak" })) };
		const report = await evaluateLiveSelector({ client, redactionPatterns: [], fixtures: [fixture] });
		expect(report.requests[0]?.status).toBe("failed");
		expect(JSON.stringify(report)).not.toContain("must-not-leak");
	});
});
