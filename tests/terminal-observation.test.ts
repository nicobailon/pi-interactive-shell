import { describe, expect, it } from "vitest";
import { buildTerminalObservation, getTerminalHandoffExcerpt, MAX_HANDOFF_EXCERPT_CHARS } from "../terminal-observation.ts";

function session(lines: string[]) {
	return { exited: false, getViewportLines: () => lines };
}

function build(lines: string[], recentOutput = lines.join("\n"), changed = true) {
	return buildTerminalObservation({
		session: session(lines), mode: "monitor", recentOutput, changed,
		startedAt: 0, lastOutputAt: 0, actions: [], recentActionIds: [],
		bounds: { maxViewportLines: 20, maxRecentChars: 4_000, redactionPatterns: [] },
	});
}

describe("terminal contextual handoff", () => {
	it("produces a deterministic bounded redacted source excerpt", () => {
		const rawSecret = "ghp_abcdefghijklmnop";
		const excerpt = getTerminalHandoffExcerpt(build(["Deploy failed", `credential ${rawSecret}`, "Retry deployment?"]).hash)!;

		expect(excerpt).toContain("Retry deployment?");
		expect(excerpt).toContain("[REDACTED]");
		expect(excerpt).not.toContain(rawSecret);
		expect(excerpt.length).toBeLessThanOrEqual(MAX_HANDOFF_EXCERPT_CHARS);
	});

	it("keeps the trusted observation hash stable across scheduler changed-state bookkeeping", () => {
		expect(build(["Which environment?"], undefined, false).hash).toBe(build(["Which environment?"]).hash);
	});

	it("fences secret prompts from contextual evidence", () => {
		const result = build(["Password:", "hunter2"]);
		expect(result.secretPrompt).toBe(true);
		expect(getTerminalHandoffExcerpt(result.hash)).toBe("[SECRET PROMPT REDACTED]");
	});
});
