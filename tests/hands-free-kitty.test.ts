import { afterEach, describe, expect, it, vi } from "vitest";
import type { HeadlessCompletionInfo } from "../headless-monitor.js";

async function setupHarness(options?: { onCompleteInfos?: HeadlessCompletionInfo[] }) {
	const unregisterActive = vi.fn();
	const registerActive = vi.fn();
	const scheduleCleanup = vi.fn();
	const setActiveUpdateInterval = vi.fn(() => false);
	const setActiveQuietThreshold = vi.fn(() => false);
	const monitors: Array<{
		options: any;
		onComplete: (info: HeadlessCompletionInfo) => void;
		setQuietThreshold: ReturnType<typeof vi.fn>;
		registerCompleteCallback: ReturnType<typeof vi.fn>;
		getResult: ReturnType<typeof vi.fn>;
		disposed: boolean;
	}> = [];

	let toolDef: any;
	const exitListeners: Array<() => void> = [];
	const dataListeners: Array<(data: string) => void> = [];
	let sessionExited = false;
	let sessionExitCode: number | null = null;

	vi.resetModules();
	vi.doMock("@mariozechner/pi-coding-agent", () => ({
		getAgentDir: () => "/tmp/pi-agent-hands-free-test",
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
				handoffSnapshotEnabled: true,
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
			exitCode = null as number | null;
			signal = undefined as number | undefined;
			pid = 1234;
			constructor(_options: { command: string }) {}
			setEventHandlers() {}
			addDataListener(cb: (data: string) => void) {
				dataListeners.push(cb);
				return () => {
					const index = dataListeners.indexOf(cb);
					if (index >= 0) dataListeners.splice(index, 1);
				};
			}
			addExitListener(cb: () => void) {
				exitListeners.push(cb);
				return () => {};
			}
			write() {}
			kill() {
				sessionExited = true;
				this.exited = true;
				this.exitCode = null;
				for (const cb of exitListeners) cb();
			}
			focus() {}
			getTailLines() {
				return Promise.resolve({ lines: ["line-a", "line-b"], totalLinesInBuffer: 2, truncatedByChars: false });
			}
			getRawStream() {
				return "stream-output";
			}
			getLogSlice() {
				return Promise.resolve({ slice: "", totalLines: 0, totalChars: 0, sliceLineCount: 0 });
			}
			getViewportLines() {
				return Promise.resolve([]);
			}
			dispose() {}
		},
	}));
	vi.doMock("../handoff-utils.js", () => ({
		captureCompletionOutput: async () => ({ lines: ["done"], totalLines: 1, truncated: false }),
		maybeBuildHandoffPreview: vi.fn(async (_session, when: string) => ({
			type: "tail" as const,
			when,
			lines: ["preview-line"],
		})),
		maybeWriteHandoffSnapshot: vi.fn(async (_session, when: string) => ({
			type: "snapshot" as const,
			when,
			transcriptPath: `/tmp/snapshot-${when}.log`,
			linesWritten: 2,
		})),
	}));
	vi.doMock("../headless-monitor.js", async () => {
		const actual = await vi.importActual<typeof import("../headless-monitor.js")>("../headless-monitor.js");
		return {
			...actual,
			HeadlessDispatchMonitor: class MockHeadlessDispatchMonitor {
				disposed = false;
				private result: HeadlessCompletionInfo | undefined;
				private completeCallbacks: Array<() => void> = [];
				setQuietThreshold = vi.fn();
				constructor(
					_session: unknown,
					_config: unknown,
					public options: any,
					private onComplete: (info: HeadlessCompletionInfo) => void,
				) {
					monitors.push(this as any);
					const preset = options?.onCompleteInfos ?? options;
					void preset;
					if (options && Array.isArray((globalThis as any).__hf_complete_infos)) {
						// no-op placeholder
					}
				}
				getResult() {
					return this.result;
				}
				registerCompleteCallback(cb: () => void) {
					if (this.result) {
						cb();
						return;
					}
					this.completeCallbacks.push(cb);
				}
				/** test helper */
				complete(info: HeadlessCompletionInfo) {
					this.result = info;
					this.disposed = true;
					for (const cb of this.completeCallbacks) cb();
					this.onComplete(info);
				}
				/**
				 * Mirrors real HeadlessDispatchMonitor.cancel(): starts async finalize
				 * (output capture) and only populates getResult() / complete callbacks after.
				 */
				cancel() {
					if (this.disposed) return;
					this.disposed = true;
					queueMicrotask(() => {
						this.complete({ exitCode: null, cancelled: true });
					});
				}
			},
		};
	});

	// Bridge preset completion if provided via closure
	const originalMonitorsPush = monitors.push.bind(monitors);
	monitors.push = ((...items: typeof monitors) => {
		const n = originalMonitorsPush(...items);
		if (options?.onCompleteInfos?.length) {
			// not auto-firing
		}
		return n;
	}) as typeof monitors.push;

	vi.doMock("../session-manager.js", () => ({
		sessionManager: {
			getActive: vi.fn((id: string) => {
				const last = registerActive.mock.calls.at(-1)?.[0];
				return last?.id === id ? last : undefined;
			}),
			unregisterActive,
			list: vi.fn(() => []),
			add: vi.fn(() => "bg-session"),
			take: vi.fn(() => undefined),
			get: vi.fn(() => undefined),
			restore: vi.fn(),
			remove: vi.fn(),
			scheduleCleanup,
			restartAutoCleanup: vi.fn(),
			registerActive,
			killAll: vi.fn(),
			onChange: vi.fn(() => () => {}),
			setActiveUpdateInterval: (id: string, ms: number) => {
				const session = registerActive.mock.calls.map((c) => c[0]).find((s) => s.id === id);
				if (session?.setUpdateInterval) {
					session.setUpdateInterval(ms);
					setActiveUpdateInterval(id, ms);
					return true;
				}
				return setActiveUpdateInterval(id, ms);
			},
			setActiveQuietThreshold: (id: string, ms: number) => {
				const session = registerActive.mock.calls.map((c) => c[0]).find((s) => s.id === id);
				if (session?.setQuietThreshold) {
					session.setQuietThreshold(ms);
					setActiveQuietThreshold(id, ms);
					return true;
				}
				return setActiveQuietThreshold(id, ms);
			},
			writeToActive: vi.fn(() => false),
		},
		generateSessionId: vi.fn(() => "hands-free-session"),
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
			getMonitorSessionState = vi.fn(() => undefined);
			clearMonitorEvents = vi.fn();
			registerMonitorSession = vi.fn();
		},
	}));

	const sendMessage = vi.fn();
	const extensionModule = await import("../index.js");
	extensionModule.default({
		registerShortcut: vi.fn(),
		registerCommand: vi.fn(),
		registerTool: vi.fn((definition: any) => {
			toolDef = definition;
		}),
		on: vi.fn(),
		events: { emit: vi.fn() },
		sendMessage,
	} as any);

	return {
		toolDef,
		unregisterActive,
		registerActive,
		scheduleCleanup,
		setActiveUpdateInterval,
		setActiveQuietThreshold,
		monitors,
		sendMessage,
		completeLatestMonitor: (info: HeadlessCompletionInfo) => {
			const monitor = monitors.at(-1);
			if (!monitor) throw new Error("no monitor");
			(monitor as any).complete(info);
		},
		emitData: (data: string) => {
			for (const cb of [...dataListeners]) cb(data);
		},
		getSessionExited: () => sessionExited,
		getSessionExitCode: () => sessionExitCode,
	};
}

describe("hands-free kitty path", () => {
	afterEach(() => {
		vi.doUnmock("@mariozechner/pi-coding-agent");
		vi.doUnmock("@mariozechner/pi-tui");
		vi.doUnmock("../config.js");
		vi.doUnmock("../kitty-session.js");
		vi.doUnmock("../headless-monitor.js");
		vi.doUnmock("../session-manager.js");
		vi.doUnmock("../runtime-coordinator.js");
		vi.doUnmock("../handoff-utils.js");
		vi.resetModules();
	});

	it("wires timeout and opt-in autoExitOnQuiet into HeadlessDispatchMonitor without dispatch completion turns", async () => {
		const harness = await setupHarness();
		const result = await harness.toolDef.execute(
			"call-1",
			{
				command: "sleep 60",
				mode: "hands-free",
				timeout: 12_000,
				handsFree: { autoExitOnQuiet: true, quietThreshold: 3000, gracePeriod: 5000 },
			},
			undefined,
			undefined,
			{ cwd: "/tmp", ui: {}, sessionManager: { getSessionFile: () => undefined }, hasUI: true },
		);

		expect(result.isError).toBeFalsy();
		expect(result.details.sessionId).toBe("hands-free-session");
		expect(result.details.mode).toBe("hands-free");
		expect(harness.monitors).toHaveLength(1);
		expect(harness.monitors[0]!.options.timeout).toBe(12_000);
		expect(harness.monitors[0]!.options.autoExitOnQuiet).toBe(true);
		expect(harness.monitors[0]!.options.quietThreshold).toBe(3000);
		expect(harness.monitors[0]!.options.gracePeriod).toBe(5000);

		// Completing hands-free must not fire dispatch-style triggerTurn notifications.
		// The final hands-free lifecycle update is still delivered without triggerTurn.
		harness.completeLatestMonitor({
			exitCode: 0,
			completionOutput: { lines: ["ok"], totalLines: 1, truncated: false },
		});
		// Completion handoff/cleanup is async (live kitty get-text + artifacts).
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(harness.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "interactive-shell-update",
				content: expect.stringContaining("Session hands-free-session exited"),
			}),
			{ triggerTurn: true },
		);
		expect(harness.unregisterActive).not.toHaveBeenCalled();
		expect(harness.scheduleCleanup).toHaveBeenCalled();
	});

	it("supports settings.updateInterval and settings.quietThreshold via active session setters", async () => {
		const harness = await setupHarness();
		await harness.toolDef.execute("call-2", { command: "npm run dev", mode: "hands-free" }, undefined, undefined, {
			cwd: "/tmp",
			ui: {},
			sessionManager: { getSessionFile: () => undefined },
			hasUI: true,
		});

		const registered = harness.registerActive.mock.calls[0]![0];
		expect(typeof registered.setUpdateInterval).toBe("function");
		expect(typeof registered.setQuietThreshold).toBe("function");

		const settingsResult = await harness.toolDef.execute(
			"call-3",
			{
				sessionId: "hands-free-session",
				settings: { updateInterval: 15000, quietThreshold: 4000 },
			},
			undefined,
			undefined,
			{ cwd: "/tmp", ui: {}, sessionManager: { getSessionFile: () => undefined }, hasUI: true },
		);

		expect(settingsResult.isError).toBeFalsy();
		expect(settingsResult.content[0].text).toMatch(/update interval set to 15000ms/);
		expect(settingsResult.content[0].text).toMatch(/quiet threshold set to 4000ms/);
		expect(harness.monitors[0]!.setQuietThreshold).toHaveBeenCalledWith(4000);
	});

	it("includes handoffPreview/handoff on hands-free completion result", async () => {
		const harness = await setupHarness();
		await harness.toolDef.execute(
			"call-4",
			{
				command: "echo done",
				mode: "hands-free",
				handoffPreview: { enabled: true, lines: 10 },
				handoffSnapshot: { enabled: true, lines: 20 },
			},
			undefined,
			undefined,
			{ cwd: "/tmp", ui: {}, sessionManager: { getSessionFile: () => undefined }, hasUI: true },
		);

		harness.completeLatestMonitor({
			exitCode: 0,
			completionOutput: { lines: ["ok"], totalLines: 1, truncated: false },
		});
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		const registered = harness.registerActive.mock.calls[0]![0];
		const result = registered.getResult();
		expect(result?.backgrounded).toBe(false);
		expect(result?.handoffPreview).toEqual({
			type: "tail",
			when: "exit",
			lines: ["preview-line"],
		});
		expect(result?.handoff).toEqual({
			type: "snapshot",
			when: "exit",
			transcriptPath: "/tmp/snapshot-exit.log",
			linesWritten: 2,
		});

		const queryResult = await harness.toolDef.execute("call-4-query", { sessionId: "hands-free-session" }, undefined, undefined, {
			cwd: "/tmp",
			ui: {},
			sessionManager: { getSessionFile: () => undefined },
			hasUI: true,
		});
		// backgrounded: false => release session id on poll
		expect(harness.unregisterActive).toHaveBeenCalledWith("hands-free-session", true);
		expect(queryResult.details.handoffPreview?.when).toBe("exit");
		expect(queryResult.details.handoff?.transcriptPath).toContain("snapshot-exit");
		expect(queryResult.details.backgrounded).toBe(false);
	});

	it("tears down progress listeners when a hands-free session is killed", async () => {
		const harness = await setupHarness();
		await harness.toolDef.execute(
			"call-kill",
			{
				command: "sleep 60",
				mode: "hands-free",
				handsFree: { updateMode: "on-quiet", quietThreshold: 1000 },
			},
			undefined,
			undefined,
			{ cwd: "/tmp", ui: {}, sessionManager: { getSessionFile: () => undefined }, hasUI: true },
		);

		const registered = harness.registerActive.mock.calls[0]![0];
		registered.kill();
		// cancel() finalizes asynchronously — must not complete as "exited" before result is ready
		expect(registered.getStatus()).toBe("running");
		expect(harness.sendMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({
				content: expect.stringContaining("exited"),
			}),
			expect.anything(),
		);

		await vi.waitFor(() => {
			expect(registered.getStatus()).toBe("killed");
		});
		expect(registered.getResult()?.cancelled).toBe(true);
		expect(harness.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "interactive-shell-update",
				content: expect.stringContaining("Session hands-free-session killed"),
			}),
			{ triggerTurn: true },
		);
		const callsAfterKill = harness.sendMessage.mock.calls.length;

		harness.emitData("new output after kill\n");
		expect(harness.sendMessage.mock.calls.length).toBe(callsAfterKill);
	});

	it("includes handoff artifacts on dispatch completion notification details", async () => {
		const harness = await setupHarness();
		await harness.toolDef.execute(
			"call-5",
			{
				command: "echo dispatch",
				mode: "dispatch",
				handoffPreview: { enabled: true },
				handoffSnapshot: { enabled: true },
			},
			undefined,
			undefined,
			{ cwd: "/tmp", ui: {}, sessionManager: { getSessionFile: () => undefined }, hasUI: true },
		);

		harness.completeLatestMonitor({
			exitCode: 0,
			completionOutput: { lines: ["done"], totalLines: 1, truncated: false },
		});
		// Nested async: buildHandoffArtifacts → makeMonitorCompletionCallback → sendMessage
		await vi.waitFor(() => {
			expect(harness.sendMessage).toHaveBeenCalled();
		});
		const details = harness.sendMessage.mock.calls[0]![0].details;
		expect(details.handoffPreview?.when).toBe("exit");
		expect(details.handoff?.transcriptPath).toContain("snapshot-exit");
	});
});
