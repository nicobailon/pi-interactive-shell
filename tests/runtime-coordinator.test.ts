import { describe, expect, it } from "vitest";
import { InteractiveShellCoordinator } from "../runtime-coordinator.ts";

describe("InteractiveShellCoordinator monitor state", () => {
	it("tracks monitor session lifecycle and filtered event queries", () => {
		const coordinator = new InteractiveShellCoordinator();
		coordinator.registerMonitorSession("calm-reef", {
			strategy: "stream",
			triggers: [{ id: "error", literal: "ERROR" }, { id: "warn", literal: "WARN" }],
		}, new Date("2026-04-12T00:00:00.000Z"));

		const first = coordinator.recordMonitorEvent({
			sessionId: "calm-reef",
			strategy: "stream",
			triggerId: "error",
			eventType: "error",
			matchedText: "ERROR",
			lineOrDiff: "ERROR boom",
			stream: "pty",
		});
		const second = coordinator.recordMonitorEvent({
			sessionId: "calm-reef",
			strategy: "stream",
			triggerId: "warn",
			eventType: "warn",
			matchedText: "WARN",
			lineOrDiff: "WARN slow",
			stream: "pty",
		});

		expect(first.eventId).toBe(1);
		expect(second.eventId).toBe(2);

		const state = coordinator.getMonitorSessionState("calm-reef");
		expect(state?.status).toBe("running");
		expect(state?.eventCount).toBe(2);
		expect(state?.lastEventId).toBe(2);
		expect(state?.lastTriggerId).toBe("warn");

		const since = coordinator.getMonitorEvents("calm-reef", { sinceEventId: 1 });
		expect(since.events).toHaveLength(1);
		expect(since.events[0]?.eventId).toBe(2);

		const filtered = coordinator.getMonitorEvents("calm-reef", { triggerId: "error" });
		expect(filtered.events).toHaveLength(1);
		expect(filtered.events[0]?.triggerId).toBe("error");

		coordinator.finalizeMonitorSession("calm-reef", { exitCode: 1 }, "script-failed");
		const stopped = coordinator.getMonitorSessionState("calm-reef");
		expect(stopped?.status).toBe("stopped");
		expect(stopped?.terminalReason).toBe("script-failed");
		expect(stopped?.exitCode).toBe(1);

		coordinator.clearMonitorEvents("calm-reef");
		expect(coordinator.getMonitorSessionState("calm-reef")).toBeUndefined();
		expect(coordinator.getMonitorEvents("calm-reef").events).toHaveLength(0);
	});
});
