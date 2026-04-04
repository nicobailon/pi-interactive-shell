import { afterEach, describe, expect, it, vi } from "vitest";
import type { InteractiveShellConfig } from "../config.js";

const config: InteractiveShellConfig = {
	exitAutoCloseDelay: 10,
	overlayWidthPercent: 95,
	overlayHeightPercent: 60,
	focusShortcut: "alt+shift+f",
	spawn: {
		defaultAgent: "pi",
		shortcut: "alt+shift+p",
		commands: { pi: "pi", codex: "codex", claude: "claude" },
		defaultArgs: { pi: [], codex: [], claude: [] },
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
	};
}

async function loadOverlay() {
	vi.resetModules();
	vi.doMock("@mariozechner/pi-tui", () => ({
		matchesKey: () => false,
		truncateToWidth: (value: string, width: number) => value.length > width ? value.slice(0, width) : value,
		visibleWidth: (value: string) => stripAnsi(value).length,
	}));
	vi.doMock("../pty-session.js", () => ({
		PtyTerminalSession: class MockPtyTerminalSession {},
	}));
	vi.doMock("../session-manager.js", () => ({
		sessionManager: {
			registerActive: vi.fn(),
			unregisterActive: vi.fn(),
			add: vi.fn(() => "bg-1"),
		},
		generateSessionId: vi.fn(() => "session-1"),
	}));
	vi.doMock("../handoff-utils.js", () => ({
		captureCompletionOutput: vi.fn(() => undefined),
		captureTransferOutput: vi.fn(() => undefined),
		maybeBuildHandoffPreview: vi.fn(() => undefined),
		maybeWriteHandoffSnapshot: vi.fn(() => undefined),
	}));
	vi.doMock("../session-query.js", () => ({
		createSessionQueryState: vi.fn(() => ({})),
		getSessionOutput: vi.fn(() => ({ output: "", truncated: false, totalBytes: 0 })),
	}));
	return import("../overlay-component.js");
}

describe("InteractiveShellOverlay render focus cues", () => {
	afterEach(() => {
		vi.doUnmock("@mariozechner/pi-tui");
		vi.doUnmock("../pty-session.js");
		vi.doUnmock("../session-manager.js");
		vi.doUnmock("../handoff-utils.js");
		vi.doUnmock("../session-query.js");
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
