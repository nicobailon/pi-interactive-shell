import { afterEach, describe, expect, it, vi } from "vitest";

type SetupOptions = {
	sessionResult?: { exitCode: number | null };
};

async function setupKillHarness(options: SetupOptions = {}) {
	const kill = vi.fn();
	const unregisterActive = vi.fn();
	const activeSession = {
		getResult: vi.fn(() => options.sessionResult),
		getOutput: vi.fn(() => ({
			output: "",
			truncated: false,
			totalBytes: 0,
			totalLines: 0,
			hasMore: false,
		})),
		getStatus: vi.fn(() => "running"),
		getRuntime: vi.fn(() => 1000),
		kill,
	};

	const sessionManager = {
		getActive: vi.fn(() => activeSession),
		unregisterActive,
		list: vi.fn(() => []),
		add: vi.fn(() => "id"),
		take: vi.fn(() => undefined),
		get: vi.fn(() => undefined),
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
	};

	let coordinatorInstance: any;
	vi.resetModules();
	vi.doMock("@mariozechner/pi-coding-agent", () => ({
		getAgentDir: () => "/tmp/pi-agent",
	}));
	vi.doMock("@mariozechner/pi-tui", () => ({
		matchesKey: () => false,
		truncateToWidth: (value: string) => value,
		visibleWidth: (value: string) => value.length,
	}));
	vi.doMock("../session-manager.js", () => ({
		sessionManager,
		generateSessionId: () => "mock-session-id",
	}));
	vi.doMock("../runtime-coordinator.js", () => ({
		InteractiveShellCoordinator: class MockCoordinator {
			markAgentHandledCompletion = vi.fn();
			consumeAgentHandledCompletion = vi.fn(() => false);
			getMonitor = vi.fn(() => ({ disposed: false }));
			replaceBackgroundWidgetCleanup = vi.fn();
			clearBackgroundWidget = vi.fn();
			disposeAllMonitors = vi.fn();
			disposeMonitor = vi.fn();
			deleteMonitor = vi.fn();
			setMonitor = vi.fn();
			constructor() {
				coordinatorInstance = this;
			}
		},
	}));

	const extensionModule = await import("../index.js");
	const extension = extensionModule.default;

	let toolDef: any;
	const pi = {
		registerShortcut: vi.fn(),
		registerCommand: vi.fn(),
		registerTool: vi.fn((definition: any) => {
			toolDef = definition;
		}),
		on: vi.fn(),
		events: { emit: vi.fn() },
		sendMessage: vi.fn(),
	};
	extension(pi as any);

	expect(toolDef).toBeDefined();
	const result = await toolDef.execute("tc", { sessionId: "mock-session-id", kill: true }, undefined, undefined, {
		hasUI: false,
		cwd: "/tmp/project",
		ui: {},
	} as any);

	return { result, kill, unregisterActive, coordinatorInstance };
}

describe("session kill completion suppression", () => {
	afterEach(() => {
		vi.doUnmock("@mariozechner/pi-coding-agent");
		vi.doUnmock("@mariozechner/pi-tui");
		vi.doUnmock("../runtime-coordinator.js");
		vi.doUnmock("../session-manager.js");
	});

	it("marks kill as agent-handled when the session has not completed yet", async () => {
		const { result, kill, unregisterActive, coordinatorInstance } = await setupKillHarness({
			sessionResult: undefined,
		});

		expect(result.isError).not.toBe(true);
		expect(kill).toHaveBeenCalledTimes(1);
		expect(unregisterActive).toHaveBeenCalledWith("mock-session-id", true);
		expect(coordinatorInstance.markAgentHandledCompletion).toHaveBeenCalledWith("mock-session-id");
	});

	it("does not mark agent-handled for sessions that are already completed", async () => {
		const { result, coordinatorInstance } = await setupKillHarness({
			sessionResult: { exitCode: 0 },
		});

		expect(result.isError).not.toBe(true);
		expect(coordinatorInstance.markAgentHandledCompletion).not.toHaveBeenCalled();
	});
});
