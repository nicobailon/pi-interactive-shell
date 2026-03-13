import { beforeEach, describe, expect, it, vi } from "vitest";
import { HeadlessDispatchMonitor } from "../headless-monitor.js";
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

function createSession() {
	let onData: ((data: string) => void) | null = null;
	let onExit: ((exitCode: number | null, signal?: number) => void) | null = null;
	return {
		exited: false,
		exitCode: null as number | null,
		signal: undefined as number | undefined,
		kill: vi.fn(),
		getTailLines: vi.fn(() => ({ lines: ["final"], totalLinesInBuffer: 1, truncatedByChars: false })),
		addDataListener(fn: (data: string) => void) {
			onData = fn;
			return () => { onData = null; };
		},
		addExitListener(fn: (exitCode: number | null, signal?: number) => void) {
			onExit = fn;
			return () => { onExit = null; };
		},
		emitData(data: string) {
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

	it("does not reset quiet timer for ANSI-only data", () => {
		const session = createSession();
		const onComplete = vi.fn();
		new HeadlessDispatchMonitor(session, config, {
			autoExitOnQuiet: true,
			quietThreshold: 1000,
			gracePeriod: 0,
			startedAt: 0,
		}, onComplete);

		session.emitData("\u001b[2K\u001b[1G");
		vi.advanceTimersByTime(1000);
		expect(session.kill).toHaveBeenCalledTimes(1);
		expect(onComplete).toHaveBeenCalledTimes(1);
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
});
