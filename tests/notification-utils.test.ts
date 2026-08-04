import { describe, expect, it } from "vitest";
import { buildDispatchNotification, buildHandsFreeUpdateMessage, buildIdlePromptWarning, buildMonitorEventNotification, buildMonitorLifecycleNotification, buildResultNotification } from "../notification-utils.ts";

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

	it("distinguishes quiet auto-close from a killed dispatch session", () => {
		const text = buildDispatchNotification("calm-reef", {
			exitCode: null,
			cancelled: true,
			autoClosedOnQuiet: true,
		}, "30s");
		expect(text).toContain("Session calm-reef auto-closed after quiet (30s).");
		expect(text).not.toContain("was killed");
	});

	it("formats explicitly cancelled dispatch notifications as killed", () => {
		const text = buildDispatchNotification("calm-reef", {
			exitCode: null,
			cancelled: true,
		}, "30s");
		expect(text).toContain("Session calm-reef was killed (30s).");
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

	it("formats monitor event notifications", () => {
		const text = buildMonitorEventNotification({
			sessionId: "calm-reef",
			eventId: 3,
			timestamp: "2026-04-11T14:00:00.000Z",
			strategy: "stream",
			triggerId: "error",
			eventType: "error",
			matchedText: "ERROR: failed",
			lineOrDiff: "ERROR: failed to compile",
			stream: "pty",
		});
		expect(text).toContain("Monitor Event (calm-reef) #3");
		expect(text).toContain("Strategy: stream");
		expect(text).toContain("Trigger: error");
		expect(text).toContain("Matched: ERROR: failed");
		expect(text).toContain("Line: ERROR: failed to compile");
	});

	it("formats monitor lifecycle notifications", () => {
		const text = buildMonitorLifecycleNotification({
			sessionId: "calm-reef",
			strategy: "stream",
			triggerIds: ["error"],
			status: "stopped",
			eventCount: 2,
			startedAt: "2026-04-12T00:00:00.000Z",
			lastEventId: 2,
			lastEventAt: "2026-04-12T00:00:10.000Z",
			lastTriggerId: "error",
			terminalReason: "script-failed",
			exitCode: 1,
		});
		expect(text).toContain("Monitor calm-reef script failed.");
		expect(text).toContain("Strategy: stream");
		expect(text).toContain("Events: 2");
		expect(text).toContain("Last event: #2");
		expect(text).toContain("Exit code: 1");
	});

	it("warns when reason implies work but command launches an idle agent", () => {
		expect(buildIdlePromptWarning("codex", "Review the auth flow")).toContain("reason` is UI-only");
		expect(buildIdlePromptWarning("agent --model composer-2-fast", "Review the auth flow")).toContain("reason` is UI-only");
		expect(buildIdlePromptWarning('codex "Review the auth flow"', "Review the auth flow")).toBeNull();
		expect(buildIdlePromptWarning('agent --model composer-2-fast "Review the auth flow"', "Review the auth flow")).toBeNull();
	});
});
