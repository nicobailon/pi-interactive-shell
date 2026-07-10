import { afterEach, describe, expect, it, vi } from "vitest";

type Harness = {
	sessionStart: (event: unknown, ctx: any) => void;
	sessionShutdown: () => void;
	notify: ReturnType<typeof vi.fn>;
	focusShortcut: { handler: () => void } | undefined;
	backgroundSession: { session: { focus: ReturnType<typeof vi.fn> } };
};

async function setupHarness(): Promise<Harness> {
	const notify = vi.fn();
	let focusShortcut: { handler: () => void } | undefined;
	const backgroundSession = { session: { focus: vi.fn() } };

	vi.resetModules();
	vi.doMock("@mariozechner/pi-coding-agent", () => ({
		getAgentDir: () => "/tmp/pi-agent",
	}));
	vi.doMock("../headless-monitor.js", () => ({
		HeadlessDispatchMonitor: class MockHeadlessDispatchMonitor {},
	}));
	vi.doMock("../background-widget.js", () => ({
		setupBackgroundWidget: vi.fn(() => vi.fn()),
	}));
	vi.doMock("../session-manager.js", () => ({
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
			list: vi.fn(() => [backgroundSession]),
			get: vi.fn(() => undefined),
			take: vi.fn(() => undefined),
			restore: vi.fn(),
			remove: vi.fn(),
			scheduleCleanup: vi.fn(),
		},
		generateSessionId: vi.fn(() => "id"),
	}));
	vi.doMock("../runtime-coordinator.js", () => ({
		InteractiveShellCoordinator: class MockCoordinator {
			replaceBackgroundWidgetCleanup = vi.fn();
			clearBackgroundWidget = vi.fn();
			disposeAllMonitors = vi.fn();
			consumeAgentHandledCompletion = vi.fn(() => false);
			deleteMonitor = vi.fn();
			disposeMonitor = vi.fn();
			setMonitor = vi.fn();
			getMonitor = vi.fn(() => undefined);
			markAgentHandledCompletion = vi.fn();
		},
	}));

	const extensionModule = await import("../index.js");
	const extension = extensionModule.default;

	const handlers = new Map<string, any>();
	const pi = {
		registerShortcut: vi.fn((shortcut: string, options: { handler: () => void }) => {
			if (shortcut === "alt+shift+f") focusShortcut = options;
		}),
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
		},
	} as any);

	return {
		sessionStart,
		sessionShutdown,
		notify,
		focusShortcut,
		backgroundSession,
	};
}

describe("kitty session shortcut handling", () => {
	afterEach(() => {
		vi.doUnmock("@mariozechner/pi-coding-agent");
		vi.doUnmock("../headless-monitor.js");
		vi.doUnmock("../background-widget.js");
		vi.doUnmock("../session-manager.js");
		vi.doUnmock("../runtime-coordinator.js");
	});

	it("focus shortcut focuses the latest managed kitty session", async () => {
		const { focusShortcut, backgroundSession, notify } = await setupHarness();
		expect(focusShortcut).toBeDefined();
		focusShortcut!.handler();
		expect(backgroundSession.session.focus).toHaveBeenCalledTimes(1);
		expect(notify).not.toHaveBeenCalled();
	});
});
