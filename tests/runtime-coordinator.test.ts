import { describe, expect, it, vi } from "vitest";
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

describe("InteractiveShellCoordinator extension API rebinding", () => {
	it("delivers work through the replacement API after a reload gap", () => {
		const coordinator = new InteractiveShellCoordinator();
		const firstApi = {} as never;
		const secondApi = {} as never;
		const delivered: unknown[] = [];

		coordinator.bindExtensionApi(firstApi);
		coordinator.runWithExtensionApi((pi) => delivered.push(pi));
		coordinator.unbindExtensionApi(firstApi);
		coordinator.runWithExtensionApi((pi) => delivered.push(pi));

		expect(delivered).toEqual([firstApi]);
		coordinator.bindExtensionApi(secondApi);
		expect(delivered).toEqual([firstApi, secondApi]);
	});

	it("fences stale runtime epochs across API rebinds", () => {
		const coordinator = new InteractiveShellCoordinator();
		const rebindSemanticEpoch = vi.fn();
		const pauseSemantic = vi.fn();
		coordinator.setMonitor("semantic", { rebindSemanticEpoch, pauseSemantic } as never);
		const firstApi = {} as never;
		coordinator.bindExtensionApi(firstApi);
		const first = coordinator.getRuntimeEpoch();
		coordinator.bindExtensionApi(firstApi);
		expect(rebindSemanticEpoch).toHaveBeenCalledTimes(1);
		expect(coordinator.isRuntimeEpochCurrent(first)).toBe(true);
		coordinator.unbindExtensionApi({} as never);
		expect(coordinator.getRuntimeEpoch()).toBe(first);
		coordinator.unbindExtensionApi(firstApi);
		expect(coordinator.isRuntimeEpochCurrent(first)).toBe(false);
		expect(pauseSemantic).toHaveBeenCalledTimes(1);
		coordinator.bindExtensionApi({} as never);
		expect(rebindSemanticEpoch).toHaveBeenCalledTimes(2);
	});
});

describe("InteractiveShellCoordinator semantic history", () => {
	it("keeps the hard action budget across reload and resets it only on full monitor shutdown", () => {
		const coordinator = new InteractiveShellCoordinator();
		for (let i = 0; i < 10; i++) expect(coordinator.reserveSemanticActionAttempt()).toBe(true);
		expect(coordinator.reserveSemanticActionAttempt()).toBe(false);
		expect(coordinator.getSemanticActionAttempts()).toBe(10);
		const api = {} as never;
		coordinator.bindExtensionApi(api); coordinator.unbindExtensionApi(api); coordinator.bindExtensionApi({} as never);
		expect(coordinator.getSemanticActionAttempts()).toBe(10);
		expect(coordinator.reserveSemanticActionAttempt()).toBe(false);
		coordinator.disposeAllMonitors();
		expect(coordinator.getSemanticActionAttempts()).toBe(0);
		expect(coordinator.reserveSemanticActionAttempt()).toBe(true);
	});

	it("keeps a separate bounded newest-first paginated history", () => {
		const coordinator = new InteractiveShellCoordinator();
		coordinator.registerSemanticSession("semantic-1", new Date("2026-09-14T00:00:00Z"));
		for (let generation = 1; generation <= 205; generation++) {
			coordinator.recordSemanticDecision("semantic-1", {
				kind: "skipped", route: "continue", reason: "secret-prompt", model: "jev-1.13.0",
				observationHash: String(generation), generation, latencyMs: 0,
			});
		}
		const page = coordinator.getSemanticDecisions("semantic-1", { limit: 2, offset: 1 });
		expect(page.total).toBe(200);
		expect(page.decisions.map((decision) => decision.generation)).toEqual([204, 203]);
		expect(coordinator.getSemanticSessionState("semantic-1")).toMatchObject({ status: "running", decisionCount: 205, lastDecisionId: 205 });
		expect(coordinator.getMonitorEvents("semantic-1").events).toEqual([]);
		coordinator.clearSemanticDecisions("semantic-1");
		expect(coordinator.getSemanticDecisions("semantic-1").total).toBe(0);
	});
});

describe("InteractiveShellCoordinator background widget cleanup", () => {
	it("stores the replacement cleanup before running the previous cleanup", () => {
		const coordinator = new InteractiveShellCoordinator();
		const calls: string[] = [];

		coordinator.replaceBackgroundWidgetCleanup(() => {
			calls.push("stale");
			throw new Error("stale ctx");
		});

		expect(() => coordinator.replaceBackgroundWidgetCleanup(() => calls.push("fresh"))).toThrow("stale ctx");
		expect(calls).toEqual(["stale"]);

		expect(() => coordinator.replaceBackgroundWidgetCleanup(null)).not.toThrow();
		expect(calls).toEqual(["stale", "fresh"]);
	});

	it("clears the stored cleanup before running the previous cleanup", () => {
		const coordinator = new InteractiveShellCoordinator();
		const stale = vi.fn(() => {
			throw new Error("stale ctx");
		});
		const fresh = vi.fn();

		coordinator.replaceBackgroundWidgetCleanup(stale);
		expect(() => coordinator.clearBackgroundWidget()).toThrow("stale ctx");
		expect(stale).toHaveBeenCalledTimes(1);

		coordinator.replaceBackgroundWidgetCleanup(fresh);
		coordinator.clearBackgroundWidget();
		expect(stale).toHaveBeenCalledTimes(1);
		expect(fresh).toHaveBeenCalledTimes(1);
	});
});
