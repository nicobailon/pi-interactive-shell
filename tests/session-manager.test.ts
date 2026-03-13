import { beforeEach, describe, expect, it, vi } from "vitest";
import { ShellSessionManager } from "../session-manager.js";

function createSession() {
	return {
		exited: false,
		setEventHandlers: vi.fn(),
		dispose: vi.fn(),
		kill: vi.fn(),
	};
}

describe("ShellSessionManager", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	it("stores startedAt and can restore a taken background session", () => {
		const manager = new ShellSessionManager();
		const session = createSession() as any;
		const startedAt = new Date("2026-03-12T20:00:00.000Z");
		const id = manager.add("pi \"scan\"", session, "calm-reef", "scan", { startedAt });
		const taken = manager.take(id)!;
		expect(taken.startedAt).toEqual(startedAt);
		expect(manager.list()).toHaveLength(0);
		manager.restore(taken);
		expect(manager.list()).toHaveLength(1);
		expect(manager.get(id)?.startedAt).toEqual(startedAt);
	});

	it("restarts cleanup after reattach and removes exited sessions after the delay", () => {
		const manager = new ShellSessionManager();
		const session = createSession() as any;
		const id = manager.add("pi \"scan\"", session);
		manager.get(id);
		session.exited = true;
		manager.restartAutoCleanup(id);
		vi.advanceTimersByTime(1000);
		vi.advanceTimersByTime(30000);
		expect(session.dispose).toHaveBeenCalledTimes(1);
		expect(manager.list()).toHaveLength(0);
	});

	it("killAll kills active sessions and removes background sessions", () => {
		const manager = new ShellSessionManager();
		const backgroundSession = createSession() as any;
		manager.add("pi \"bg\"", backgroundSession, undefined, undefined, { id: "bg-1" });

		const activeKill = vi.fn();
		manager.registerActive({
			id: "active-1",
			command: "pi \"active\"",
			write: vi.fn(),
			kill: activeKill,
			background: vi.fn(),
			getOutput: vi.fn() as any,
			getStatus: vi.fn() as any,
			getRuntime: vi.fn() as any,
			getResult: vi.fn() as any,
			onComplete: vi.fn(),
		});

		manager.killAll();
		expect(backgroundSession.dispose).toHaveBeenCalledTimes(1);
		expect(activeKill).toHaveBeenCalledTimes(1);
	});
});
