import { beforeEach, describe, expect, it, vi } from "vitest";
import { HeadlessDispatchMonitor } from "../headless-monitor.ts";
import type { InteractiveShellConfig } from "../config.ts";
import { PtyTerminalSession } from "../pty-session.ts";
import { resolvePiShell } from "../shell-resolution.ts";

const config: InteractiveShellConfig = {
	defer: false,
	exitAutoCloseDelay: 10,
	overlayWidthPercent: 95,
	overlayHeightPercent: 60,
	overlayAnchor: "center",
	focusShortcut: "alt+shift+f",
	spawn: {
		defaultAgent: "pi",
		shortcut: "alt+shift+p",
		commands: { pi: "pi", codex: "codex", claude: "claude", cursor: "agent" },
		defaultArgs: { pi: [], codex: [], claude: [], cursor: [] },
		worktree: false,
		worktreeBaseDir: undefined,
	},
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

function createSession() {
	let onData: ((data: string) => void) | null = null;
	let onExit: ((exitCode: number | null, signal?: number) => void) | null = null;
	let rawOutput = "";
	let visualGeneration = 0;
	let visualListeners: Array<() => void> = [];
	return {
		get visualGeneration() { return visualGeneration; },
		exited: false,
		exitCode: null as number | null,
		signal: undefined as number | undefined,
		kill: vi.fn(),
		getTailLines: vi.fn(() => ({ lines: ["final"], totalLinesInBuffer: 1, truncatedByChars: false })),
		getRawStream: vi.fn(() => rawOutput),
		getViewportLines: vi.fn(() => rawOutput.split("\n")),
		addVisualChangeListener(fn: () => void) { visualListeners.push(fn); return () => { visualListeners = visualListeners.filter((item) => item !== fn); }; },
		addDataListener(fn: (data: string) => void) {
			onData = fn;
			return () => { onData = null; };
		},
		addExitListener(fn: (exitCode: number | null, signal?: number) => void) {
			onExit = fn;
			return () => { onExit = null; };
		},
		emitData(data: string) {
			rawOutput += data;
			visualGeneration += 1;
			for (const listener of [...visualListeners]) listener();
			onData?.(data);
		},
		emitExit(exitCode: number | null, signal?: number) {
			this.exited = true;
			this.exitCode = exitCode;
			this.signal = signal;
			onExit?.(exitCode, signal);
		},
	} as any;
}

describe("HeadlessDispatchMonitor", () => {
	it("defers completion authority until foreground ownership is transferred exactly once", async () => {
		const session = createSession();
		const foregroundCompletion = vi.fn();
		const backgroundCompletion = vi.fn();
		const monitor = new HeadlessDispatchMonitor(session, config, {
			autoExitOnQuiet: false, quietThreshold: 100, gracePeriod: 10, deferLifecycle: true,
		}, foregroundCompletion);
		session.emitExit(0);
		expect(foregroundCompletion).not.toHaveBeenCalled();
		monitor.activateBackgroundLifecycle({ autoExitOnQuiet: false, onComplete: backgroundCompletion });
		monitor.activateBackgroundLifecycle({ autoExitOnQuiet: false, onComplete: vi.fn() });
		await Promise.resolve();
		expect(backgroundCompletion).toHaveBeenCalledTimes(1);
		expect(foregroundCompletion).not.toHaveBeenCalled();
		expect(monitor.disposed).toBe(true);
	});

	beforeEach(() => {
		vi.useFakeTimers();
	});

	it("does not reset quiet timer for ANSI-only data", () => {
		const session = createSession();
		const onComplete = vi.fn();
		let cancelledAfterCommit = false;
		let monitor!: HeadlessDispatchMonitor;
		session.kill.mockImplementation(() => { cancelledAfterCommit = monitor.disposed; });
		monitor = new HeadlessDispatchMonitor(session, config, {
			autoExitOnQuiet: true,
			quietThreshold: 1000,
			gracePeriod: 0,
			startedAt: 0,
		}, onComplete);

		session.emitData("\u001b[2K\u001b[1G");
		vi.advanceTimersByTime(1000);
		expect(session.kill).toHaveBeenCalledTimes(1);
		expect(cancelledAfterCommit).toBe(true);
		expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({
			cancelled: true,
			autoClosedOnQuiet: true,
			completionReason: "auto-close-quiet",
		}));
	});

	it("aborts observe-only semantics on kill without writing semantic input or emitting monitor events", async () => {
		const session = createSession();
		let signal: AbortSignal | undefined;
		const never = new Promise<unknown>(() => {});
		const onMonitorEvent = vi.fn();
		const monitor = new HeadlessDispatchMonitor(session, config, {
			autoExitOnQuiet: false, quietThreshold: 1000, onMonitorEvent,
			semantic: {
				sessionId: "s", mode: "dispatch", config: { minIntervalMs: 250 }, model: "jev-1.13.0", requestTimeoutMs: 1000,
				client: { evaluate: vi.fn((_request, options) => { signal = options.signal; return never; }) },
				bounds: { maxViewportLines: 10, maxRecentChars: 100, redactionPatterns: [] }, isEpochCurrent: () => true, onDecision: vi.fn(),
			},
		}, vi.fn());
		session.emitData("working");
		await vi.advanceTimersByTimeAsync(0);
		expect(signal?.aborted).toBe(false);
		monitor.kill();
		expect(signal?.aborted).toBe(true);
		expect(onMonitorEvent).not.toHaveBeenCalled();
		expect(session.kill).toHaveBeenCalledTimes(1);
	});

	it("aborts semantics for exit, disposal, external completion, and timeout", async () => {
		for (const lifecycle of ["exit", "dispose", "external", "timeout"] as const) {
			const session = createSession(); let signal: AbortSignal | undefined; let resolve!: (value: unknown) => void;
			const work = new Promise<unknown>((done) => { resolve = done; });
			const decisions = vi.fn();
			const monitor = new HeadlessDispatchMonitor(session, config, {
				autoExitOnQuiet: false, quietThreshold: 1000, timeout: lifecycle === "timeout" ? 10 : undefined,
				semantic: {
					sessionId: "s", mode: "dispatch", config: { minIntervalMs: 250 }, model: "jev-1.13.0", requestTimeoutMs: 1000,
					client: { evaluate: vi.fn((_request, options) => { signal = options.signal; return work; }) },
					bounds: { maxViewportLines: 10, maxRecentChars: 100, redactionPatterns: [] }, isEpochCurrent: () => true, onDecision: decisions,
				},
			}, vi.fn());
			session.emitData("working"); await vi.advanceTimersByTimeAsync(0);
			if (lifecycle === "exit") session.emitExit(0);
			if (lifecycle === "dispose") monitor.dispose();
			if (lifecycle === "external") monitor.handleExternalCompletion(0);
			if (lifecycle === "timeout") await vi.advanceTimersByTimeAsync(10);
			expect(signal?.aborted, lifecycle).toBe(true);
			resolve({}); await Promise.resolve(); await Promise.resolve();
			expect(decisions, lifecycle).not.toHaveBeenCalled();
		}
	});

	it("applies existing semantic candidate dedupe and per-trigger cooldown independently", () => {
		const session = createSession(); const events: unknown[] = [];
		const monitor = new HeadlessDispatchMonitor(session, config, {
			autoExitOnQuiet: false, quietThreshold: 1000,
			monitor: { strategy: "semantic", triggers: [], pollIntervalMs: 1000, dedupeExactLine: true, cooldownMs: 100 },
			onMonitorEvent: (event) => { events.push(event); },
		}, vi.fn());
		const first = { strategy: "semantic" as const, triggerId: "semantic:watch:first", eventType: "semantic-watch", matchedText: "watch:first", lineOrDiff: "Semantic watch matched: first", stream: "pty" as const };
		const second = { ...first, triggerId: "semantic:watch:second", matchedText: "watch:second", lineOrDiff: "Semantic watch matched: second" };
		expect(monitor.submitMonitorCandidate(first, "1:semantic:watch:first")).toBe(true);
		expect(monitor.submitMonitorCandidate(first, "1:semantic:watch:first")).toBe(false);
		expect(monitor.submitMonitorCandidate(second, "1:semantic:watch:second")).toBe(true);
		expect(events).toHaveLength(2);
		expect(monitor.submitMonitorCandidate(first, "2:semantic:watch:first")).toBe(false);
		vi.advanceTimersByTime(100);
		expect(monitor.submitMonitorCandidate(first, "3:semantic:watch:first")).toBe(true);
		monitor.dispose();
	});

	it("respects startup grace period and preserves explicit startedAt", () => {
		vi.setSystemTime(new Date("2026-03-12T20:00:00.000Z"));
		const explicitStartTime = Date.now() - 4000;
		const session = createSession();
		const monitor = new HeadlessDispatchMonitor(session, config, {
			autoExitOnQuiet: true,
			quietThreshold: 1000,
			gracePeriod: 5000,
			startedAt: explicitStartTime,
		}, vi.fn());

		vi.advanceTimersByTime(999);
		expect(session.kill).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(session.kill).toHaveBeenCalledTimes(1);
		expect(monitor.startTime).toBe(explicitStartTime);
	});

	it("captures completion output on natural exit", () => {
		const session = createSession();
		const onComplete = vi.fn();
		const monitor = new HeadlessDispatchMonitor(session, config, {
			autoExitOnQuiet: false,
			quietThreshold: 1000,
		}, onComplete);

		session.emitExit(0);
		expect(onComplete).toHaveBeenCalledWith({
			exitCode: 0,
			signal: undefined,
			completionReason: "exited",
			timedOut: undefined,
			cancelled: undefined,
			completionOutput: {
				lines: ["final"],
				totalLines: 1,
				truncated: false,
			},
		});
		expect(monitor.getResult()?.completionOutput?.lines).toEqual(["final"]);
	});

	it("reports an explicit monitor kill as killed", () => {
		const session = createSession();
		const onComplete = vi.fn();
		const monitor = new HeadlessDispatchMonitor(session, config, {
			autoExitOnQuiet: false,
			quietThreshold: 1000,
		}, onComplete);

		monitor.kill();

		expect(session.kill).toHaveBeenCalledTimes(1);
		expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({
			cancelled: true,
			completionReason: "killed",
		}));
	});

	it("reports timeout as local cancellation", () => {
		const session = createSession();
		const onComplete = vi.fn();
		const monitor = new HeadlessDispatchMonitor(session, config, {
			autoExitOnQuiet: false,
			quietThreshold: 1000,
			timeout: 100,
		}, onComplete);

		vi.advanceTimersByTime(100);

		expect(session.kill).toHaveBeenCalledTimes(1);
		expect(monitor.getResult()).toEqual(expect.objectContaining({
			completionReason: "timed-out",
			timedOut: true,
			cancelled: true,
		}));
		expect(onComplete).toHaveBeenCalledTimes(1);
	});

	it.runIf(process.platform !== "win32")("publishes one local cancellation when final escalation fails", async () => {
		vi.useRealTimers();
		let resolveReady!: () => void;
		const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
		const session = new PtyTerminalSession(
			{ command: "trap '' TERM; printf 'ready\\n'; while :; do sleep 1; done", shellConfig: resolvePiShell(process.cwd(), true) },
			{ onData: (data) => { if (data.includes("ready")) resolveReady(); } },
		);
		await ready;
		const originalKill = process.kill.bind(process);
		let groupAttempt = 0;
		const failure = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
		const groupKill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
			if (pid >= 0) return originalKill(pid, signal);
			groupAttempt++;
			if (groupAttempt === 1) return true;
			throw failure;
		});
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
		const onComplete = vi.fn();
		const monitor = new HeadlessDispatchMonitor(session, config, { autoExitOnQuiet: false, quietThreshold: 1000 }, onComplete);

		monitor.kill();
		expect(monitor.disposed).toBe(true);
		expect(onComplete).toHaveBeenCalledTimes(1);
		expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ completionReason: "killed", cancelled: true }));
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(groupAttempt).toBe(2);
		expect(onComplete).toHaveBeenCalledTimes(1);
		expect(errorLog).toHaveBeenCalledWith("interactive-shell: failed to signal PTY with SIGKILL:", failure);

		groupKill.mockRestore();
		errorLog.mockRestore();
		session.dispose();
	});

	it("emits stream monitor events from ANSI-stripped line output", () => {
		const session = createSession();
		const onMonitorEvent = vi.fn();
		new HeadlessDispatchMonitor(session, config, {
			autoExitOnQuiet: false,
			quietThreshold: 1000,
			monitor: {
				strategy: "stream",
				triggers: [{
					id: "error",
					match: (input) => /ERROR:\s+.+/.exec(input)?.[0],
				}],
				pollIntervalMs: 5000,
				dedupeExactLine: true,
			},
			onMonitorEvent,
		}, vi.fn());

		session.emitData("\u001b[31mERROR:\u001b[0m failed to compile\n");
		expect(onMonitorEvent).toHaveBeenCalledWith({
			strategy: "stream",
			triggerId: "error",
			eventType: "error",
			matchedText: "ERROR: failed to compile",
			lineOrDiff: "ERROR: failed to compile",
			stream: "pty",
		});
	});

	it("emits file-watch monitor events from line output", () => {
		const session = createSession();
		const onMonitorEvent = vi.fn();
		new HeadlessDispatchMonitor(session, config, {
			autoExitOnQuiet: false,
			quietThreshold: 1000,
			monitor: {
				strategy: "file-watch",
				triggers: [{
					id: "pdf",
					match: (input) => /\.pdf$/i.test(input) ? input : undefined,
				}],
				pollIntervalMs: 5000,
				dedupeExactLine: true,
			},
			onMonitorEvent,
		}, vi.fn());

		session.emitData("RENAME invoices/acme-0042.pdf\n");
		expect(onMonitorEvent).toHaveBeenCalledWith({
			strategy: "file-watch",
			triggerId: "pdf",
			eventType: "pdf",
			matchedText: "RENAME invoices/acme-0042.pdf",
			lineOrDiff: "RENAME invoices/acme-0042.pdf",
			stream: "pty",
		});
	});

	it("dedupes exact matching lines per trigger within one stream monitor session", () => {
		const session = createSession();
		const onMonitorEvent = vi.fn();
		new HeadlessDispatchMonitor(session, config, {
			autoExitOnQuiet: false,
			quietThreshold: 1000,
			monitor: {
				strategy: "stream",
				triggers: [{
					id: "tests",
					match: (input) => /Test Files/.exec(input)?.[0],
				}],
				pollIntervalMs: 5000,
				dedupeExactLine: true,
			},
			onMonitorEvent,
		}, vi.fn());

		session.emitData("Test Files  1 passed (1)\n");
		session.emitData("Test Files  1 passed (1)\n");
		expect(onMonitorEvent).toHaveBeenCalledTimes(1);
	});

	it("emits poll-diff events when normalized output changes", () => {
		const session = createSession();
		const onMonitorEvent = vi.fn();
		new HeadlessDispatchMonitor(session, config, {
			autoExitOnQuiet: false,
			quietThreshold: 1000,
			monitor: {
				strategy: "poll-diff",
				triggers: [{
					id: "changed",
					match: (input) => input.length > 0 ? "changed" : undefined,
				}],
				pollIntervalMs: 500,
				dedupeExactLine: true,
			},
			onMonitorEvent,
		}, vi.fn());

		vi.advanceTimersByTime(500); // establish baseline
		session.emitData("status=green\n");
		vi.advanceTimersByTime(500); // changed snapshot

		expect(onMonitorEvent).toHaveBeenCalledTimes(1);
		expect(onMonitorEvent.mock.calls[0]?.[0]).toMatchObject({
			strategy: "poll-diff",
			triggerId: "changed",
			eventType: "changed",
			matchedText: "changed",
			stream: "pty",
		});
	});
});
