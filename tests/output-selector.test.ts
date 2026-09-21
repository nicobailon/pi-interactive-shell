import { describe, expect, it, vi } from "vitest";
import type { JevClient } from "../jev-client.ts";
import { OUTPUT_SELECTOR_POLICY, selectOutput, type OutputBlock, type OutputSelectionInput } from "../output-selector.ts";

function makeInput(parts = 12, overrides: Partial<OutputSelectionInput> = {}): OutputSelectionInput {
	const chunks = Array.from({ length: parts }, (_, i) => `routine chunk ${i} ${"x".repeat(500)}`);
	const text = chunks.join("\n"); let cursor = 0;
	const blocks: OutputBlock[] = chunks.map((chunk) => { const start = cursor; cursor += chunk.length + 1; return { range: { start, end: start + chunk.length }, text: chunk, kind: "progress" }; });
	return { source: { identity: { scheme: "memory", id: "log", version: "sha256:v1" }, text, complete: true, kind: "text" }, goal: "find outcome", command: "npm test", status: "exit 0", blocks, ...overrides };
}
function withTexts(input: OutputSelectionInput, texts: readonly string[]): OutputSelectionInput {
	const text = texts.join("\n"); let cursor = 0;
	const blocks = texts.map((part, index) => { const start = cursor; cursor += part.length + 1; return { ...input.blocks[index]!, text: part, range: { start, end: start + part.length } }; });
	return { ...input, source: { ...input.source, text }, blocks };
}
function answer(request: any, scores: (position: number, kind: string) => number = (_p, kind) => kind === "routine_progress" ? 0.9 : 0.1, extra: Record<string, unknown> = {}) {
	return { model: OUTPUT_SELECTOR_POLICY.model, answers: Object.fromEntries(Object.keys(request.questions).map((key) => { const match = /^b(\d+)_(.+)$/.exec(key)!; return [key, { type: "noul", noul: scores(Number(match[1]), match[2]!) }]; })), usage: { input_tokens: 10, output_tokens: 5 }, ...extra };
}
const fake = (fn: (request: any, options: any) => unknown = (request) => answer(request)): JevClient => ({ evaluate: vi.fn(async (request, options) => fn(request, options)) });

function redactor(value: string): string { return value.replaceAll("CANARY_SECRET", "[REDACTED]"); }

describe("bounded output selector", () => {
	it("covers candidates with deterministic overlapping windows and merges in source order", async () => {
		const input = makeInput(); const client = fake();
		const result = await selectOutput(input, { client, redact: redactor });
		expect(result.status).toBe("selected");
		expect(result.audit.completeCoverage).toBe(true);
		expect(result.audit.requests.map((r) => r.ranges.length)).toEqual([4, 4, 4, 3]);
		expect(result.audit.requests[0]!.ranges.at(-1)).toEqual(result.audit.requests[1]!.ranges[0]);
		expect(result.audit.semanticOmissionRanges).toEqual([...result.audit.semanticOmissionRanges].sort((a, b) => a.start - b.start));
		expect(client.evaluate).toHaveBeenCalledTimes(4);
	});

	it("uses exact block positions, five atomic Noul questions, and redacts every dynamic outbound field", async () => {
		const base = makeInput(); const rebuilt = withTexts(base, base.blocks.map((block, index) => index === 0 ? block.text.replace("routine", "CANARY_SECRET") : block.text));
		const input = { ...rebuilt, goal: "CANARY_SECRET", command: "CANARY_SECRET", status: "CANARY_SECRET" };
		const client = fake(); await selectOutput(input, { client, redact: redactor });
		const request = (client.evaluate as any).mock.calls[0][0]; const outbound = JSON.stringify(request);
		expect(outbound).not.toContain("CANARY_SECRET");
		expect(Object.keys(request.questions)).toHaveLength(20);
		expect(request.questions.b0_problem_or_failure.instructions).toContain("state.blocks[0].text");
		expect(outbound).not.toMatch(/required|relevant|oracle|label/i);
	});

	it("accounts canonical UTF-8 bytes under both conservative ceilings", async () => {
		const input = makeInput(12); const unicode = input.blocks.map((b, i) => ({ ...b, text: b.text.replace(/x/g, i % 2 ? "界" : "9") }));
		const text = unicode.map((b) => b.text).join("\n"); let cursor = 0; const blocks = unicode.map((b) => { const start = cursor; cursor += b.text.length + 1; return { ...b, range: { start, end: start + b.text.length } }; });
		const result = await selectOutput({ ...input, source: { ...input.source, text }, blocks }, { client: fake(), redact: redactor });
		for (const request of result.audit.requests) { expect(request.stateAndLongestQuestionBytes).toBeLessThan(24 * 1024); expect(request.stateAndAllQuestionsBytes).toBeLessThan(48 * 1024); expect(request.payloadBytes).toBeGreaterThan(0); }
	});

	it("keeps oversized unsent blocks with continuation mapping", async () => {
		const input = makeInput(3); const huge = "z".repeat(30_000); const text = [huge, input.blocks[1]!.text, input.blocks[2]!.text].join("\n"); let cursor = 0; const blocks = [huge, input.blocks[1]!.text, input.blocks[2]!.text].map((part) => { const start = cursor; cursor += part.length + 1; return { text: part, range: { start, end: start + part.length }, kind: "progress" as const }; });
		const result = await selectOutput({ ...input, source: { ...input.source, text }, blocks }, { client: fake(), redact: redactor });
		expect(result.status).toBe("pagination-required"); expect(result.audit.requests[0]).toMatchObject({ status: "unsent", reason: "request-size" });
		expect(result.audit.physicalTruncationRanges.some((range) => range.start <= blocks[0]!.range.start && range.end >= blocks[0]!.range.end)).toBe(true);
	});

	it("applies any-keep-wins across overlap and never dedupes identical text at distinct ranges", async () => {
		let window = 0; const client = fake((request) => { const current = window++; return answer(request, (position, kind) => kind === "routine_progress" ? 0.9 : (current === 1 && position === 0 && kind === "problem_or_failure" ? 0.9 : 0.1)); });
		const input = makeInput(); const repeated = input.blocks.map((b) => ({ ...b, text: "q".repeat(b.text.length) })); const text = repeated.map((b) => b.text).join("\n"); let c = 0; const blocks = repeated.map((b) => { const start = c; c += b.text.length + 1; return { ...b, range: { start, end: start + b.text.length } }; });
		const result = await selectOutput({ ...input, source: { ...input.source, text }, blocks }, { client, redact: redactor });
		expect(result.audit.retainedRanges.some((range) => range.start <= blocks[3]!.range.start && range.end >= blocks[3]!.range.end)).toBe(true);
		expect(result.audit.retainedRanges.every((r, i, all) => i === 0 || r.start > all[i - 1]!.start)).toBe(true);
	});

	it("strictly rejects malformed, extra, missing, and invalid usage responses conservatively", async () => {
		const bad = [null, { answers: {} }, (r: any) => answer(r, undefined, { extra: 1 }), (r: any) => ({ ...answer(r), usage: { input_tokens: 1.5, output_tokens: 1 } }), (r: any) => { const x = answer(r); delete (x.answers as any)[Object.keys(x.answers)[0]!]; return x; }];
		for (const value of bad) { const result = await selectOutput(makeInput(), { client: fake((r) => typeof value === "function" ? value(r) : value), redact: redactor }); expect(["unavailable", "pagination-required"]).toContain(result.status); expect(result.audit.semanticOmissionCount).toBe(0); }
	});

	it("retains affected ranges for provider rejection, abort, and request-cap exhaustion", async () => {
		const failed = await selectOutput(makeInput(), { client: fake(() => { throw new Error("context rejected"); }), redact: redactor });
		expect(["unavailable", "pagination-required"]).toContain(failed.status); expect(failed.audit.semanticOmissionCount).toBe(0);
		const controller = new AbortController(); controller.abort(); const aborted = await selectOutput(makeInput(), { client: fake(), redact: redactor, signal: controller.signal });
		expect(aborted.audit.requests.every((r) => r.status === "unsent" && r.reason === "aborted")).toBe(true);
		const many = makeInput(40); const capped = await selectOutput(many, { client: fake(), redact: redactor });
		expect(capped.audit.logicalCalls).toBe(8); expect(capped.audit.requests.some((r) => r.reason === "request-cap")).toBe(true); expect(capped.audit.possiblePhysicalAttempts).toBe(16);
	});

	it("enforces the per-call timeout even when an injected client ignores cancellation", async () => {
		vi.useFakeTimers();
		try {
			const pending = selectOutput(makeInput(), { client: fake(() => new Promise(() => {})), redact: redactor });
			await vi.advanceTimersByTimeAsync(OUTPUT_SELECTOR_POLICY.timeoutMs * 4);
			const result = await pending;
			expect(result.audit.requests[0]).toMatchObject({ status: "failed", reason: "timeout" });
			expect(result.audit.semanticOmissionCount).toBe(0);
		} finally { vi.useRealTimers(); }
	});

	it("bypasses short, exact, structured, secret-like, and incomplete inputs without provider construction", async () => {
		const secretBase = makeInput(); const secret = withTexts(secretBase, secretBase.blocks.map((block, index) => index === 0 ? block.text.replace("routine", "token=CANARY_SECRET") : block.text));
		const cases = [makeInput(1), { ...makeInput(), exact: true }, { ...makeInput(), source: { ...makeInput().source, kind: "json" as const } }, secret, { ...makeInput(), source: { ...makeInput().source, complete: false } }];
		for (const input of cases) { const client = fake(); const result = await selectOutput(input, { client, redact: redactor }); expect(["unchanged", "unavailable", "pagination-required"]).toContain(result.status); expect(client.evaluate).not.toHaveBeenCalled(); }
	});

	it("never transmits protected content and paginates rather than dropping it", async () => {
		const base = makeInput(); const protectedText = `ERROR CANARY_SECRET ${"E".repeat(6_000)}`; const rest = base.blocks.slice(1).map((b) => b.text); const text = [protectedText, ...rest].join("\n"); let cursor = 0; const blocks = [protectedText, ...rest].map((part, i) => { const start = cursor; cursor += part.length + 1; return { text: part, range: { start, end: start + part.length }, kind: i === 0 ? "diagnostic" as const : "progress" as const }; }); const client = fake();
		const result = await selectOutput({ ...base, source: { ...base.source, text }, blocks }, { client, redact: redactor });
		for (const [request] of (client.evaluate as any).mock.calls) expect(JSON.stringify(request)).not.toContain("CANARY_SECRET");
		expect(result.status).toBe("pagination-required"); expect(result.audit.physicalTruncationRanges.some((range) => range.start <= blocks[0]!.range.start && range.end >= blocks[0]!.range.end)).toBe(true);
	});

	it("is deterministic, validates stable UTF-16 ranges, and marks semantic omissions within exact budget", async () => {
		const input = makeInput(); const one = await selectOutput(input, { client: fake(), redact: redactor }); const two = await selectOutput(input, { client: fake(), redact: redactor });
		expect(one).toEqual(two); expect(one.text.length).toBeLessThanOrEqual(5_120); expect(one.text).toContain("[omitted"); expect(one.rawSourceReference.identity).toEqual(input.source.identity);
		await expect(selectOutput({ ...input, blocks: [{ ...input.blocks[0]!, range: { start: 1, end: 3 } }] }, { client: fake(), redact: redactor })).rejects.toThrow("invalid block range");
	});
});
