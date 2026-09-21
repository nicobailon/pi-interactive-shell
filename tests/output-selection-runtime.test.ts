import { describe, expect, it, vi } from "vitest";
import { buildOutputSelectionInput, normalizeSelectorVisibleText, runOutputSelection } from "../output-selection-runtime.ts";
import type { JevClient } from "../jev-client.ts";

function answersFor(request: any, keepPositions = new Set<number>()): unknown {
	const answers: Record<string, unknown> = {};
	for (let index = 0; index < request.state.blocks.length; index++) {
		const keep = keepPositions.has(request.state.blocks[index].position);
		for (const kind of ["problem_or_failure", "substantive_result", "artifact_or_report_location", "explicit_goal_evidence", "routine_progress"]) {
			answers[`b${index}_${kind}`] = { type: "noul", noul: kind === "routine_progress" ? 1 : keep ? 1 : 0 };
		}
	}
	return { answers, model: "jev-1.13.0", usage: { input_tokens: 10, output_tokens: 5 } };
}

describe("output selection runtime adapter", () => {
	it("bypasses a boundary-spanning auth canary before any provider call", async () => {
		const evaluate = vi.fn(async () => { throw new Error("must not call"); });
		const raw = `${"routine output\n".repeat(500)}api_\nkey=boundary-canary\n`;
		const result = await runOutputSelection({ sourceId: "source", raw, metadata: { goal: "summarize", command: "job" }, redactionPatterns: [], client: { evaluate } });
		expect(evaluate).not.toHaveBeenCalled();
		expect(result.status).toBe("pagination-required");
		expect("reason" in result && result.reason).toBe("secret-like-input");
	});

	it("does not count ANSI/CR transport characters as visible output and preserves exact raw mapping", async () => {
		const evaluate = vi.fn();
		const raw = `${"\x1b[31m".repeat(1000)}ok\rnext\x1b[0m`;
		const built = buildOutputSelectionInput("source", raw, { goal: "summarize", command: "job" }, []);
		expect(built.input.source.visibleLength).toBeLessThan(20);
		const result = await runOutputSelection({ sourceId: "source", raw, metadata: { goal: "summarize", command: "job" }, redactionPatterns: [], client: { evaluate } as JevClient });
		expect(evaluate).not.toHaveBeenCalled();
		expect(result.status).toBe("unchanged");
		expect(result.excerpts[0]?.range).toEqual({ start: 0, end: raw.length });
		expect(result.text).toBe("next");
		expect(result.text).not.toContain("\x1b");
		expect(raw.slice(result.excerpts[0]!.range.start, result.excerpts[0]!.range.end)).toBe(raw);
	});

	it("applies terminal-style CR overwrite while retaining shorter-overwrite trailing cells", () => {
		expect(normalizeSelectorVisibleText("progress 99%\rprogress 100%" )).toBe("progress 100%");
		expect(normalizeSelectorVisibleText("abcdef\rxy")).toBe("xycdef");
		expect(normalizeSelectorVisibleText("\x1b[31mabcdef\x1b[0m\rxy")).toBe("xycdef");
	});

	it("bypasses an overwritten raw secret before provider construction", async () => {
		const evaluate = vi.fn(async () => { throw new Error("must not call"); });
		const raw = `${"routine output\n".repeat(500)}password=hidden-canary\rstatus=clear\n`;
		const result = await runOutputSelection({ sourceId: "source", raw, metadata: { goal: "summarize", command: "job" }, redactionPatterns: [], client: { evaluate } });
		expect(evaluate).not.toHaveBeenCalled();
		expect("reason" in result && result.reason).toBe("secret-like-input");
		expect(result.rawSourceReference.ranges).toEqual([{ start: 0, end: raw.length }]);
	});

	it("uses final CR-overwritten cells in provider model state", async () => {
		const requests: any[] = [];
		const client: JevClient = { evaluate: vi.fn(async (request) => { requests.push(request); return answersFor(request); }) };
		const raw = Array.from({ length: 24 }, (_, index) => `progress ${index}%\rprogress 100% ${"x".repeat(230)}\n`).join("");
		await runOutputSelection({ sourceId: "source", raw, metadata: { goal: "summarize", command: "job" }, redactionPatterns: [], client });
		expect(requests.length).toBeGreaterThan(0);
		const state = JSON.stringify(requests.map((request) => request.state));
		expect(state).not.toContain("progress 0%");
		expect(state).not.toContain("\\r");
		expect(state).not.toContain("\\u001b");
		expect(state).toContain("progress 100%");
	});

	it("sends only normalized redacted bounded state and returns recoverable raw ranges", async () => {
		const requests: any[] = [];
		const client: JevClient = { evaluate: vi.fn(async (request) => { requests.push(request); return answersFor(request, new Set([0, 12])); }) };
		const raw = Array.from({ length: 24 }, (_, index) => `line ${index} ${"x".repeat(240)}\n`).join("");
		const result = await runOutputSelection({ sourceId: "source", raw, metadata: { goal: "summarize CANARY", command: "run CANARY" }, redactionPatterns: ["CANARY"], client });
		expect(result.status).toBe("selected");
		expect(requests.length).toBeGreaterThan(0);
		const serialized = JSON.stringify(requests);
		expect(serialized).not.toContain("CANARY");
		expect(serialized).toContain("[REDACTED]");
		expect(requests.every((request) => Buffer.byteLength(JSON.stringify(request)) < 48 * 1024)).toBe(true);
		expect(result.rawSourceReference.ranges).toEqual([{ start: 0, end: raw.length }]);
		for (const excerpt of result.excerpts) expect(raw.slice(excerpt.range.start, excerpt.range.end)).toBeTruthy();
	});
});
