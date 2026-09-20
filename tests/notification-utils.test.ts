import { describe, expect, it } from "vitest";
import { buildDispatchNotification, buildHandsFreeUpdateMessage, buildIdlePromptWarning, buildMonitorEventNotification, buildMonitorLifecycleNotification, buildResultNotification, summarizeInteractiveResult } from "../notification-utils.ts";

describe("notification utilities", () => {
	it("formats compact dispatch notifications with a trimmed tail", () => {
		const text = buildDispatchNotification("calm-reef", {
			exitCode: 0,
			completionReason: "exited",
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
			completionReason: "auto-close-quiet",
			cancelled: true,
			autoClosedOnQuiet: true,
		}, "30s");
		expect(text).toContain("Session calm-reef auto-closed after quiet (30s). Local supervision stopped; termination was attempted and subprocess exit is not confirmed. This is not a terminal command verdict.");
		expect(text).not.toContain("was killed");
		expect(text).not.toContain("completed successfully");
	});

	it("describes explicit cancellation as best-effort local supervision", () => {
		const text = buildDispatchNotification("calm-reef", {
			exitCode: null,
			completionReason: "killed",
			cancelled: true,
			completionOutput: { lines: ["captured"], totalLines: 1, truncated: false },
		}, "30s");
		expect(text).toContain("Session calm-reef cancelled (30s). Termination was attempted; subprocess exit is not confirmed.");
		expect(text).toContain("Output captured at cancellation:");
	});

	it("marks an overlay quiet auto-close as non-terminal", () => {
		const text = buildResultNotification("calm-reef", {
			exitCode: null,
			completionReason: "auto-close-quiet",
			backgrounded: false,
			cancelled: true,
		});
		expect(text).toContain("This is not a terminal command verdict.");
		expect(text).toContain("Local supervision stopped; termination was attempted and subprocess exit is not confirmed.");
	});

	it("describes timeout as local cancellation rather than natural exit", () => {
		const text = buildResultNotification("calm-reef", {
			exitCode: null,
			completionReason: "timed-out",
			backgrounded: false,
			cancelled: true,
			timedOut: true,
		});
		expect(text).toContain("Session calm-reef cancelled after timeout. Local supervision stopped; termination was attempted and subprocess exit is not confirmed.");
		expect(text).not.toContain("exited");
	});

	it("summarizes cancellation as attempted but unconfirmed termination", () => {
		const timeout = summarizeInteractiveResult("sleep 10", {
			exitCode: null,
			completionReason: "timed-out",
			backgrounded: false,
			cancelled: true,
			timedOut: true,
		}, 1000);
		const quiet = summarizeInteractiveResult("sleep 10", {
			exitCode: null,
			completionReason: "auto-close-quiet",
			backgrounded: false,
			cancelled: true,
		});
		const cancelled = summarizeInteractiveResult("sleep 10", {
			exitCode: null,
			completionReason: "killed",
			backgrounded: false,
			cancelled: true,
		});
		for (const summary of [timeout, quiet, cancelled]) {
			expect(summary).toContain("termination was attempted and subprocess exit is not confirmed");
		}
		expect(quiet).toContain("This is not a terminal command verdict");
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

	it("formats bounded semantic metadata without terminal state", () => {
		const text = buildMonitorEventNotification({
			sessionId: "calm-reef", eventId: 4, timestamp: "2026-04-11T14:00:00.000Z", strategy: "semantic",
			triggerId: "semantic:watch:ready", eventType: "semantic-watch", matchedText: "watch:ready",
			lineOrDiff: "Semantic watch matched: ready", stream: "pty",
			semantic: { decisionId: 9, generation: 12, model: "jev-1.13.0", kind: "watch", watchId: "ready", probability: 0.8, threshold: 0.8 },
		});
		expect(text).toContain("Watch: ready");
		expect(text).toContain("Decision: #9, generation 12, model jev-1.13.0");
		expect(text).toContain("Probability: 0.8 (threshold 0.8)");
		expect(text).not.toContain("Matched:");
		expect(text).not.toContain("Line:");
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
