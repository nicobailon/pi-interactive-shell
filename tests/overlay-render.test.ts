import { afterEach, describe, expect, it, vi } from "vitest";
import type { InteractiveShellConfig } from "../config.ts";

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

function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function createExistingSession() {
	let handlers: { onData?: (data: string) => void; onExit?: () => void } = {};
	return {
		pid: 4242,
		rows: 20,
		exited: false,
		exitCode: 0,
		signal: undefined,
		setEventHandlers(next: typeof handlers) {
			handlers = next;
		},
		resize: vi.fn(),
		scrollToBottom: vi.fn(),
		getViewportLines: vi.fn(() => ["echo hello"]),
		isScrolledUp: vi.fn(() => false),
		write: vi.fn(),
		scrollUp: vi.fn(),
		scrollDown: vi.fn(),
		getRawStream: vi.fn(() => ""),
		kill: vi.fn(),
		dispose: vi.fn(),
		getTailLines: vi.fn(() => ({ lines: [], totalLinesInBuffer: 0, truncatedByChars: false })),
		emitExit() {
			handlers.onExit?.();
		},
	};
}

async function loadOverlay() {
	vi.resetModules();
	const sessionManager = {
		registerActive: vi.fn(),
		unregisterActive: vi.fn(),
		add: vi.fn(() => "bg-1"),
	};
	vi.doMock("@earendil-works/pi-tui", () => ({
		matchesKey: (data: string, key: string) => data === "\x02" && key === "ctrl+b",
		truncateToWidth: (value: string, width: number) => value.length > width ? value.slice(0, width) : value,
		visibleWidth: (value: string) => stripAnsi(value).length,
	}));
	vi.doMock("../pty-session.ts", () => ({
		PtyTerminalSession: class MockPtyTerminalSession {},
	}));
	vi.doMock("../session-manager.ts", () => ({
		sessionManager,
		generateSessionId: vi.fn(() => "session-1"),
	}));
	vi.doMock("../handoff-utils.ts", () => ({
		captureCompletionOutput: vi.fn(() => ({ lines: ["final output"], totalLines: 1, truncated: false })),
		captureTransferOutput: vi.fn(() => undefined),
		maybeBuildHandoffPreview: vi.fn(() => undefined),
		maybeWriteHandoffSnapshot: vi.fn(() => undefined),
	}));
	vi.doMock("../session-query.ts", () => ({
		createSessionQueryState: vi.fn(() => ({})),
		getSessionOutput: vi.fn((_session, _config, _state, _options, completionOutput) => ({
			output: completionOutput?.lines.join("\n") ?? "",
			truncated: completionOutput?.truncated ?? false,
			totalBytes: completionOutput?.lines.join("\n").length ?? 0,
			totalLines: completionOutput?.totalLines,
		})),
	}));
	return { ...(await import("../overlay-component.ts")), sessionManager };
}

describe("InteractiveShellOverlay render focus cues", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.doUnmock("@earendil-works/pi-tui");
		vi.doUnmock("../pty-session.ts");
		vi.doUnmock("../session-manager.ts");
		vi.doUnmock("../handoff-utils.ts");
		vi.doUnmock("../session-query.ts");
	});

	it("registers interactive sessions under the supplied control id", async () => {
		const { InteractiveShellOverlay, sessionManager } = await loadOverlay();
		const session = createExistingSession();
		let result: any;
		const overlay = new InteractiveShellOverlay(
			{ terminal: { columns: 120, rows: 40 }, requestRender: vi.fn() } as any,
			{
				fg: (_color: string, text: string) => text,
				bg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			} as any,
			{
				command: "pi",
				existingSession: session as any,
				mode: "interactive",
				sessionId: "control-1",
			},
			config,
			(value) => { result = value; },
		);

		expect(sessionManager.registerActive).toHaveBeenCalledWith(expect.objectContaining({
			id: "control-1",
			command: "pi",
		}));

		overlay.backgroundSession();
		expect(sessionManager.add).toHaveBeenCalledWith(
			"pi",
			session,
			undefined,
			undefined,
			expect.objectContaining({ id: "control-1" }),
		);
		expect(result).toMatchObject({ backgrounded: true, backgroundId: "bg-1", sessionId: "control-1" });
	});

	it("backgrounds a hands-free session with Ctrl+B without reporting user takeover", async () => {
		const { InteractiveShellOverlay, sessionManager } = await loadOverlay();
		const session = createExistingSession();
		const onHandsFreeUpdate = vi.fn();
		let result: any;
		const overlay = new InteractiveShellOverlay(
			{ terminal: { columns: 120, rows: 40 }, requestRender: vi.fn() } as any,
			{
				fg: (_color: string, text: string) => text,
				bg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			} as any,
			{
				command: "pi",
				existingSession: session as any,
				mode: "hands-free",
				sessionId: "hands-free-1",
				onHandsFreeUpdate,
			},
			config,
			(value) => { result = value; },
		);

		const activeSession = sessionManager.registerActive.mock.calls[0][0];
		overlay.handleInput("\x02");

		expect(onHandsFreeUpdate).not.toHaveBeenCalled();
		expect(session.write).not.toHaveBeenCalled();
		expect(session.kill).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			backgrounded: true,
			backgroundId: "bg-1",
			sessionId: "hands-free-1",
			userTookOver: false,
		});
		expect(activeSession.getResult()).toEqual(result);
	});

	it("keeps completed dispatch output queryable until cleanup", async () => {
		const { InteractiveShellOverlay, sessionManager } = await loadOverlay();
		const session = createExistingSession();
		let result: any;
		new InteractiveShellOverlay(
			{ terminal: { columns: 120, rows: 40 }, requestRender: vi.fn() } as any,
			{
				fg: (_color: string, text: string) => text,
				bg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			} as any,
			{
				command: "pi",
				existingSession: session as any,
				mode: "dispatch",
				sessionId: "dispatch-1",
			},
			config,
			(value) => { result = value; },
		);

		session.emitExit();

		const activeSession = sessionManager.registerActive.mock.calls[0][0];
		expect(result).toMatchObject({ backgrounded: false, sessionId: "dispatch-1" });
		expect(activeSession.getResult()).toMatchObject({ sessionId: "dispatch-1" });
		expect(activeSession.getOutput({ skipRateLimit: true })).toMatchObject({ output: "final output", totalLines: 1 });
		expect(sessionManager.unregisterActive).not.toHaveBeenCalled();
		expect(session.dispose).not.toHaveBeenCalled();
	});

	it("disposes non-dispatch active completions immediately", async () => {
		vi.useFakeTimers();
		const { InteractiveShellOverlay } = await loadOverlay();
		const tui = { terminal: { columns: 120, rows: 40 }, requestRender: vi.fn() } as any;
		const theme = {
			fg: (_color: string, text: string) => text,
			bg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		} as any;

		const exitSession = createExistingSession();
		new InteractiveShellOverlay(tui, theme, {
			command: "pi",
			existingSession: exitSession as any,
			mode: "interactive",
			sessionId: "exit-1",
		}, config, () => {});
		exitSession.emitExit();
		vi.advanceTimersByTime(config.exitAutoCloseDelay * 1000);
		expect(exitSession.dispose).toHaveBeenCalledTimes(1);

		const killSession = createExistingSession();
		const killOverlay = new InteractiveShellOverlay(tui, theme, {
			command: "pi",
			existingSession: killSession as any,
			mode: "hands-free",
			sessionId: "kill-1",
		}, config, () => {});
		killOverlay.killSession();
		expect(killSession.dispose).toHaveBeenCalledTimes(1);

		const timeoutSession = createExistingSession();
		new InteractiveShellOverlay(tui, theme, {
			command: "pi",
			existingSession: timeoutSession as any,
			mode: "hands-free",
			sessionId: "timeout-1",
			timeout: 100,
		}, config, () => {});
		vi.advanceTimersByTime(100);
		expect(timeoutSession.dispose).toHaveBeenCalledTimes(1);
	});

	it("commits quiet cancellation before the final hands-free update", async () => {
		vi.useFakeTimers();
		const { InteractiveShellOverlay, sessionManager } = await loadOverlay();
		const session = createExistingSession();
		let statusAtUpdate: string | undefined;
		let resultAtUpdate: any;
		let activeSession: any;
		new InteractiveShellOverlay(
			{ terminal: { columns: 120, rows: 40 }, requestRender: vi.fn() } as any,
			{ fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text } as any,
			{
				command: "pi",
				existingSession: session as any,
				mode: "hands-free",
				sessionId: "quiet-1",
				autoExitOnQuiet: true,
				autoExitGracePeriod: 0,
				handsFreeQuietThreshold: 100,
				onHandsFreeUpdate: (update) => {
					if (update.status === "killed") {
						statusAtUpdate = activeSession.getStatus();
						resultAtUpdate = activeSession.getResult();
					}
				},
			},
			config,
			() => {},
		);
		activeSession = sessionManager.registerActive.mock.calls[0][0];

		vi.advanceTimersByTime(100);
		expect(statusAtUpdate).toBe("killed");
		expect(resultAtUpdate).toMatchObject({ completionReason: "auto-close-quiet", cancelled: true });
		expect(session.kill.mock.invocationCallOrder[0]).toBeLessThan(session.dispose.mock.invocationCallOrder[0]);
	});

	it("reports forced foreground timeout as committed local cancellation", async () => {
		vi.useFakeTimers();
		const { InteractiveShellOverlay, sessionManager } = await loadOverlay();
		const session = createExistingSession();
		const updates: string[] = [];
		let statusAtUpdate: string | undefined;
		let resultAtUpdate: any;
		let activeSession: any;
		new InteractiveShellOverlay(
			{ terminal: { columns: 120, rows: 40 }, requestRender: vi.fn() } as any,
			{ fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text } as any,
			{
				command: "pi",
				existingSession: session as any,
				mode: "hands-free",
				sessionId: "timeout-1",
				timeout: 100,
				onHandsFreeUpdate: (update) => {
					updates.push(update.status);
					if (update.status === "killed") {
						statusAtUpdate = activeSession.getStatus();
						resultAtUpdate = activeSession.getResult();
					}
				},
			},
			config,
			() => {},
		);
		activeSession = sessionManager.registerActive.mock.calls[0][0];

		vi.advanceTimersByTime(100);
		expect(updates).toEqual(["killed"]);
		expect(statusAtUpdate).toBe("killed");
		expect(resultAtUpdate).toMatchObject({ completionReason: "timed-out", timedOut: true, cancelled: true });
		expect(session.kill.mock.invocationCallOrder[0]).toBeLessThan(session.dispose.mock.invocationCallOrder[0]);
	});

	it("shows distinct badges and border styles for focused and unfocused states", async () => {
		const { InteractiveShellOverlay } = await loadOverlay();
		const session = createExistingSession();
		const overlay = new InteractiveShellOverlay(
			{ terminal: { columns: 120, rows: 40 }, requestRender: vi.fn() } as any,
			{
				fg: (_color: string, text: string) => text,
				bg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			} as any,
			{
				command: "pi",
				existingSession: session as any,
			},
			config,
			() => {},
		);

		overlay.focused = false;
		const unfocused = overlay.render(80).join("\n");
		expect(unfocused).toContain("EDITOR FOCUSED");
		expect(unfocused).toContain("╭");
		expect(unfocused).toContain("╯");

		overlay.focused = true;
		const focused = overlay.render(80).join("\n");
		expect(focused).toContain("SHELL FOCUSED");
		expect(focused).toContain("╔");
		expect(focused).toContain("╝");
	});
});
