import { afterEach, describe, expect, it, vi } from "vitest";

type Harness = {
	sessionStart: (event: unknown, ctx: any) => void;
	sessionShutdown: () => void;
	onTerminalInput: (data: string) => { consume?: boolean; data?: string } | undefined;
	notify: ReturnType<typeof vi.fn>;
	coordinatorInstance: any;
	terminalInputUnsubscribe: ReturnType<typeof vi.fn>;
};

async function setupHarness(): Promise<Harness> {
	let coordinatorInstance: any;
	let inputHandler: ((data: string) => { consume?: boolean; data?: string } | undefined) | undefined;
	const terminalInputUnsubscribe = vi.fn();
	const notify = vi.fn();

	vi.resetModules();
	vi.doMock("@earendil-works/pi-coding-agent", () => ({
		getAgentDir: () => "/tmp/pi-agent",
	}));
	vi.doMock("@earendil-works/pi-tui", () => ({
		isKeyRelease: (data: string) => data === "RELEASE",
		isKeyRepeat: (data: string) => data === "REPEAT",
		matchesKey: (data: string, key: string) => {
			if (data === "FOCUS") return key === "alt+shift+f";
			if (data === "SIDE") return key === "alt+/";
			return false;
		},
		truncateToWidth: (value: string) => value,
		visibleWidth: (value: string) => value.length,
	}));
	vi.doMock("../overlay-component.ts", () => ({
		InteractiveShellOverlay: class MockInteractiveShellOverlay {},
	}));
	vi.doMock("../reattach-overlay.ts", () => ({
		ReattachOverlay: class MockReattachOverlay {},
	}));
	vi.doMock("../pty-session.ts", () => ({
		PtyTerminalSession: class MockPtyTerminalSession {},
	}));
	vi.doMock("../headless-monitor.ts", () => ({
		HeadlessDispatchMonitor: class MockHeadlessDispatchMonitor {},
	}));
	vi.doMock("../background-widget.ts", () => ({
		setupBackgroundWidget: vi.fn(() => vi.fn()),
	}));
	vi.doMock("../session-manager.ts", () => ({
		sessionManager: {
			killAll: vi.fn(),
			onChange: vi.fn(() => () => {}),
			restartAutoCleanup: vi.fn(),
			registerActive: vi.fn(),
			unregisterActive: vi.fn(),
			add: vi.fn(() => "id"),
			getActive: vi.fn(() => undefined),
			setActiveUpdateInterval: vi.fn(() => false),
			setActiveQuietThreshold: vi.fn(() => false),
			writeToActive: vi.fn(() => false),
			list: vi.fn(() => []),
			get: vi.fn(() => undefined),
			take: vi.fn(() => undefined),
			restore: vi.fn(),
			remove: vi.fn(),
			scheduleCleanup: vi.fn(),
		},
		generateSessionId: vi.fn(() => "id"),
	}));
	vi.doMock("../runtime-coordinator.ts", () => ({
		InteractiveShellCoordinator: class MockCoordinator {
			overlayOpen = false;
			overlayFocused = false;
			focusOverlay = vi.fn(() => {
				this.overlayFocused = true;
			});
			unfocusOverlay = vi.fn(() => {
				this.overlayFocused = false;
			});
			isOverlayOpen = vi.fn(() => this.overlayOpen);
			isOverlayFocused = vi.fn(() => this.overlayFocused);
			replaceBackgroundWidgetCleanup = vi.fn();
			clearBackgroundWidget = vi.fn();
			disposeAllMonitors = vi.fn();
			consumeAgentHandledCompletion = vi.fn(() => false);
			deleteMonitor = vi.fn();
			disposeMonitor = vi.fn();
			setMonitor = vi.fn();
			getMonitor = vi.fn(() => undefined);
			markAgentHandledCompletion = vi.fn();
			beginOverlay = vi.fn(() => true);
			endOverlay = vi.fn();
			setOverlayHandle = vi.fn();
			clearOverlayHandle = vi.fn();
			constructor() {
				coordinatorInstance = this;
			}
		},
	}));

	const extensionModule = await import("../index.ts");
	const extension = extensionModule.default;

	const handlers = new Map<string, any>();
	const pi = {
		registerShortcut: vi.fn(),
		registerCommand: vi.fn(),
		registerTool: vi.fn(),
		on: vi.fn((event: string, handler: any) => {
			handlers.set(event, handler);
		}),
		events: { emit: vi.fn() },
		sendMessage: vi.fn(),
	};
		
	extension(pi as any);

	const sessionStart = handlers.get("session_start");
	const sessionShutdown = handlers.get("session_shutdown");
	expect(sessionStart).toBeDefined();
	expect(sessionShutdown).toBeDefined();

	sessionStart({}, {
		ui: {
			notify,
			onTerminalInput: vi.fn((handler: any) => {
				inputHandler = handler;
				return terminalInputUnsubscribe;
			}),
		},
	} as any);

	expect(inputHandler).toBeDefined();

	return {
		sessionStart,
		sessionShutdown,
		onTerminalInput: inputHandler!,
		notify,
		coordinatorInstance,
		terminalInputUnsubscribe,
	};
}

describe("overlay focus and side-chat guards", () => {
	afterEach(() => {
		vi.doUnmock("@earendil-works/pi-coding-agent");
		vi.doUnmock("@earendil-works/pi-tui");
		vi.doUnmock("../overlay-component.ts");
		vi.doUnmock("../reattach-overlay.ts");
		vi.doUnmock("../pty-session.ts");
		vi.doUnmock("../headless-monitor.ts");
		vi.doUnmock("../background-widget.ts");
		vi.doUnmock("../session-manager.ts");
		vi.doUnmock("../runtime-coordinator.ts");
	});

	it("toggles overlay focus globally while the overlay is open", async () => {
		const { onTerminalInput, coordinatorInstance, notify } = await setupHarness();
		coordinatorInstance.overlayOpen = true;
		coordinatorInstance.overlayFocused = false;

		expect(onTerminalInput("FOCUS")).toEqual({ consume: true });
		expect(coordinatorInstance.focusOverlay).toHaveBeenCalledTimes(1);
		expect(coordinatorInstance.unfocusOverlay).not.toHaveBeenCalled();

		coordinatorInstance.overlayFocused = true;
		expect(onTerminalInput("FOCUS")).toEqual({ consume: true });
		expect(coordinatorInstance.unfocusOverlay).toHaveBeenCalledTimes(1);
		expect(notify).not.toHaveBeenCalled();
	});

	it("ignores key release and repeat events while the overlay is open", async () => {
		const { onTerminalInput, coordinatorInstance, notify } = await setupHarness();
		coordinatorInstance.overlayOpen = true;
		coordinatorInstance.overlayFocused = false;

		expect(onTerminalInput("RELEASE")).toBeUndefined();
		expect(onTerminalInput("REPEAT")).toBeUndefined();
		expect(coordinatorInstance.focusOverlay).not.toHaveBeenCalled();
		expect(coordinatorInstance.unfocusOverlay).not.toHaveBeenCalled();
		expect(notify).not.toHaveBeenCalled();
	});

	it("blocks the side-chat shortcut while the overlay is open", async () => {
		const { onTerminalInput, coordinatorInstance, notify } = await setupHarness();
		coordinatorInstance.overlayOpen = true;

		expect(onTerminalInput("SIDE")).toEqual({ consume: true });
		expect(notify).toHaveBeenCalledWith("Close pi-interactive-shell first.", "warning");
	});

	it("does not intercept shortcuts when the overlay is closed", async () => {
		const { onTerminalInput, coordinatorInstance, notify } = await setupHarness();
		coordinatorInstance.overlayOpen = false;

		expect(onTerminalInput("FOCUS")).toBeUndefined();
		expect(onTerminalInput("SIDE")).toBeUndefined();
		expect(notify).not.toHaveBeenCalled();
	});
});
