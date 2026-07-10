import { beforeEach, describe, expect, it, vi } from "vitest";
import { HeadlessDispatchMonitor } from "../headless-monitor.js";
import type { InteractiveShellConfig } from "../config.js";

const config: InteractiveShellConfig = {
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
	return {
		exited: false,
		exitCode: null as number | null,
		signal: undefined as number | undefined,
		kill: vi.fn(),
		getTailLines: vi.fn(async () => ({ lines: ["final"], totalLinesInBuffer: 1, truncatedByChars: false })),
		getRawStream: vi.fn(() => rawOutput),
		addDataListener(fn: (data: string) => void) {
			onData = fn;
			return () => {
				onData = null;
			};
		},
		addExitListener(fn: (exitCode: number | null, signal?: number) => void) {
			onExit = fn;
			return () => {
				onExit = null;
			};
		},
		emitData(data: string) {
			rawOutput += data;
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
	beforeEach(() => {
		vi.useFakeTimers();
	});

	it("does not reset quiet timer for ANSI-only data", async () => {
		const session = createSession();
		const onComplete = vi.fn();
		new HeadlessDispatchMonitor(
			session,
			config,
			{
				autoExitOnQuiet: true,
				quietThreshold: 1000,
				gracePeriod: 0,
				startedAt: 0,
			},
			onComplete,
		);

		session.emitData("\u001b[2K\u001b[1G");
		await vi.advanceTimersByTimeAsync(1000);
		await Promise.resolve();
		await Promise.resolve();
		expect(session.kill).toHaveBeenCalledTimes(1);
		expect(onComplete).toHaveBeenCalledTimes(1);
	});

	it("respects startup grace period and preserves explicit startedAt", () => {
		vi.setSystemTime(new Date("2026-03-12T20:00:00.000Z"));
		const explicitStartTime = Date.now() - 4000;
		const session = createSession();
		const monitor = new HeadlessDispatchMonitor(
			session,
			config,
			{
				autoExitOnQuiet: true,
				quietThreshold: 1000,
				gracePeriod: 5000,
				startedAt: explicitStartTime,
			},
			vi.fn(),
		);

		vi.advanceTimersByTime(999);
		expect(session.kill).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(session.kill).toHaveBeenCalledTimes(1);
		expect(monitor.startTime).toBe(explicitStartTime);
	});

	it("captures completion output on natural exit", async () => {
		const session = createSession();
		const onComplete = vi.fn();
		const monitor = new HeadlessDispatchMonitor(
			session,
			config,
			{
				autoExitOnQuiet: false,
				quietThreshold: 1000,
			},
			onComplete,
		);

		session.emitExit(0);
		await Promise.resolve();
		await Promise.resolve();
		expect(onComplete).toHaveBeenCalledWith({
			exitCode: 0,
			signal: undefined,
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

	it("emits stream monitor events from ANSI-stripped line output", () => {
		const session = createSession();
		const onMonitorEvent = vi.fn();
		new HeadlessDispatchMonitor(
			session,
			config,
			{
				autoExitOnQuiet: false,
				quietThreshold: 1000,
				monitor: {
					strategy: "stream",
					triggers: [
						{
							id: "error",
							match: (input) => /ERROR:\s+.+/.exec(input)?.[0],
						},
					],
					pollIntervalMs: 5000,
					dedupeExactLine: true,
				},
				onMonitorEvent,
			},
			vi.fn(),
		);

		session.emitData("\u001b[31mERROR:\u001b[0m failed to compile\n");
		expect(onMonitorEvent).toHaveBeenCalledWith({
			strategy: "stream",
			triggerId: "error",
			eventType: "error",
			matchedText: "ERROR: failed to compile",
			lineOrDiff: "ERROR: failed to compile",
			stream: "terminal",
		});
	});

	it("emits file-watch monitor events from line output", () => {
		const session = createSession();
		const onMonitorEvent = vi.fn();
		new HeadlessDispatchMonitor(
			session,
			config,
			{
				autoExitOnQuiet: false,
				quietThreshold: 1000,
				monitor: {
					strategy: "file-watch",
					triggers: [
						{
							id: "pdf",
							match: (input) => (/\.pdf$/i.test(input) ? input : undefined),
						},
					],
					pollIntervalMs: 5000,
					dedupeExactLine: true,
				},
				onMonitorEvent,
			},
			vi.fn(),
		);

		session.emitData("RENAME invoices/acme-0042.pdf\n");
		expect(onMonitorEvent).toHaveBeenCalledWith({
			strategy: "file-watch",
			triggerId: "pdf",
			eventType: "pdf",
			matchedText: "RENAME invoices/acme-0042.pdf",
			lineOrDiff: "RENAME invoices/acme-0042.pdf",
			stream: "terminal",
		});
	});

	it("dedupes exact matching lines per trigger within one stream monitor session", () => {
		const session = createSession();
		const onMonitorEvent = vi.fn();
		new HeadlessDispatchMonitor(
			session,
			config,
			{
				autoExitOnQuiet: false,
				quietThreshold: 1000,
				monitor: {
					strategy: "stream",
					triggers: [
						{
							id: "tests",
							match: (input) => /Test Files/.exec(input)?.[0],
						},
					],
					pollIntervalMs: 5000,
					dedupeExactLine: true,
				},
				onMonitorEvent,
			},
			vi.fn(),
		);

		session.emitData("Test Files  1 passed (1)\n");
		session.emitData("Test Files  1 passed (1)\n");
		expect(onMonitorEvent).toHaveBeenCalledTimes(1);
	});

	it("emits poll-diff events when normalized output changes", () => {
		const session = createSession();
		const onMonitorEvent = vi.fn();
		new HeadlessDispatchMonitor(
			session,
			config,
			{
				autoExitOnQuiet: false,
				quietThreshold: 1000,
				monitor: {
					strategy: "poll-diff",
					triggers: [
						{
							id: "changed",
							match: (input) => (input.length > 0 ? "changed" : undefined),
						},
					],
					pollIntervalMs: 500,
					dedupeExactLine: true,
				},
				onMonitorEvent,
			},
			vi.fn(),
		);

		vi.advanceTimersByTime(500); // establish baseline
		session.emitData("status=green\n");
		vi.advanceTimersByTime(500); // changed snapshot

		expect(onMonitorEvent).toHaveBeenCalledTimes(1);
		expect(onMonitorEvent.mock.calls[0]?.[0]).toMatchObject({
			strategy: "poll-diff",
			triggerId: "changed",
			eventType: "changed",
			matchedText: "changed",
			stream: "terminal",
		});
	});

	it("dispose() runs local complete callbacks so hands-free timers stop when the monitor is dismissed", () => {
		const session = createSession();
		const onComplete = vi.fn();
		const localComplete = vi.fn();
		const monitor = new HeadlessDispatchMonitor(
			session,
			config,
			{
				autoExitOnQuiet: false,
				quietThreshold: 1000,
			},
			onComplete,
		);
		monitor.registerCompleteCallback(localComplete);

		monitor.dispose();
		// dispose runs local cleanup (progress timers etc.) but is silent — onComplete is not invoked.
		expect(localComplete).toHaveBeenCalledTimes(1);
		expect(onComplete).not.toHaveBeenCalled();
		expect(monitor.disposed).toBe(true);
	});
});
