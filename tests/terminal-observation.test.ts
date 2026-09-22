import { describe, expect, it, vi } from "vitest";
import { buildTerminalObservation, MAX_HANDOFF_EXCERPT_CHARS } from "../terminal-observation.ts";

function session(lines: string[]) {
	return { exited: false, getViewportLines: () => lines };
}

function build(lines: string[], recentOutput = lines.join("\n")) {
	return buildTerminalObservation({
		session: session(lines), mode: "monitor", recentOutput, changed: true,
		startedAt: 0, lastOutputAt: 0, actions: [], recentActionIds: [],
		bounds: { maxViewportLines: 20, maxRecentChars: 4_000, redactionPatterns: [] },
	});
}

describe("terminal contextual handoff", () => {
	it("produces a deterministic bounded redacted source excerpt", () => {
		const rawSecret = "ghp_abcdefghijklmnop";
		const result = build(["Deploy failed", `credential ${rawSecret}`, "Retry deployment?"]);

		expect(result.handoff.relevantExcerpt).toContain("Retry deployment?");
		expect(result.handoff.relevantExcerpt).toContain("[REDACTED]");
		expect(result.handoff.relevantExcerpt).not.toContain(rawSecret);
		expect(result.handoff.relevantExcerpt.length).toBeLessThanOrEqual(MAX_HANDOFF_EXCERPT_CHARS);
		expect(JSON.stringify(result.handoff)).not.toContain(rawSecret);
	});

	it("keeps identity stable across clock buckets and progress-only churn", () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(500);
			const first = build(["Continue deployment?", "10/100"]);
			vi.setSystemTime(70_000);
			const second = build(["Continue deployment?", "11/100"]);
			expect(second.handoff.contentIdentity).toBe(first.handoff.contentIdentity);
		} finally {
			vi.useRealTimers();
		}
	});

	it("changes identity for a genuinely new question of the same type", () => {
		const first = build(["Deploy service alpha?"]);
		const second = build(["Deploy service beta?"]);
		expect(second.handoff.contentIdentity).not.toBe(first.handoff.contentIdentity);
	});

	it("fences secret prompts from contextual evidence", () => {
		const result = build(["Password:", "hunter2"]);
		expect(result.secretPrompt).toBe(true);
		expect(result.handoff).toMatchObject({ relevantExcerpt: "[SECRET PROMPT REDACTED]", contentIdentity: "secret-prompt" });
		expect(JSON.stringify(result.handoff)).not.toContain("hunter2");
	});
});
