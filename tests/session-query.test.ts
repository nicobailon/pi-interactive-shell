import { describe, expect, it } from "vitest";
import { createSessionQueryState, getSessionOutput } from "../session-query.js";
import type { InteractiveShellConfig } from "../config.js";

const config: InteractiveShellConfig = {
	exitAutoCloseDelay: 10,
	overlayWidthPercent: 95,
	overlayHeightPercent: 60,
	scrollbackLines: 5000,
	ansiReemit: true,
	handoffPreviewEnabled: true,
	handoffPreviewLines: 30,
	handoffPreviewMaxChars: 2000,
	handoffSnapshotEnabled: false,
	handoffSnapshotLines: 200,
	handoffSnapshotMaxChars: 12000,
	transferLines: 200,
	transferMaxChars: 20000,
	completionNotifyLines: 50,
	completionNotifyMaxChars: 5000,
	handsFreeUpdateMode: "on-quiet",
	handsFreeUpdateInterval: 60000,
	handsFreeQuietThreshold: 8000,
	autoExitGracePeriod: 15000,
	handsFreeUpdateMaxChars: 1500,
	handsFreeMaxTotalChars: 100000,
	minQueryIntervalSeconds: 60,
};

function makeSession() {
	return {
		getTailLines: ({ lines, maxChars }: { lines: number; maxChars?: number }) => ({
			lines: ["alpha", "beta", "gamma"].slice(-lines),
			totalLinesInBuffer: 3,
			truncatedByChars: Boolean(maxChars && maxChars < 5),
		}),
		getRawStream: ({ sinceLast }: { sinceLast?: boolean }) => sinceLast ? "delta\nepsilon" : "alpha\nbeta\ngamma",
		getLogSlice: ({ offset = 0, limit = 50 }: { offset?: number; limit?: number }) => {
			const lines = ["zero", "one", "two", "three"];
			const selected = lines.slice(offset, offset + limit);
			return {
				slice: selected.join("\n"),
				totalLines: lines.length,
				totalChars: lines.join("\n").length,
				sliceLineCount: selected.length,
			};
		},
	} as any;
}

describe("getSessionOutput", () => {
	it("returns completion output immediately for finished sessions", () => {
		const state = createSessionQueryState();
		const result = getSessionOutput(makeSession(), config, state, false, {
			lines: ["done"],
			totalLines: 1,
			truncated: false,
		});
		expect(result).toEqual({ output: "done", truncated: false, totalBytes: 4, totalLines: 1 });
	});

	it("supports incremental pagination with tracked position", () => {
		const state = createSessionQueryState();
		const session = makeSession();
		expect(getSessionOutput(session, config, state, { incremental: true, lines: 2 })).toMatchObject({
			output: "zero\none",
			totalLines: 4,
			hasMore: true,
		});
		expect(getSessionOutput(session, config, state, { incremental: true, lines: 2, skipRateLimit: true })).toMatchObject({
			output: "two\nthree",
			totalLines: 4,
			hasMore: false,
		});
	});

	it("supports drain mode and offset mode", () => {
		const state = createSessionQueryState();
		const session = makeSession();
		expect(getSessionOutput(session, config, state, { drain: true, maxChars: 5 })).toEqual({
			output: "silon",
			truncated: true,
			totalBytes: 5,
		});
		expect(getSessionOutput(session, config, state, { offset: 1, lines: 2, skipRateLimit: true })).toMatchObject({
			output: "one\ntwo",
			totalLines: 4,
			hasMore: true,
			truncated: true,
		});
	});

	it("rate limits repeated queries until enough time has passed", () => {
		const state = createSessionQueryState();
		const session = makeSession();
		const first = getSessionOutput(session, config, state);
		expect(first.output).toBe("alpha\nbeta\ngamma");
		const second = getSessionOutput(session, config, state);
		expect(second.rateLimited).toBe(true);
		expect(second.waitSeconds).toBeGreaterThan(0);
	});
});
