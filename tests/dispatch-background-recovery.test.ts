import { afterEach, describe, expect, it, vi } from "vitest";

async function setupHarness(options: { headlessConstructionError?: string; monitorInstallError?: string; generatedSessionId?: string; onMonitorDispose?: () => void; sourceText?: string; jevEnabled?: boolean; providerEvaluate?: (request: any) => unknown } = {}) {
	Reflect.deleteProperty(globalThis, "__piInteractiveShellCoordinatorV1");
	const unregisterActive = vi.fn();
	let backgroundSession: any;
	let existingMonitor: any;
	const get = vi.fn(() => backgroundSession);
	const disposeMonitor = vi.fn(() => { existingMonitor?.dispose?.(); existingMonitor = undefined; });
	const deleteMonitor = vi.fn();

	let coordinatorInstance: any;
	let toolDef: any;
	let headlessOptions: any;
	let overlayOptions: any;
	let foregroundSession: any;
	let constructedMonitor: any;
	let semanticState: any;
	let monitorState: any;
	let selectionMetadata: any = { goal: "summarize", command: "job", status: "completion=exited; exitCode=0", fallback: "fallback" };
	let semanticHistory: any[] = [];
	let monitorHistory: any[] = [];
	let headlessConstructCount = 0;
	const createJevClient = vi.fn(() => ({ evaluate: vi.fn(async (request) => options.providerEvaluate?.(request)) }));
	const sendMessage = vi.fn();
	const sourceText = options.sourceText ?? "abcdef";

	vi.resetModules();
	vi.doMock("@earendil-works/pi-coding-agent", () => ({
		getAgentDir: () => "/tmp/pi-agent",
		getShellConfig: () => ({ shell: "/bin/bash", args: ["-c"] }),
		SettingsManager: { create: () => ({ getShellPath: () => undefined }) },
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
				jev: { enabled: options.jevEnabled ?? true, model: "jev-1.13.0", requestTimeoutMs: 1000, maxRetries: 0, maxViewportLines: 20, maxRecentChars: 1000, redactionPatterns: [] },
			})),
		};
	});
	vi.doMock("../overlay-component.ts", () => ({
		InteractiveShellOverlay: class MockInteractiveShellOverlay {
			constructor(_tui: unknown, _theme: unknown, overlay: any) {
				overlayOptions = overlay;
				foregroundSession = { kill: vi.fn(), dispose: vi.fn() };
				try { overlay.onSessionReady?.(foregroundSession); }
				catch (error) {
					foregroundSession.kill(); foregroundSession.dispose(); unregisterActive(overlay.sessionId, true);
					throw error;
				}
			}
		},
	}));
	vi.doMock("../jev-client.ts", () => ({ createJevClient }));
	vi.doMock("../headless-monitor.ts", () => ({
		HeadlessDispatchMonitor: class {
			disposed = false;
			activateBackgroundLifecycle = vi.fn();
			pauseSemantic = vi.fn();
			resumeSemantic = vi.fn();
			constructor(_session: unknown, _config: unknown, monitorOptions: any) {
				headlessConstructCount += 1; headlessOptions = monitorOptions;
				if (options.headlessConstructionError) throw new Error(options.headlessConstructionError);
				constructedMonitor = this;
				if (monitorOptions.deferLifecycle && monitorOptions.semantic) monitorOptions.semantic.onDecision({ kind: "skipped", route: "continue", reason: "secret-prompt", model: "jev-1.13.0", observationHash: "hash", generation: 1, latencyMs: 0 });
				if (options.monitorInstallError) monitorHistory.push({ triggerId: "constructor-event" });
			}
			getResult() { return undefined; }
			registerCompleteCallback() {}
			dispose() { options.onMonitorDispose?.(); this.disposed = true; }
			rebindSemanticEpoch() {}
			submitMonitorCandidate() { return true; }
		},
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
			getOutputSourceForSession: vi.fn(() => undefined),
			outputSourceStatus: vi.fn((sourceId) => ({ sourceId, state: "complete", length: sourceText.length, ref: { sourceId, sessionId: "old", representation: "normalized-merged-pty-text-v1" } })),
			readOutputSource: vi.fn(async (sourceId, start, end) => ({ sourceId, state: "complete", length: sourceText.length, ref: { sourceId, sessionId: "old", representation: "normalized-merged-pty-text-v1" }, text: sourceText.slice(start, end), range: { start, end } })),
			getOutputSelectionMetadata: vi.fn(() => selectionMetadata),
			recordOutputCompletion: vi.fn(),
		},
		generateSessionId: vi.fn(() => options.generatedSessionId ?? "start-session"),
	}));
	vi.doMock("../runtime-coordinator.ts", () => ({
		InteractiveShellCoordinator: class MockCoordinator {
			bindExtensionApi = vi.fn();
			unbindExtensionApi = vi.fn();
			runWithExtensionApi = vi.fn((task) => task({ sendMessage: vi.fn(), events: { emit: vi.fn() } }));
			clearPendingApiTasks = vi.fn();
			markAgentHandledCompletion = vi.fn();
			consumeAgentHandledCompletion = vi.fn(() => false);
			consumePendingMonitorReason = vi.fn(() => undefined);
			getMonitor = vi.fn(() => existingMonitor);
			getRuntimeEpoch = vi.fn(() => 1);
			isRuntimeEpochCurrent = vi.fn(() => true);
			reserveSemanticActionAttempt = vi.fn(() => true);
			runOutputSelection = vi.fn((_key, task) => task(new AbortController().signal));
			registerSemanticSession = vi.fn((sessionId) => { semanticState = { sessionId, status: "running" }; });
			registerMonitorSession = vi.fn((sessionId) => { monitorState = { sessionId, status: "running" }; });
			setSemanticSessionStatus = vi.fn((_id, status) => { if (semanticState) semanticState.status = status; });
			getSemanticSessionState = vi.fn(() => semanticState);
			getMonitorSessionState = vi.fn(() => monitorState);
			finalizeMonitorSession = vi.fn((_id, _result, reason) => { if (monitorState) monitorState = { ...monitorState, status: "stopped", terminalReason: reason }; });
			clearMonitorEvents = vi.fn(() => { monitorHistory = []; monitorState = undefined; });
			clearSemanticDecisions = vi.fn(() => { semanticHistory = []; semanticState = undefined; });
			getSemanticDecisions = vi.fn(() => ({ decisions: [...semanticHistory], total: semanticHistory.length, limit: 20, offset: 0 }));
			getMonitorEvents = vi.fn(() => ({ events: [...monitorHistory], total: monitorHistory.length, limit: 20, offset: 0 }));
			recordMonitorEvent = vi.fn((event) => { monitorHistory.push(event); return event; });
			recordSemanticDecision = vi.fn((_id, decision) => {
				const recorded = { ...decision, sessionId: _id, decisionId: semanticHistory.length + 1, timestamp: "now" };
				semanticHistory.push(recorded); return recorded;
			});
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
			deleteMonitor = vi.fn((id) => { deleteMonitor(id); existingMonitor = undefined; });
			setMonitor = vi.fn((_id, monitor) => {
				if (options.monitorInstallError) throw new Error(options.monitorInstallError);
				existingMonitor = monitor;
			});
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
		sendMessage,
	} as any);

	return { toolDef, unregisterActive, get, disposeMonitor, deleteMonitor, coordinatorInstance, createJevClient, sendMessage,
		setBackgroundSession: (value: any) => { backgroundSession = value; }, setExistingMonitor: (value: any) => { existingMonitor = value; },
		getExistingMonitor: () => existingMonitor, getHeadlessOptions: () => headlessOptions, getOverlayOptions: () => overlayOptions,
		getForegroundSession: () => foregroundSession, getConstructedMonitor: () => constructedMonitor, getHeadlessConstructCount: () => headlessConstructCount,
		setSelectionMetadata: (value: any) => { selectionMetadata = value; } };
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
		vi.doUnmock("../jev-client.ts");
		vi.doUnmock("../headless-monitor.ts");
	});

	it("rejects capture consent for unsupported launches before constructing a session", async () => {
		const { toolDef, getHeadlessConstructCount } = await setupHarness();
		const context = { hasUI: false, cwd: "/tmp/project", sessionManager: { getSessionFile: () => undefined }, ui: {} } as any;
		const interactive = await toolDef.execute("capture-invalid-1", {
			command: "printf no", mode: "interactive", outputSelection: { enabled: true, goal: " recover this " },
		}, undefined, undefined, context);
		const empty = await toolDef.execute("capture-invalid-2", {
			command: "printf no", mode: "dispatch", background: true, outputSelection: { enabled: true, goal: "   " },
		}, undefined, undefined, context);
		expect(interactive.isError).toBe(true);
		expect(empty.isError).toBe(true);
		expect(getHeadlessConstructCount()).toBe(0);
	});

	it("routes raw source pagination before active-session lookup", async () => {
		const { toolDef } = await setupHarness();
		const result = await toolDef.execute("source-read", {
			sourceId: "00000000-0000-4000-8000-000000000000", outputView: "raw", sourceOffset: 2, sourceLimit: 3,
		}, undefined, undefined, { cwd: "/tmp/project", sessionManager: { getSessionFile: () => undefined }, ui: {} } as any);
		expect(result.content[0].text).toBe("cde");
		expect(result.details).toMatchObject({ state: "complete", requestedRange: { offset: 2, limit: 3 }, nextOffset: 5 });
	});

	it("returns deterministic short selected output without constructing a provider", async () => {
		const { toolDef, createJevClient } = await setupHarness();
		const result = await toolDef.execute("source-selected", {
			sourceId: "00000000-0000-4000-8000-000000000000", outputView: "selected",
		}, undefined, undefined, { cwd: "/tmp/project", sessionManager: { getSessionFile: () => undefined }, ui: {} } as any);
		expect(createJevClient).not.toHaveBeenCalled();
		expect(result.content[0].text).toBe("abcdef");
		expect(result.details).toMatchObject({ selectionStatus: "unchanged", rawRecovery: { outputView: "raw" } });
	});

	it("returns CR-overwritten safe display while raw view preserves the exact source", async () => {
		const raw = "\x1b[33mprogress 99%\x1b[0m\rprogress 100%";
		const { toolDef, createJevClient } = await setupHarness({ sourceText: raw });
		const context = { cwd: "/tmp/project", sessionManager: { getSessionFile: () => undefined }, ui: {} } as any;
		const selected = await toolDef.execute("source-selected-cr", {
			sourceId: "00000000-0000-4000-8000-000000000000", outputView: "selected",
		}, undefined, undefined, context);
		const recovered = await toolDef.execute("source-raw-cr", {
			sourceId: "00000000-0000-4000-8000-000000000000", outputView: "raw", sourceLimit: raw.length,
		}, undefined, undefined, context);
		expect(createJevClient).not.toHaveBeenCalled();
		expect(selected.content[0].text).toBe("progress 100%");
		expect(selected.content[0].text).not.toContain("progress 99%");
		expect(recovered.content[0].text).toBe(raw);
		expect(selected.details.rawRanges).toEqual([{ start: 0, end: raw.length }]);
	});

	it("keeps raw recovery but reports selected unavailable after metadata loss", async () => {
		const { toolDef, setSelectionMetadata, createJevClient } = await setupHarness();
		setSelectionMetadata(undefined);
		const result = await toolDef.execute("source-selected-restart", {
			sourceId: "00000000-0000-4000-8000-000000000000", outputView: "selected",
		}, undefined, undefined, { cwd: "/tmp/project", sessionManager: { getSessionFile: () => undefined }, ui: {} } as any);
		expect(createJevClient).not.toHaveBeenCalled();
		expect(result.details).toMatchObject({ selectionStatus: "unavailable", reason: "selection-metadata-unavailable", rawRecovery: { outputView: "raw" } });
	});

	it("does not construct a provider for eligible output when the process credential is absent", async () => {
		const previous = process.env.TYPESAFE_API_KEY;
		delete process.env.TYPESAFE_API_KEY;
		try {
			const sourceText = Array.from({ length: 24 }, (_, index) => `routine ${index} ${"x".repeat(240)}\n`).join("");
			const { toolDef, createJevClient } = await setupHarness({ sourceText });
			const result = await toolDef.execute("source-selected-no-key", {
				sourceId: "00000000-0000-4000-8000-000000000000", outputView: "selected",
			}, undefined, undefined, { cwd: "/tmp/project", sessionManager: { getSessionFile: () => undefined }, ui: {} } as any);
			expect(createJevClient).not.toHaveBeenCalled();
			expect(result.content[0].text).toBe("fallback");
			expect(result.details).toMatchObject({ selectionStatus: "unavailable", reason: "credential-unavailable", rawRecovery: { outputView: "raw" } });
		} finally {
			if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
			else process.env.TYPESAFE_API_KEY = previous;
		}
	});

	it("does not construct a provider when global Jev enablement is disabled", async () => {
		const previous = process.env.TYPESAFE_API_KEY;
		process.env.TYPESAFE_API_KEY = "test-only-key";
		try {
			const sourceText = Array.from({ length: 24 }, (_, index) => `routine ${index} ${"x".repeat(240)}\n`).join("");
			const { toolDef, createJevClient } = await setupHarness({ sourceText, jevEnabled: false });
			const result = await toolDef.execute("source-selected-disabled", {
				sourceId: "00000000-0000-4000-8000-000000000000", outputView: "selected",
			}, undefined, undefined, { cwd: "/tmp/project", sessionManager: { getSessionFile: () => undefined }, ui: {} } as any);
			expect(createJevClient).not.toHaveBeenCalled();
			expect(result.details).toMatchObject({ selectionStatus: "unavailable", reason: "jev-disabled" });
		} finally {
			if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
			else process.env.TYPESAFE_API_KEY = previous;
		}
	});

	it("lazily constructs the pinned selector client for eligible complete output", async () => {
		const previous = process.env.TYPESAFE_API_KEY;
		process.env.TYPESAFE_API_KEY = "test-only-key";
		try {
			const sourceText = Array.from({ length: 24 }, (_, index) => `routine ${index} ${"x".repeat(240)}\n`).join("");
			const providerEvaluate = (request: any) => {
				const answers: Record<string, unknown> = {};
				for (const key of Object.keys(request.questions)) answers[key] = { type: "noul", noul: key.endsWith("routine_progress") ? 1 : 0 };
				return { answers, model: "jev-1.13.0", usage: { input_tokens: 1, output_tokens: 1 } };
			};
			const { toolDef, createJevClient } = await setupHarness({ sourceText, providerEvaluate });
			const result = await toolDef.execute("source-selected-eligible", {
				sourceId: "00000000-0000-4000-8000-000000000000", outputView: "selected",
			}, undefined, undefined, { cwd: "/tmp/project", sessionManager: { getSessionFile: () => undefined }, ui: {} } as any);
			expect(createJevClient).toHaveBeenCalledTimes(1);
			expect(createJevClient).toHaveBeenCalledWith({ enabled: true, model: "jev-1.13.0", maxRetries: 1 });
			expect(result.details).toMatchObject({ selectionStatus: "selected", displayRepresentation: "safe-normalized-terminal-text-v1", rawRecovery: { outputView: "raw" } });
		} finally {
			if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
			else process.env.TYPESAFE_API_KEY = previous;
		}
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

	it("preserves semantic policy when hands-free foreground returns to background", async () => {
		const { toolDef, setBackgroundSession, getHeadlessOptions, getExistingMonitor, getHeadlessConstructCount, createJevClient, coordinatorInstance } = await setupHarness();
		const bgSession = { session: {}, startedAt: new Date(), command: "pi", reason: undefined };
		setBackgroundSession(bgSession);
		await toolDef.execute("call-semantic", {
			command: "pi", mode: "hands-free", monitor: { semantic: { attention: true, uncertain: "notify", watches: [{ id: "ready", condition: "ready" }] } },
		}, undefined, undefined, {
			hasUI: true, cwd: "/tmp/project", sessionManager: { getSessionFile: () => undefined },
			ui: { custom: vi.fn(async (factory) => {
				factory({ terminal: { columns: 120, rows: 40 } }, {}, undefined, () => {});
				return { exitCode: null, backgrounded: true, backgroundId: "bg-session", cancelled: false };
			}) },
		} as any);
		await Promise.resolve(); await Promise.resolve();
		expect(getHeadlessOptions()).toMatchObject({
			monitor: { strategy: "semantic" },
			semantic: { mode: "hands-free", config: { attention: true, uncertain: "notify", watches: [{ id: "ready" }] } },
		});
		expect(getHeadlessOptions().onMonitorEvent).toBeTypeOf("function");
		expect(getHeadlessConstructCount()).toBe(1);
		expect(createJevClient).toHaveBeenCalledTimes(1);
		expect(getExistingMonitor().activateBackgroundLifecycle).toHaveBeenCalledTimes(1);
		expect(coordinatorInstance.recordSemanticDecision).toHaveBeenCalledBefore(getExistingMonitor().activateBackgroundLifecycle);
		expect(coordinatorInstance.setMonitor).toHaveBeenCalledBefore(coordinatorInstance.registerSemanticSession);
		expect(coordinatorInstance.setMonitor).toHaveBeenCalledBefore(coordinatorInstance.registerMonitorSession);
	});

	it("fails foreground semantic setup transactionally and reports one bounded visible failure", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const adversarialId = `${"caller-controlled-".repeat(80)}\n\u001b[31m\u0000SESSION`;
			const { toolDef, coordinatorInstance, getExistingMonitor, getConstructedMonitor, getForegroundSession, unregisterActive, sendMessage } = await setupHarness({ monitorInstallError: "RAW_THROWN_SENTINEL", generatedSessionId: adversarialId });
			const result = await toolDef.execute("call-setup-failure", {
				command: "pi", name: adversarialId, mode: "dispatch", monitor: { semantic: { attention: true } },
			}, undefined, undefined, {
				hasUI: true, cwd: "/tmp/project", sessionManager: { getSessionFile: () => undefined },
				ui: { custom: vi.fn(async (factory) => factory({ terminal: { columns: 120, rows: 40 } }, {}, undefined, () => {})) },
			} as any);
			expect(result.details).toMatchObject({ sessionId: adversarialId, status: "running" });
			await Promise.resolve(); await Promise.resolve();
			expect(coordinatorInstance.recordSemanticDecision).toHaveBeenCalledTimes(1);
			expect(coordinatorInstance.registerSemanticSession).not.toHaveBeenCalled();
			expect(coordinatorInstance.registerMonitorSession).not.toHaveBeenCalled();
			expect(coordinatorInstance.setSemanticSessionStatus).toHaveBeenCalledWith(adversarialId, "stopped");
			expect(coordinatorInstance.getSemanticSessionState(adversarialId)).toBeUndefined();
			expect(coordinatorInstance.getMonitorSessionState(adversarialId)).toBeUndefined();
			expect(coordinatorInstance.getSemanticDecisions(adversarialId).total).toBe(0);
			expect(coordinatorInstance.getMonitorEvents(adversarialId).total).toBe(0);
			expect(coordinatorInstance.clearSemanticDecisions).toHaveBeenCalledTimes(1);
			expect(coordinatorInstance.clearMonitorEvents).toHaveBeenCalledTimes(1);
			expect(getExistingMonitor()).toBeUndefined();
			expect(getConstructedMonitor().disposed).toBe(true);
			expect(getForegroundSession().kill).toHaveBeenCalledTimes(1);
			expect(getForegroundSession().dispose).toHaveBeenCalledTimes(1);
			expect(unregisterActive).toHaveBeenCalledWith(adversarialId, true);
			expect(sendMessage).toHaveBeenCalledTimes(1);
			expect(sendMessage).toHaveBeenCalledWith({
				customType: "interactive-shell-monitor-lifecycle", display: true,
				content: "Semantic supervision stopped because foreground setup failed.",
				details: { status: "stopped", reason: "foreground-setup-failed" },
			}, { triggerTurn: true });
			expect(JSON.stringify(sendMessage.mock.calls)).not.toContain("RAW_THROWN_SENTINEL");
			expect(JSON.stringify(sendMessage.mock.calls)).not.toContain("caller-controlled-");
			expect(JSON.stringify(consoleError.mock.calls)).not.toContain("RAW_THROWN_SENTINEL");
			expect(JSON.stringify(consoleError.mock.calls)).not.toContain("caller-controlled-");
		} finally {
			consoleError.mockRestore();
		}
	});

	it("pauses foreground semantic ownership on takeover and resumes behind the supervisor fresh-output fence", async () => {
		const onMonitorDispose = vi.fn();
		const { toolDef, getOverlayOptions, getExistingMonitor, coordinatorInstance } = await setupHarness({ onMonitorDispose });
		let finishOverlay!: (value: any) => void;
		const executePromise = toolDef.execute("call-takeover", {
			command: "pi", mode: "hands-free", monitor: { semantic: { attention: true } },
		}, undefined, undefined, {
			hasUI: true, cwd: "/tmp/project", sessionManager: { getSessionFile: () => undefined },
			ui: { custom: vi.fn((factory) => {
				factory({ terminal: { columns: 120, rows: 40 } }, {}, undefined, () => {});
				return new Promise((resolve) => { finishOverlay = resolve; });
			}) },
		} as any);
		await Promise.resolve(); await Promise.resolve();
		getOverlayOptions().onAgentControlChange(false);
		expect(getExistingMonitor().pauseSemantic).toHaveBeenCalledTimes(1);
		expect(coordinatorInstance.setSemanticSessionStatus).toHaveBeenCalledWith("start-session", "paused");
		getOverlayOptions().onAgentControlChange(true);
		expect(getExistingMonitor().resumeSemantic).toHaveBeenCalledTimes(1);
		expect(coordinatorInstance.setSemanticSessionStatus).toHaveBeenCalledWith("start-session", "running");
		getOverlayOptions().onSessionLifecycleEnd({ exitCode: 0, signal: 15 });
		expect(coordinatorInstance.finalizeMonitorSession).toHaveBeenCalledWith("start-session", { exitCode: 0, signal: 15 }, "stream-ended");
		expect(coordinatorInstance.finalizeMonitorSession.mock.invocationCallOrder[0]).toBeLessThan(onMonitorDispose.mock.invocationCallOrder[0]);
		expect(getExistingMonitor().disposed).toBe(true);
		finishOverlay!({ exitCode: 0, signal: 15, backgrounded: false, cancelled: false });
		await executePromise;
		expect(coordinatorInstance.getSemanticSessionState("start-session")?.status).toBe("stopped");
		expect(coordinatorInstance.getMonitorSessionState("start-session")?.status).toBe("stopped");
		expect(coordinatorInstance.finalizeMonitorSession).toHaveBeenCalledTimes(1);
	});

	it("stops and schedules bounded semantic cleanup on transfer without killing ownership", async () => {
		vi.useFakeTimers();
		try {
			const { toolDef, setExistingMonitor, coordinatorInstance, unregisterActive } = await setupHarness();
			const semanticMonitor = { disposed: false, dispose: vi.fn(function (this: { disposed: boolean }) { this.disposed = true; }), kill: vi.fn() };
			setExistingMonitor(semanticMonitor);
			coordinatorInstance.registerMonitorSession("start-session");
			await toolDef.execute("call-transfer", {
				command: "pi", mode: "dispatch", monitor: { semantic: { attention: true } },
			}, undefined, undefined, {
				hasUI: true, cwd: "/tmp/project", sessionManager: { getSessionFile: () => undefined },
				ui: { custom: vi.fn(async () => ({ exitCode: null, backgrounded: false, cancelled: false, sessionId: "start-session", transferred: { lines: ["done"], totalLines: 1, truncated: false } })) },
			} as any);
			await Promise.resolve(); await Promise.resolve();
			expect(unregisterActive).toHaveBeenCalledWith("start-session", true);
			expect(coordinatorInstance.setSemanticSessionStatus).toHaveBeenCalledWith("start-session", "stopped");
			expect(coordinatorInstance.finalizeMonitorSession).toHaveBeenCalledWith("start-session", { exitCode: null, signal: undefined }, "stopped");
			expect(semanticMonitor.dispose).toHaveBeenCalledTimes(1);
			expect(semanticMonitor.kill).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
			expect(coordinatorInstance.clearSemanticDecisions).toHaveBeenCalledWith("start-session");
			expect(coordinatorInstance.clearMonitorEvents).toHaveBeenCalledWith("start-session");
		} finally {
			vi.useRealTimers();
		}
	});
});
