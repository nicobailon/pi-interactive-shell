import { afterEach, describe, expect, it, vi } from "vitest";

async function setupHarness() {
	const unregisterActive = vi.fn();
	const get = vi.fn(() => undefined);
	const disposeMonitor = vi.fn();
	const deleteMonitor = vi.fn();

	let coordinatorInstance: any;
	let toolDef: any;

	vi.resetModules();
	vi.doMock("@earendil-works/pi-coding-agent", () => ({
		getAgentDir: () => "/tmp/pi-agent",
	}));
	vi.doMock("@earendil-works/pi-tui", () => ({
		isKeyRelease: () => false,
		isKeyRepeat: () => false,
		matchesKey: () => false,
		truncateToWidth: (value: string) => value,
		visibleWidth: (value: string) => value.length,
	}));
	vi.doMock("../config.ts", async () => {
		const actual = await vi.importActual<typeof import("../config.ts")>("../config.ts");
		return {
			...actual,
			loadConfig: vi.fn(() => ({
				exitAutoCloseDelay: 10,
				overlayWidthPercent: 95,
				overlayHeightPercent: 60,
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
			})),
		};
	});
	vi.doMock("../overlay-component.ts", () => ({
		InteractiveShellOverlay: class MockInteractiveShellOverlay {},
	}));
	vi.doMock("../reattach-overlay.ts", () => ({
		ReattachOverlay: class MockReattachOverlay {},
	}));
	vi.doMock("../session-manager.ts", () => ({
		sessionManager: {
			getActive: vi.fn(() => undefined),
			unregisterActive,
			list: vi.fn(() => []),
			add: vi.fn(() => "bg-session"),
			take: vi.fn(() => undefined),
			get,
			restore: vi.fn(),
			remove: vi.fn(),
			scheduleCleanup: vi.fn(),
			restartAutoCleanup: vi.fn(),
			registerActive: vi.fn(),
			killAll: vi.fn(),
			onChange: vi.fn(() => () => {}),
			setActiveUpdateInterval: vi.fn(() => false),
			setActiveQuietThreshold: vi.fn(() => false),
			writeToActive: vi.fn(() => false),
		},
		generateSessionId: vi.fn(() => "start-session"),
	}));
	vi.doMock("../runtime-coordinator.ts", () => ({
		InteractiveShellCoordinator: class MockCoordinator {
			markAgentHandledCompletion = vi.fn();
			consumeAgentHandledCompletion = vi.fn(() => false);
			getMonitor = vi.fn(() => ({ disposed: false }));
			focusOverlay = vi.fn();
			unfocusOverlay = vi.fn();
			setOverlayHandle = vi.fn();
			clearOverlayHandle = vi.fn();
			isOverlayOpen = vi.fn(() => false);
			beginOverlay = vi.fn(() => true);
			endOverlay = vi.fn();
			replaceBackgroundWidgetCleanup = vi.fn();
			clearBackgroundWidget = vi.fn();
			disposeAllMonitors = vi.fn();
			disposeMonitor = disposeMonitor;
			deleteMonitor = deleteMonitor;
			setMonitor = vi.fn();
			constructor() {
				coordinatorInstance = this;
			}
		},
	}));

	const extensionModule = await import("../index.ts");
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

	return { toolDef, unregisterActive, get, disposeMonitor, deleteMonitor, coordinatorInstance };
}

describe("dispatch background recovery", () => {
	afterEach(() => {
		vi.doUnmock("@earendil-works/pi-coding-agent");
		vi.doUnmock("@earendil-works/pi-tui");
		vi.doUnmock("../config.ts");
		vi.doUnmock("../overlay-component.ts");
		vi.doUnmock("../reattach-overlay.ts");
		vi.doUnmock("../session-manager.ts");
		vi.doUnmock("../runtime-coordinator.ts");
	});

	it("releases the source session and disposes monitor when background session lookup fails", async () => {
		const { toolDef, unregisterActive, get, disposeMonitor, deleteMonitor } = await setupHarness();
		expect(toolDef).toBeDefined();

		const executePromise = toolDef.execute(
			"call-1",
			{ command: "pi", mode: "dispatch" },
			undefined,
			undefined,
			{
				hasUI: true,
				cwd: "/tmp/project",
				sessionManager: { getSessionFile: () => "/tmp/project/session.jsonl" },
				ui: {
					custom: vi.fn(async () => ({
						exitCode: null,
						signal: undefined,
						backgrounded: true,
						backgroundId: "bg-session",
						cancelled: false,
					})),
				},
			} as any,
		);

		await executePromise;
		await Promise.resolve();
		await Promise.resolve();

		expect(get).toHaveBeenCalledWith("bg-session");
		expect(unregisterActive).toHaveBeenCalledWith("start-session", true);
		expect(disposeMonitor).toHaveBeenCalledWith("start-session");
		expect(deleteMonitor).not.toHaveBeenCalled();
	});
});
