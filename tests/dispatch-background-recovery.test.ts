import { afterEach, describe, expect, it, vi } from "vitest";

async function setupHarness() {
	const unregisterActive = vi.fn();
	const registerActive = vi.fn();
	const disposeMonitor = vi.fn();

	let toolDef: any;
	let launchedCommand: string | undefined;

	vi.resetModules();
	vi.doMock("@mariozechner/pi-coding-agent", () => ({
		getAgentDir: () => "/tmp/pi-agent",
	}));
	vi.doMock("@mariozechner/pi-tui", () => ({
		isKeyRelease: () => false,
		isKeyRepeat: () => false,
		matchesKey: () => false,
		truncateToWidth: (value: string) => value,
		visibleWidth: (value: string) => value.length,
	}));
	vi.doMock("../config.js", async () => {
		const actual = await vi.importActual<typeof import("../config.js")>("../config.js");
		return {
			...actual,
			loadConfig: vi.fn(() => ({
				focusShortcut: "alt+shift+f",
				spawn: {
					defaultAgent: "pi",
					shortcut: "alt+shift+p",
					commands: { pi: "pi", codex: "codex", claude: "claude", cursor: "agent" },
					defaultArgs: { pi: [], codex: [], claude: [], cursor: [] },
					worktree: false,
					worktreeBaseDir: undefined,
				},
				kitty: {
					version: [0, 47, 4],
					responseTimeoutMs: 5000,
					pollIntervalMs: 500,
					osWindowTitle: "Pi Interactive Kitty",
					tabTitlePrefix: "pi-shell",
					focusNewSessions: true,
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
			})),
		};
	});
	vi.doMock("../kitty-session.js", () => ({
		KittyTerminalSession: class MockKittyTerminalSession {
			ready = Promise.resolve();
			exited = false;
			exitCode = null;
			signal = undefined;
			constructor(options: { command: string }) {
				launchedCommand = options.command;
			}
			setEventHandlers() {}
			addDataListener() {
				return () => {};
			}
			addExitListener() {
				return () => {};
			}
			write() {}
			kill() {}
			focus() {}
			getTailLines() {
				return Promise.resolve({ lines: [], totalLinesInBuffer: 0, truncatedByChars: false });
			}
			getRawStream() {
				return "";
			}
			getLogSlice() {
				return Promise.resolve({ slice: "", totalLines: 0, totalChars: 0, sliceLineCount: 0 });
			}
			dispose() {}
		},
	}));
	vi.doMock("../session-manager.js", () => ({
		sessionManager: {
			getActive: vi.fn(() => undefined),
			unregisterActive,
			list: vi.fn(() => []),
			add: vi.fn(() => "bg-session"),
			take: vi.fn(() => undefined),
			get: vi.fn(() => undefined),
			restore: vi.fn(),
			remove: vi.fn(),
			scheduleCleanup: vi.fn(),
			restartAutoCleanup: vi.fn(),
			registerActive,
			killAll: vi.fn(),
			onChange: vi.fn(() => () => {}),
			setActiveUpdateInterval: vi.fn(() => false),
			setActiveQuietThreshold: vi.fn(() => false),
			writeToActive: vi.fn(() => false),
		},
		generateSessionId: vi.fn(() => "start-session"),
	}));
	vi.doMock("../runtime-coordinator.js", () => ({
		InteractiveShellCoordinator: class MockCoordinator {
			markAgentHandledCompletion = vi.fn();
			consumeAgentHandledCompletion = vi.fn(() => false);
			getMonitor = vi.fn(() => ({ disposed: false }));
			replaceBackgroundWidgetCleanup = vi.fn();
			clearBackgroundWidget = vi.fn();
			disposeAllMonitors = vi.fn();
			disposeMonitor = disposeMonitor;
			deleteMonitor = vi.fn();
			setMonitor = vi.fn();
		},
	}));

	const extensionModule = await import("../index.js");
	extensionModule.default({
		registerShortcut: vi.fn(),
		registerCommand: vi.fn(),
		registerTool: vi.fn((definition: any) => {
			toolDef = definition;
		}),
		on: vi.fn(),
		events: { emit: vi.fn() },
		sendMessage: vi.fn(),
	} as any);

	return { toolDef, unregisterActive, registerActive, disposeMonitor, getLaunchedCommand: () => launchedCommand };
}

describe("dispatch background recovery", () => {
	afterEach(() => {
		vi.doUnmock("@mariozechner/pi-coding-agent");
		vi.doUnmock("@mariozechner/pi-tui");
		vi.doUnmock("../config.js");
		vi.doUnmock("../kitty-session.js");
		vi.doUnmock("../session-manager.js");
		vi.doUnmock("../runtime-coordinator.js");
	});

	it("starts dispatch sessions through the kitty backend", async () => {
		const { toolDef, registerActive, getLaunchedCommand } = await setupHarness();
		expect(toolDef).toBeDefined();

		const result = await toolDef.execute("call-1", { command: "pi", mode: "dispatch" }, undefined, undefined, {
			hasUI: true,
			cwd: "/tmp/project",
			sessionManager: { getSessionFile: () => "/tmp/project/session.jsonl" },
			ui: {},
		} as any);

		expect(result.isError).not.toBe(true);
		expect(result.details.sessionId).toBe("start-session");
		expect(getLaunchedCommand()).toBe("pi");
		expect(registerActive).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "start-session",
				command: "pi",
			}),
		);
	});
});
