import { describe, expect, it } from "vitest";
import { buildDispatchNotification, buildHandsFreeUpdateMessage, buildIdlePromptWarning, buildResultNotification } from "../notification-utils.js";

describe("notification utilities", () => {
	it("formats compact dispatch notifications with a trimmed tail", () => {
		const text = buildDispatchNotification("calm-reef", {
			exitCode: 0,
			completionOutput: {
				lines: ["1", "2", "3", "4", "5", "6", ""],
				totalLines: 6,
				truncated: false,
			},
		}, "5m 0s");
		expect(text).toContain("Session calm-reef completed successfully (5m 0s). 6 lines of output.");
		expect(text).toContain("2\n3\n4\n5\n6");
		expect(text).toContain('Attach to review full output: interactive_shell({ attach: "calm-reef" })');
	});

	it("formats final result notifications", () => {
		const text = buildResultNotification("calm-reef", {
			exitCode: 1,
			backgrounded: false,
			cancelled: false,
			completionOutput: {
				lines: ["boom"],
				totalLines: 3,
				truncated: true,
			},
		});
		expect(text).toContain("Session calm-reef exited with code 1.");
		expect(text).toContain("Output (1 lines (truncated from 3 total lines)):");
	});

	it("only emits non-running hands-free updates", () => {
		expect(buildHandsFreeUpdateMessage({
			status: "running",
			sessionId: "calm-reef",
			runtime: 1000,
			tail: [],
			tailTruncated: false,
		})).toBeNull();

		expect(buildHandsFreeUpdateMessage({
			status: "user-takeover",
			sessionId: "calm-reef",
			runtime: 1000,
			tail: ["hello"],
			tailTruncated: false,
			userTookOver: true,
		})?.content).toContain("Session calm-reef: user took over (1s)");
	});

	it("warns when reason implies work but command launches an idle agent", () => {
		expect(buildIdlePromptWarning("codex", "Review the auth flow")).toContain("reason` is UI-only");
		expect(buildIdlePromptWarning('codex "Review the auth flow"', "Review the auth flow")).toBeNull();
	});
});
