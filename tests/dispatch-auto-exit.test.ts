import { afterEach, describe, expect, it, vi } from "vitest";

type OverlayOptions = { autoExitOnQuiet?: boolean };
type MonitorOptions = { autoExitOnQuiet: boolean };

async function setupHarness() {
	let toolDef: any;
	let nextId = 0;
	let nextOverlayResult: Promise<any> = new Promise(() => {});
	const overlayOptions: OverlayOptions[] = [];
	const monitorOptions: MonitorOptions[] = [];
	const backgroundSession = {
		id: "background-session",
		command: "pi",
		session: { exited: false, setEventHandlers: vi.fn() },
		startedAt: new Date(),
	};
	const attachedSession = {
		id: "attached-session",
		command: "pi",
		session: { exited: false, setEventHandlers: vi.fn() },
		startedAt: new Date(),
	};

	vi.resetModules();
	vi.doMock("@earendil-works/pi-coding-agent", () => ({ getAgentDir: () => "/tmp/pi-agent" }));
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
				overlayAnchor: "center",
				focusShortcut: "alt+shift+f",
				spawn: { defaultAgent: "pi", shortcut: "alt+shift+p", commands: { pi: "pi" }, defaultArgs: { pi: [] }, worktree: false },
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
		InteractiveShellOverlay: class MockInteractiveShellOverlay {
			constructor(_tui: unknown, _theme: unknown, options: OverlayOptions) {
				overlayOptions.push(options);
			}
		},
	}));
	vi.doMock("../reattach-overlay.ts", () => ({ ReattachOverlay: class MockReattachOverlay {} }));
	vi.doMock("../pty-session.ts", () => ({
		PtyTerminalSession: class MockPtyTerminalSession {
			exited = false;
			exitCode: number | null = null;
			signal: number | undefined;
			addDataListener() { return () => {}; }
			addExitListener() { return () => {}; }
			getTailLines() { return { lines: [], totalLinesInBuffer: 0, truncatedByChars: false }; }
			getRawStream() { return ""; }
			kill() {}
			setEventHandlers() {}
		}
	}));
	vi.doMock("../headless-monitor.ts", () => ({
		HeadlessDispatchMonitor: class MockHeadlessDispatchMonitor {
			disposed = false;
			constructor(_session: unknown, _config: unknown, options: MonitorOptions) {
				monitorOptions.push(options);
			}
			getResult() { return undefined; }
			registerCompleteCallback() {}
			dispose() { this.disposed = true; }
		},
	}));
	vi.doMock("../session-manager.ts", () => ({
		sessionManager: {
			getActive: vi.fn(() => undefined),
			unregisterActive: vi.fn(),
			registerActive: vi.fn(),
			list: vi.fn(() => []),
			add: vi.fn(),
			take: vi.fn((id: string) => id === attachedSession.id ? attachedSession : undefined),
			get: vi.fn((id: string) => id === backgroundSession.id ? backgroundSession : undefined),
			restore: vi.fn(),
			remove: vi.fn(),
			scheduleCleanup: vi.fn(),
			restartAutoCleanup: vi.fn(),
			killAll: vi.fn(),
			onChange: vi.fn(() => () => {}),
			setActiveUpdateInterval: vi.fn(() => false),
			setActiveQuietThreshold: vi.fn(() => false),
			writeToActive: vi.fn(() => false),
		},
		generateSessionId: vi.fn(() => `session-${++nextId}`),
	}));
	vi.doMock("../runtime-coordinator.ts", () => ({
		InteractiveShellCoordinator: class MockCoordinator {
			markAgentHandledCompletion = vi.fn();
			consumeAgentHandledCompletion = vi.fn(() => false);
			getMonitor = vi.fn(() => undefined);
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
			disposeMonitor = vi.fn();
			deleteMonitor = vi.fn();
			setMonitor = vi.fn();
			registerMonitorSession = vi.fn();
		},
	}));

	const extensionModule = await import("../index.ts");
	extensionModule.default({
		registerShortcut: vi.fn(),
		registerCommand: vi.fn(),
		registerTool: vi.fn((definition: any) => { toolDef = definition; }),
		on: vi.fn(),
		events: { emit: vi.fn() },
		sendMessage: vi.fn(),
	} as any);

	const context = {
		hasUI: true,
		cwd: "/tmp/project",
		ui: {
			custom: vi.fn((_factory: (tui: unknown, theme: unknown, kb: unknown, done: unknown) => unknown) => {
				_factory({}, {}, {}, () => {});
				return nextOverlayResult;
			}),
		},
		sessionManager: { getSessionFile: () => "/tmp/project/session.jsonl" },
	} as any;

	return {
		toolDef,
		context,
		overlayOptions,
		monitorOptions,
		setOverlayResult: (result: Promise<any>) => { nextOverlayResult = result; },
		backgroundSession,
	};
}

describe("dispatch quiet auto-exit", () => {
	afterEach(() => {
		vi.doUnmock("@earendil-works/pi-coding-agent");
		vi.doUnmock("@earendil-works/pi-tui");
		vi.doUnmock("../config.ts");
		vi.doUnmock("../overlay-component.ts");
		vi.doUnmock("../reattach-overlay.ts");
		vi.doUnmock("../pty-session.ts");
		vi.doUnmock("../headless-monitor.ts");
		vi.doUnmock("../session-manager.ts");
		vi.doUnmock("../runtime-coordinator.ts");
	});

	it("waits for exit by default across monitor, headless, foreground, reattach, and handoff paths", async () => {
		const harness = await setupHarness();

		await harness.toolDef.execute("monitor", {
			command: "tail -f log",
			mode: "monitor",
			monitor: { strategy: "stream", triggers: [{ id: "error", literal: "ERROR" }] },
		}, undefined, undefined, { ...harness.context, hasUI: false });
		await harness.toolDef.execute("headless", { command: "pi", mode: "dispatch", background: true }, undefined, undefined, harness.context);
		expect(harness.monitorOptions.map((options) => options.autoExitOnQuiet)).toEqual([false, false]);

		await harness.toolDef.execute("foreground", { command: "pi", mode: "dispatch" }, undefined, undefined, harness.context);
		await harness.toolDef.execute("reattach", { attach: "attached-session", mode: "dispatch" }, undefined, undefined, harness.context);
		expect(harness.overlayOptions.map((options) => options.autoExitOnQuiet)).toEqual([false, false]);

		harness.setOverlayResult(Promise.resolve({ backgrounded: true, backgroundId: harness.backgroundSession.id, cancelled: false, exitCode: null }));
		await harness.toolDef.execute("handoff", { command: "pi", mode: "dispatch" }, undefined, undefined, harness.context);
		await Promise.resolve();
		await Promise.resolve();
		expect(harness.monitorOptions.at(-1)?.autoExitOnQuiet).toBe(false);
	});

	it("enables quiet auto-exit only when explicitly requested", async () => {
		const harness = await setupHarness();
		await harness.toolDef.execute("headless", {
			command: "pi",
			mode: "dispatch",
			background: true,
			handsFree: { autoExitOnQuiet: true },
		}, undefined, undefined, harness.context);

		expect(harness.monitorOptions).toHaveLength(1);
		expect(harness.monitorOptions[0]?.autoExitOnQuiet).toBe(true);
	});
});
