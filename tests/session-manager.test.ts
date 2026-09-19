import { beforeEach, describe, expect, it, vi } from "vitest";
import { sessionManager, ShellSessionManager } from "../session-manager.ts";
import type { ActiveSession } from "../session-manager.ts";
import { PtyTerminalSession } from "../pty-session.ts";
import { resolvePiShell } from "../shell-resolution.ts";

function createSession() {
	return {
		exited: false,
		setEventHandlers: vi.fn(),
		dispose: vi.fn(),
		kill: vi.fn(),
	};
}

function createActiveSession(overrides: Partial<ActiveSession> = {}): ActiveSession {
	return {
		id: "active-1",
		command: "pi \"active\"",
		write: vi.fn(),
		kill: vi.fn(),
		background: vi.fn(),
		getOutput: vi.fn(() => ({ output: "", truncated: false, totalBytes: 0 })),
		getStatus: vi.fn((): ActiveSession["getStatus"] extends () => infer Status ? Status : never => "running"),
		getRuntime: vi.fn(() => 0),
		getResult: vi.fn(() => undefined),
		onComplete: vi.fn(),
		...overrides,
	};
}

describe("ShellSessionManager", () => {
	it("reuses the process-wide manager when extension modules reload", async () => {
		vi.resetModules();
		const reloaded = await import("../session-manager.ts");
		expect(reloaded.sessionManager).toBe(sessionManager);

		reloaded.releaseSessionManagerSingleton(reloaded.sessionManager);
		vi.resetModules();
		const replacement = await import("../session-manager.ts");
		expect(replacement.sessionManager).not.toBe(sessionManager);
	});

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

	it("disposes retained active sessions on scheduled cleanup", () => {
		const manager = new ShellSessionManager();
		const dispose = vi.fn();

		manager.registerActive(createActiveSession({ dispose }));
		manager.scheduleCleanup("active-1", 5 * 60 * 1000);

		vi.advanceTimersByTime(5 * 60 * 1000);

		expect(dispose).toHaveBeenCalledTimes(1);
		expect(manager.getActive("active-1")).toBeUndefined();
	});

	it("cancels stale active cleanup on unregister or replacement", () => {
		const manager = new ShellSessionManager();
		const staleDispose = vi.fn();
		const nextDispose = vi.fn();

		manager.registerActive(createActiveSession({ dispose: staleDispose }));
		manager.scheduleCleanup("active-1", 1000);
		manager.unregisterActive("active-1");
		vi.advanceTimersByTime(1000);
		expect(staleDispose).not.toHaveBeenCalled();

		manager.registerActive(createActiveSession({ dispose: staleDispose }));
		manager.scheduleCleanup("active-1", 1000);
		manager.registerActive(createActiveSession({ command: "pi \"next\"", dispose: nextDispose }));
		vi.advanceTimersByTime(1000);
		expect(staleDispose).not.toHaveBeenCalled();
		expect(nextDispose).not.toHaveBeenCalled();
		expect(manager.getActive("active-1")).toBeDefined();
	});

	it("killAll kills active sessions and removes background sessions", () => {
		const manager = new ShellSessionManager();
		const backgroundSession = createSession() as any;
		manager.add("pi \"bg\"", backgroundSession, undefined, undefined, { id: "bg-1" });

		const activeKill = vi.fn();
		manager.registerActive(createActiveSession({ kill: activeKill }));

		manager.killAll();
		expect(backgroundSession.dispose).toHaveBeenCalledTimes(1);
		expect(activeKill).toHaveBeenCalledTimes(1);
	});

	it.runIf(process.platform !== "win32")("shuts down a shared background and active PTY only once", async () => {
		vi.useRealTimers();
		let resolveReady!: () => void;
		const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
		const session = new PtyTerminalSession(
			{ command: "trap '' TERM; printf 'ready\\n'; while :; do sleep 1; done", shellConfig: resolvePiShell(process.cwd(), true) },
			{ onData: (data) => { if (data.includes("ready")) resolveReady(); } },
		);
		await ready;
		const manager = new ShellSessionManager();
		manager.add("shared", session, undefined, undefined, { id: "shared-shutdown" });
		const staleExit = vi.fn();
		session.addExitListener(staleExit);
		manager.registerActive(createActiveSession({ id: "shared-shutdown", kill: () => session.kill() }));
		const groupSignals: Array<string | number | undefined> = [];
		const groupKill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
			if (pid < 0) {
				groupSignals.push(signal);
				return true;
			}
			return true;
		});

		manager.killAll();
		manager.killAll();
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(groupSignals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(manager.list()).toEqual([]);
		expect(manager.getActive("shared-shutdown")).toBeUndefined();
		expect(staleExit).not.toHaveBeenCalled();
		groupKill.mockRestore();
	});
});
