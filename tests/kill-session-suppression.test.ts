import { afterEach, describe, expect, it, vi } from "vitest";

type SetupOptions = {
	sessionResult?: { exitCode: number | null };
	activeSession?: Record<string, unknown>;
};

async function setupKillHarness(options: SetupOptions = {}) {
	const kill = vi.fn();
	const dispose = vi.fn();
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
		dispose,
		...options.activeSession,
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
	vi.doMock("@earendil-works/pi-coding-agent", () => ({
		getAgentDir: () => "/tmp/pi-agent",
	}));
	vi.doMock("@earendil-works/pi-tui", () => ({
		matchesKey: () => false,
		truncateToWidth: (value: string) => value,
		visibleWidth: (value: string) => value.length,
	}));
	vi.doMock("../overlay-component.ts", () => ({
		InteractiveShellOverlay: class MockInteractiveShellOverlay {},
	}));
	vi.doMock("../reattach-overlay.ts", () => ({
		ReattachOverlay: class MockReattachOverlay {},
	}));
	vi.doMock("../session-manager.ts", () => ({
		sessionManager,
		generateSessionId: () => "mock-session-id",
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
			disposeMonitor = vi.fn();
			deleteMonitor = vi.fn();
			setMonitor = vi.fn();
			constructor() {
				coordinatorInstance = this;
			}
		},
	}));

	const extensionModule = await import("../index.ts");
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

	return { result, kill, dispose, unregisterActive, coordinatorInstance };
}

describe("session kill completion suppression", () => {
	afterEach(() => {
		vi.doUnmock("@earendil-works/pi-coding-agent");
		vi.doUnmock("@earendil-works/pi-tui");
		vi.doUnmock("../overlay-component.ts");
		vi.doUnmock("../reattach-overlay.ts");
		vi.doUnmock("../runtime-coordinator.ts");
		vi.doUnmock("../session-manager.ts");
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

	it.runIf(process.platform !== "win32")("reports local cancellation truthfully when process-group signaling fails", async () => {
		const { PtyTerminalSession } = await import("../pty-session.ts");
		const session = new PtyTerminalSession({
			command: "trap '' TERM; while :; do sleep 1; done",
			shellConfig: { shell: "/bin/bash", args: ["-c"] },
		});
		const originalKill = process.kill.bind(process);
		const failure = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
		const groupKill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
			if (pid < 0) throw failure;
			return originalKill(pid, signal);
		});
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			const { result, unregisterActive } = await setupKillHarness({
				activeSession: {
					kill: () => session.kill(),
					dispose: () => session.dispose(),
				},
			});

			expect(result.isError).not.toBe(true);
			expect(result.content[0].text).toBe("Session mock-session-id cancelled. Termination was attempted; subprocess exit is not confirmed.");
			expect(result.details.status).toBe("killed");
			expect(unregisterActive).toHaveBeenCalledWith("mock-session-id", true);
			expect(errorLog).toHaveBeenCalledWith("interactive-shell: failed to signal PTY with SIGTERM:", failure);
		} finally {
			groupKill.mockRestore();
			errorLog.mockRestore();
			session.dispose();
		}
	});

});
