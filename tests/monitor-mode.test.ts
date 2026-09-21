import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compileSemanticPermissions, type SemanticPermissionRule } from "../semantic-permissions.ts";

type MonitorOptionsCapture = {
	monitor?: {
		strategy: "stream" | "poll-diff" | "file-watch" | "semantic";
		triggers: Array<{ id: string; match: (input: string) => string | undefined; cooldownMs?: number }>;
		pollIntervalMs: number;
		dedupeExactLine: boolean;
		cooldownMs?: number;
	};
	onMonitorEvent?: (event: unknown) => void | Promise<void>;
	semantic?: { onDecision: (decision: unknown) => void };
} | null;

type DetectorLaunchCapture = {
	shell: string;
	args: string[];
	cwd?: string;
	stdin: string;
} | null;

async function setupHarness(options: { detectorStdout?: string; diagnostics?: boolean; agentDir?: string; launchRules?: readonly SemanticPermissionRule[] } = {}) {
	let toolDef: any;
	let monitorOptions: MonitorOptionsCapture = null;
	let detectorLaunch: DetectorLaunchCapture = null;
	let launchedCommand: string | undefined;
	let monitorCompleteCallback: ((info: unknown) => void) | undefined;
	let activeSession: unknown;
	const spawnResolutionOptions: unknown[] = [];
	let resolveMonitorNotification!: () => void;
	const monitorNotification = new Promise<void>((resolve) => { resolveMonitorNotification = resolve; });
	const sendMessage = vi.fn((message: { customType?: string; content?: string }) => {
		if (message.customType === "interactive-shell-monitor-event") resolveMonitorNotification();
	});
	const eventsEmit = vi.fn();

	vi.resetModules();
	vi.doMock("@earendil-works/pi-coding-agent", () => ({
		getAgentDir: () => options.agentDir ?? "/tmp/pi-agent",
		getShellConfig: () => ({ shell: "/bin/bash", args: ["-c"] }),
		SettingsManager: { create: () => ({ getShellPath: () => undefined }) },
	}));
	vi.doMock("node:child_process", () => ({
		spawn: vi.fn((shell: string, args: string[], spawnOptions: { cwd?: string }) => {
			let stdin = "";
			const child = new EventEmitter() as EventEmitter & {
				stdout: EventEmitter & { setEncoding: (encoding: string) => void };
				stderr: EventEmitter & { setEncoding: (encoding: string) => void };
				stdin: { write: (data: string) => void; end: () => void };
				kill: () => void;
			};
			child.stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
			child.stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
			const writeStdin = vi.fn((data: string) => {
				stdin += data;
				if (detectorLaunch) detectorLaunch.stdin = stdin;
			});
			child.stdin = {
				write: writeStdin,
				end: vi.fn(),
			};
			detectorLaunch = { shell, args: [...args], cwd: spawnOptions.cwd, stdin };
			child.kill = vi.fn();
			process.nextTick(() => {
				child.stdout.emit("data", options.detectorStdout ?? "");
				child.emit("exit", 0);
			});
			return child;
		}),
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
				jev: { enabled: true, model: "jev-1.13.0", requestTimeoutMs: 1000, maxRetries: 0, maxViewportLines: 20, maxRecentChars: 1000, redactionPatterns: [], diagnostics: { enabled: options.diagnostics === true, retentionDays: 14, maxBytes: 1_000_000 }, semanticPermissions: compileSemanticPermissions(options.launchRules ?? []), launchPermissionsEnabled: options.launchRules !== undefined },
			})),
		};
	});
	vi.doMock("../spawn.ts", async () => {
		const actual = await vi.importActual<typeof import("../spawn.ts")>("../spawn.ts");
		return {
			...actual,
			resolveSpawn: (...args: Parameters<typeof actual.resolveSpawn>) => {
				spawnResolutionOptions.push(args[4]);
				return actual.resolveSpawn(...args);
			},
		};
	});
	vi.doMock("../jev-client.ts", () => ({ createJevClient: vi.fn(() => ({ evaluate: vi.fn() })) }));
	vi.doMock("../overlay-component.ts", () => ({
		InteractiveShellOverlay: class MockInteractiveShellOverlay {},
	}));
	vi.doMock("../reattach-overlay.ts", () => ({
		ReattachOverlay: class MockReattachOverlay {},
	}));
	vi.doMock("../pty-session.ts", () => ({
		PtyTerminalSession: class MockPtyTerminalSession {
			exited = false;
			exitCode: number | null = null;
			signal: number | undefined;
			constructor(options: { command: string }) {
				launchedCommand = options.command;
			}
			addDataListener(_cb: (data: string) => void) { return () => {}; }
			addExitListener(_cb: (exitCode: number | null, signal?: number) => void) { return () => {}; }
			getTailLines() { return { lines: [], totalLinesInBuffer: 0, truncatedByChars: false }; }
			write() {}
			kill() {}
			setEventHandlers() {}
			dispose() {}
			getRawStream() { return ""; }
		},
	}));
	vi.doMock("../headless-monitor.ts", () => ({
		HeadlessDispatchMonitor: class MockHeadlessDispatchMonitor {
			disposed = false;
			private options: MonitorOptionsCapture;
			constructor(
				_session: unknown,
				_config: unknown,
				options: MonitorOptionsCapture,
				onComplete: (info: unknown) => void,
			) {
				this.options = options;
				monitorOptions = options;
				monitorCompleteCallback = onComplete;
			}
			getResult() { return undefined; }
			registerCompleteCallback() {}
			dispose() { this.disposed = true; }
			rebindSemanticEpoch() {}
			pauseSemantic() {}
			resumeSemantic() {}
			submitMonitorCandidate(event: unknown) { void this.options?.onMonitorEvent?.(event); return true; }
		},
	}));
	vi.doMock("../session-manager.ts", () => ({
		sessionManager: {
			getActive: vi.fn(() => activeSession),
			unregisterActive: vi.fn(),
			registerActive: vi.fn(),
			list: vi.fn(() => []),
			add: vi.fn(() => "monitor-1"),
			take: vi.fn(() => undefined),
			get: vi.fn(() => undefined),
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
		generateSessionId: vi.fn(() => "monitor-1"),
	}));

	const extensionModule = await import("../index.ts");
	extensionModule.default({
		registerShortcut: vi.fn(),
		registerCommand: vi.fn(),
		registerTool: vi.fn((definition: any) => {
			toolDef = definition;
		}),
		on: vi.fn(),
		events: { emit: eventsEmit },
		sendMessage,
	} as any);

	return {
		toolDef,
		getMonitorOptions: () => monitorOptions,
		getDetectorLaunch: () => detectorLaunch,
		getLaunchedCommand: () => launchedCommand,
		getSpawnResolutionOptions: () => spawnResolutionOptions,
		getMonitorCompleteCallback: () => monitorCompleteCallback,
		waitForMonitorNotification: () => monitorNotification,
		setActiveSession: (session: unknown) => { activeSession = session; },
		sendMessage,
		eventsEmit,
	};
}

describe("monitor mode", () => {
	afterEach(() => {
		vi.doUnmock("@earendil-works/pi-coding-agent");
		vi.doUnmock("node:child_process");
		vi.doUnmock("@earendil-works/pi-tui");
		vi.doUnmock("../config.ts");
		vi.doUnmock("../overlay-component.ts");
		vi.doUnmock("../reattach-overlay.ts");
		vi.doUnmock("../pty-session.ts");
		vi.doUnmock("../headless-monitor.ts");
		vi.doUnmock("../session-manager.ts");
		vi.doUnmock("../jev-client.ts");
		vi.doUnmock("../spawn.ts");
	});

	it("requires monitor object when mode is monitor", async () => {
		const { toolDef } = await setupHarness();
		const result = await toolDef.execute("call-1", {
			command: "npm test",
			mode: "monitor",
		}, undefined, undefined, {
			hasUI: false,
			cwd: "/tmp/project",
			ui: {},
			sessionManager: { getSessionFile: () => "/tmp/project/session.jsonl" },
		} as any);

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toBe("mode='monitor' requires monitor configuration.");
	});

	it("blocks denied launch commands before constructing a terminal session", async () => {
		const { toolDef, getLaunchedCommand } = await setupHarness({ launchRules: [
			{ decision: "deny", operation: { kind: "launch-command", command: "npm test" } },
		] });
		const confirm = vi.fn(async () => true);
		const result = await toolDef.execute("denied-launch", {
			command: "npm test", mode: "monitor", monitor: { strategy: "stream", triggers: [{ id: "done", literal: "done" }] },
			semanticPermissions: [{ decision: "allow" }],
		}, undefined, undefined, { hasUI: true, cwd: "/tmp/project", ui: { confirm }, sessionManager: { getSessionFile: () => undefined } } as any);
		expect(result).toMatchObject({ isError: true, details: { error: "launch_not_authorized", reason: "denied" } });
		expect(getLaunchedCommand()).toBeUndefined();
		expect(confirm).not.toHaveBeenCalled();
	});

	it("requires an explicit Pi confirmation for ask and binds it to the exact command", async () => {
		const rules: SemanticPermissionRule[] = [
			{ decision: "allow", operation: { kind: "launch-command", command: "npm test" } },
			{ decision: "ask", operation: { kind: "launch-command", command: "npm test -- --runInBand" } },
		];
		const allowed = await setupHarness({ launchRules: rules });
		const allowedResult = await allowed.toolDef.execute("exact-allow", {
			command: "npm test", mode: "monitor", monitor: { strategy: "stream", triggers: [{ id: "done", literal: "done" }] },
		}, undefined, undefined, { hasUI: false, cwd: "/tmp/project", ui: {}, sessionManager: { getSessionFile: () => undefined } } as any);
		expect(allowedResult.isError).toBeUndefined();
		expect(allowed.getLaunchedCommand()).toBe("npm test");

		const asked = await setupHarness({ launchRules: rules });
		const confirm = vi.fn(async (_title: string, message: string) => {
			expect(message).toContain(JSON.stringify("npm test -- --runInBand"));
			return true;
		});
		const askedResult = await asked.toolDef.execute("exact-ask", {
			command: "npm test -- --runInBand", mode: "monitor", monitor: { strategy: "stream", triggers: [{ id: "done", literal: "done" }] },
		}, undefined, undefined, { hasUI: true, cwd: "/tmp/project", ui: { confirm }, sessionManager: { getSessionFile: () => undefined } } as any);
		expect(askedResult.isError).toBeUndefined();
		expect(asked.getLaunchedCommand()).toBe("npm test -- --runInBand");
		expect(confirm).toHaveBeenCalledOnce();
	});

	it.each([
		["rejection", true, async (): Promise<boolean> => false, "rejected"],
		["dialog error", true, async (): Promise<boolean> => { throw new Error("ui failed"); }, "ui-unavailable"],
		["headless", false, undefined, "ui-unavailable"],
	] as const)("fails ask closed on %s", async (_label, hasUI, confirm, reason) => {
		const harness = await setupHarness({ launchRules: [{ decision: "ask", operation: { kind: "launch-command", command: "npm test" } }] });
		const result = await harness.toolDef.execute("ask-failure", {
			command: "npm test", mode: "monitor", monitor: { strategy: "stream", triggers: [{ id: "done", literal: "done" }] },
		}, undefined, undefined, { hasUI, cwd: "/tmp/project", ui: confirm ? { confirm: vi.fn(confirm) } : {}, sessionManager: { getSessionFile: () => undefined } } as any);
		expect(result).toMatchObject({ isError: true, details: { error: "launch_not_authorized", reason } });
		expect(harness.getLaunchedCommand()).toBeUndefined();
	});

	it("applies launch policy to the exact resolved structured spawn command", async () => {
		const denied = await setupHarness({ launchRules: [{ decision: "deny", operation: { kind: "launch-command", command: "codex" } }] });
		const deniedResult = await denied.toolDef.execute("spawn-deny", {
			spawn: { agent: "codex", worktree: true }, mode: "monitor", monitor: { strategy: "stream", triggers: [{ id: "done", literal: "done" }] },
		}, undefined, undefined, { hasUI: false, cwd: "/tmp/project", ui: {}, sessionManager: { getSessionFile: () => undefined } } as any);
		expect(deniedResult.isError).toBe(true);
		expect(denied.getLaunchedCommand()).toBeUndefined();
		expect(denied.getSpawnResolutionOptions()).toEqual([{ createWorktree: false }]);

		const allowed = await setupHarness({ launchRules: [{ decision: "allow", operation: { kind: "launch-command", command: "codex" } }] });
		const allowedResult = await allowed.toolDef.execute("spawn-allow", {
			spawn: { agent: "codex" }, mode: "monitor", monitor: { strategy: "stream", triggers: [{ id: "done", literal: "done" }] },
		}, undefined, undefined, { hasUI: false, cwd: "/tmp/project", ui: {}, sessionManager: { getSessionFile: () => undefined } } as any);
		expect(allowedResult.isError).toBeUndefined();
		expect(allowed.getLaunchedCommand()).toBe("codex");
	});

	it("does not apply launch policy to ordinary query and control calls", async () => {
		const { toolDef, getLaunchedCommand } = await setupHarness({ launchRules: [] });
		const confirm = vi.fn(async () => true);
		const result = await toolDef.execute("query", { monitorStatus: true, monitorSessionId: "missing" }, undefined, undefined,
			{ hasUI: true, cwd: "/tmp/project", ui: { confirm }, sessionManager: { getSessionFile: () => undefined } } as any);
		expect(result.isError).toBeUndefined();
		expect(confirm).not.toHaveBeenCalled();
		expect(getLaunchedCommand()).toBeUndefined();
	});

	it("launches semantic monitor and routes watch events through the existing wake sink", async () => {
		const { toolDef, getMonitorOptions, sendMessage, eventsEmit, waitForMonitorNotification } = await setupHarness();
		const result = await toolDef.execute("call-semantic", {
			command: "agent", mode: "monitor",
			monitor: { strategy: "semantic", semantic: { goal: "observe", watches: [{ id: "ready", condition: "result is visible" }] } },
		}, undefined, undefined, {
			hasUI: false, cwd: "/tmp/project", ui: {}, sessionManager: { getSessionFile: () => "/tmp/project/session.jsonl" },
		} as any);
		expect(result.isError).toBeUndefined();
		expect(result.content[0].text).toContain("Semantic: attention off; watches ready; actions none");
		expect(getMonitorOptions()?.monitor?.strategy).toBe("semantic");
		expect(getMonitorOptions()?.semantic).toBeDefined();
		expect(getMonitorOptions()?.onMonitorEvent).toBeTypeOf("function");
		expect(sendMessage).not.toHaveBeenCalled();
		getMonitorOptions()?.semantic?.onDecision({
			kind: "observation", route: "notify", model: "jev-1.13.0", observationHash: "not-forwarded", generation: 4, latencyMs: 2,
			answers: {
				requestsInput: 0, requestsApproval: 0, presentsResult: 0, requiresIntervention: 0, meaningfulProgress: 1,
				watches: { ready: 0.8 }, attention: { value: "working", confidence: 0.9, probabilities: { working: 0.9, waiting_input: 0.02, waiting_approval: 0.02, presenting_result: 0.02, blocked: 0.02, other: 0.02 } },
			},
		});
		await waitForMonitorNotification();
		expect(sendMessage).toHaveBeenCalledTimes(1);
		expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({ customType: "interactive-shell-monitor-event", details: { triggerId: "semantic:watch:ready", semantic: { watchId: "ready", probability: 0.8 } } });
		expect(sendMessage.mock.calls[0]?.[0].content).toContain("Message: Semantic watch matched: ready");
		expect(JSON.stringify(sendMessage.mock.calls[0]?.[0])).not.toContain("not-forwarded");
		expect(eventsEmit).toHaveBeenCalledWith("interactive-shell:monitor-event", expect.objectContaining({ triggerId: "semantic:watch:ready" }));
	});

	it("records fixed agent incidents and returns a content-free diagnostic summary", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "interactive-shell-diagnostic-tool-"));
		try {
			const { toolDef, getMonitorOptions } = await setupHarness({ diagnostics: true, agentDir });
			const ctx = { hasUI: false, cwd: "/tmp/private-project", ui: {}, sessionManager: { getSessionFile: () => "/tmp/private-session.jsonl" } } as any;
			const launched = await toolDef.execute("diagnostic-launch", {
				command: "PRIVATE_COMMAND", mode: "monitor", monitor: { strategy: "semantic", semantic: { attention: true } },
			}, undefined, undefined, ctx);
			const target = launched.details.sessionId as string;
			getMonitorOptions()?.semantic?.onDecision({
				kind: "observation", route: "notify", model: "jev-1.13.0", observationHash: "PRIVATE_OBSERVATION", generation: 1, latencyMs: 3,
				answers: { requestsInput: 0, requestsApproval: 0, presentsResult: 0.99, requiresIntervention: 0, meaningfulProgress: 0, watches: {},
					attention: { value: "presenting_result", confidence: 0.99, probabilities: { working: 0, waiting_input: 0, waiting_approval: 0, presenting_result: 0.99, blocked: 0, other: 0.01 } } },
			});
			const filed = await toolDef.execute("diagnostic-incident", {
				semanticSessionId: target, semanticIncident: { kind: "premature-result", decisionId: 1, observedEvent: "result-ready" },
			}, undefined, undefined, ctx);
			expect(filed.isError).toBeUndefined();
			expect(filed.content[0].text).toContain("premature-result");
			const summary = await toolDef.execute("diagnostic-summary", { semanticDiagnostics: true }, undefined, undefined, ctx);
			expect(summary.details.totals).toMatchObject({ decisions: 1, deliveries: 1, incidents: 1 });
			expect(summary.details.incidentsByKind).toEqual({ "premature-result": 1 });
			expect(JSON.stringify(summary)).not.toMatch(/PRIVATE_COMMAND|PRIVATE_OBSERVATION|private-project|private-session/);
		} finally { rmSync(agentDir, { recursive: true, force: true }); }
	});

	it("delivers an already-classified action-control candidate through the bounded wake sink", async () => {
		const { toolDef, getMonitorOptions, sendMessage, eventsEmit, waitForMonitorNotification } = await setupHarness();
		await toolDef.execute("call-action-control", {
			command: "agent", mode: "monitor", monitor: { strategy: "semantic", semantic: { goal: "observe" } },
		}, undefined, undefined, { hasUI: false, cwd: "/tmp/project", ui: {}, sessionManager: { getSessionFile: () => undefined } } as any);
		getMonitorOptions()?.onMonitorEvent?.({
			strategy: "semantic", triggerId: "semantic:action-control:notify_pi", eventType: "semantic-action-control",
			matchedText: "semantic-action-control", lineOrDiff: "Semantic action requested Pi intervention", stream: "pty",
			semantic: { kind: "action-control", decisionId: 3, generation: 6, model: "jev-1.13.0", controlChoice: "notify_pi", confidence: 0.96, probability: 0.96 },
		});
		await waitForMonitorNotification();
		expect(sendMessage).toHaveBeenCalledTimes(1);
		expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({ details: { triggerId: "semantic:action-control:notify_pi", semantic: { kind: "action-control", controlChoice: "notify_pi" } } });
		expect(JSON.stringify(sendMessage.mock.calls[0]?.[0])).not.toContain("private-hash");
		expect(eventsEmit).toHaveBeenCalledWith("interactive-shell:monitor-event", expect.objectContaining({ triggerId: "semantic:action-control:notify_pi" }));
	});

	it("returns only fixed malformed-response diagnostics in semantic tool details", async () => {
		const { toolDef, getMonitorOptions } = await setupHarness();
		await toolDef.execute("malformed-audit", {
			command: "agent", mode: "monitor", monitor: { strategy: "semantic", semantic: { goal: "observe" } },
		}, undefined, undefined, { hasUI: false, cwd: "/tmp/project", ui: {}, sessionManager: { getSessionFile: () => undefined } } as any);
		getMonitorOptions()?.semantic?.onDecision({
			kind: "evaluator-error", route: "error", model: "jev-1.13.0", observationHash: "private-hash", generation: 2, latencyMs: 1,
			error: "SemanticResponseError: semantic evaluator response invalid",
		});
		const query = await toolDef.execute("query-malformed", { semanticDecisions: true, semanticSessionId: "monitor-1" }, undefined, undefined, { cwd: "/tmp/project" } as any);
		expect(query.details.decisions[0]).toMatchObject({ model: "jev-1.13.0", error: "SemanticResponseError: semantic evaluator response invalid" });
		expect(query.content[0].text).toContain("SemanticResponseError: semantic evaluator response invalid");
		expect(JSON.stringify(query)).not.toMatch(/provider-model-secret|provider_answer_key_secret|BODY_SECRET/);
	});

	it("compiles authorized actions privately and rejects mixed input forms before launch", async () => {
		const valid = await setupHarness();
		const launched = await valid.toolDef.execute("valid-actions", {
			command: "agent", mode: "monitor", monitor: { strategy: "semantic", semantic: { actions: { enabled: true, items: [{ id: "confirm", description: "Confirm the ordinary prompt", input: "yes", submit: true }] } } },
		}, undefined, undefined, { hasUI: false, cwd: "/tmp/project", ui: {}, sessionManager: { getSessionFile: () => undefined } } as any);
		expect(launched.isError).toBeUndefined();
		expect((valid.getMonitorOptions()?.semantic as any)?.actionRegistry.get("confirm").bytes).toBe("yes\r");
		expect(JSON.stringify(launched)).not.toContain('"input":"yes"');
		valid.getMonitorOptions()?.semantic?.onDecision({
			kind: "observation", route: "continue", model: "jev-1.13.0", observationHash: "private", generation: 1, latencyMs: 1,
			action: { choice: "confirm", actionId: "confirm", confidence: 0.99, probability: 0.99, readiness: 0.99, outcome: "blocked", reason: "global-budget", budgetCount: 0 },
			answers: { requestsInput: 0, requestsApproval: 0, presentsResult: 0, requiresIntervention: 0, meaningfulProgress: 0, watches: {}, attention: { value: "working", confidence: 0.99, probabilities: { working: 0.99, waiting_input: 0.002, waiting_approval: 0.002, presenting_result: 0.002, blocked: 0.002, other: 0.002 } } },
		});
		const decisions = await valid.toolDef.execute("action-decisions", { semanticDecisions: true, semanticSessionId: "monitor-1" }, undefined, undefined, { cwd: "/tmp/project" } as any);
		expect(decisions.content[0].text).toContain("action:confirm/blocked/global-budget");
		expect(decisions.content[0].text).not.toContain("yes");

		const invalid = await setupHarness();
		const rejected = await invalid.toolDef.execute("invalid-actions", {
			command: "agent", mode: "monitor", monitor: { strategy: "semantic", semantic: { actions: { enabled: true, items: [{ id: "bad", description: "Mixed", input: "yes", inputKeys: ["enter"] }] } } },
		}, undefined, undefined, { hasUI: false, cwd: "/tmp/project", ui: {}, sessionManager: { getSessionFile: () => undefined } } as any);
		expect(rejected.isError).toBe(true);
		expect(rejected.content[0].text).toContain("exactly one input form");
	});

	it("rejects dynamic choices without an explicit semantic goal", async () => {
		const { toolDef } = await setupHarness();
		const result = await toolDef.execute("dynamic-without-goal", {
			command: "agent", mode: "monitor",
			monitor: { strategy: "semantic", semantic: { dynamicChoices: { enabled: true } } },
		}, undefined, undefined, { hasUI: false, cwd: "/tmp/project", ui: {}, sessionManager: { getSessionFile: () => undefined } } as any);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("require a non-empty semantic goal");
	});

	it("routes semantic-enabled background dispatch through structured history and persistence", async () => {
		const { toolDef, getMonitorOptions, waitForMonitorNotification, setActiveSession, sendMessage } = await setupHarness();
		const active = { kill: vi.fn() };
		setActiveSession(active);
		const launched = await toolDef.execute("dispatch-semantic", {
			command: "agent", mode: "dispatch", background: true,
			monitor: { semantic: { watches: [{ id: "dispatch-ready", condition: "ready" }] }, persistence: { stopAfterFirstEvent: true } },
		}, undefined, undefined, { hasUI: false, cwd: "/tmp/project", ui: {}, sessionManager: { getSessionFile: () => undefined } } as any);
		expect(launched.isError).toBeUndefined();
		getMonitorOptions()?.semantic?.onDecision({
			kind: "observation", route: "notify", model: "jev-1.13.0", observationHash: "private", generation: 2, latencyMs: 1,
			answers: {
				requestsInput: 0, requestsApproval: 0, presentsResult: 0, requiresIntervention: 0, meaningfulProgress: 1, watches: { "dispatch-ready": 0.9 },
				attention: { value: "working", confidence: 0.9, probabilities: { working: 0.9, waiting_input: 0.02, waiting_approval: 0.02, presenting_result: 0.02, blocked: 0.02, other: 0.02 } },
			},
		});
		await waitForMonitorNotification();
		expect(sendMessage).toHaveBeenCalledTimes(1);
		expect(active.kill).toHaveBeenCalledTimes(1);
		const history = await toolDef.execute("query-semantic", { monitorEvents: true, monitorSessionId: "monitor-1", monitorTriggerId: "semantic:watch:dispatch-ready" }, undefined, undefined, { cwd: "/tmp/project" } as any);
		expect(history.details.events).toHaveLength(1);
		expect(history.details.events[0]).toMatchObject({ triggerId: "semantic:watch:dispatch-ready", semantic: { generation: 2, watchId: "dispatch-ready" } });
	});

	it("applies maxEvents through the shared semantic sink", async () => {
		const { toolDef, getMonitorOptions, waitForMonitorNotification, setActiveSession, sendMessage } = await setupHarness();
		const active = { kill: vi.fn() }; setActiveSession(active);
		await toolDef.execute("semantic-max", {
			command: "agent", mode: "monitor",
			monitor: { strategy: "semantic", semantic: { watches: [{ id: "a", condition: "a" }, { id: "b", condition: "b" }] }, persistence: { maxEvents: 2 } },
		}, undefined, undefined, { hasUI: false, cwd: "/tmp/project", ui: {}, sessionManager: { getSessionFile: () => undefined } } as any);
		getMonitorOptions()?.semantic?.onDecision({
			kind: "observation", route: "notify", model: "jev-1.13.0", observationHash: "private", generation: 3, latencyMs: 1,
			answers: { requestsInput: 0, requestsApproval: 0, presentsResult: 0, requiresIntervention: 0, meaningfulProgress: 0, watches: { a: 0.9, b: 0.9 }, attention: { value: "working", confidence: 0.9, probabilities: { working: 0.9, waiting_input: 0.02, waiting_approval: 0.02, presenting_result: 0.02, blocked: 0.02, other: 0.02 } } },
		});
		await waitForMonitorNotification(); await new Promise((resolve) => setImmediate(resolve));
		expect(sendMessage).toHaveBeenCalledTimes(2);
		expect(active.kill).toHaveBeenCalledTimes(1);
	});

	it("keeps result-ready separate from one natural lifecycle completion", async () => {
		const { toolDef, getMonitorOptions, getMonitorCompleteCallback, waitForMonitorNotification, setActiveSession, sendMessage, eventsEmit } = await setupHarness();
		const active = { kill: vi.fn() }; setActiveSession(active);
		await toolDef.execute("semantic-result", {
			command: "agent", mode: "monitor", monitor: { strategy: "semantic", semantic: { attention: true } },
		}, undefined, undefined, { hasUI: false, cwd: "/tmp/project", ui: {}, sessionManager: { getSessionFile: () => undefined } } as any);
		getMonitorOptions()?.semantic?.onDecision({
			kind: "observation", route: "notify", model: "jev-1.13.0", observationHash: "private", generation: 5, latencyMs: 1,
			answers: { requestsInput: 0, requestsApproval: 0, presentsResult: 0.95, requiresIntervention: 0, meaningfulProgress: 0, watches: {}, attention: { value: "presenting_result", confidence: 0.9, probabilities: { working: 0.02, waiting_input: 0.02, waiting_approval: 0.02, presenting_result: 0.9, blocked: 0.02, other: 0.02 } } },
		});
		await waitForMonitorNotification();
		expect(active.kill).not.toHaveBeenCalled();
		expect(sendMessage).toHaveBeenCalledTimes(1);
		getMonitorCompleteCallback()?.({ exitCode: 0, completionReason: "exited" });
		expect(sendMessage).toHaveBeenCalledTimes(2);
		expect(sendMessage.mock.calls.map((call) => call[0].customType)).toEqual(["interactive-shell-monitor-event", "interactive-shell-monitor-lifecycle"]);
		expect(eventsEmit).toHaveBeenCalledTimes(2);
	});

	it("delivers one confident result event without a duplicate Noul and keeps confident ambiguity quiet", async () => {
		const { toolDef, getMonitorOptions, waitForMonitorNotification, setActiveSession, sendMessage } = await setupHarness();
		setActiveSession({ kill: vi.fn() });
		await toolDef.execute("semantic-attention-sequence", {
			command: "agent", mode: "monitor", monitor: { strategy: "semantic", semantic: { attention: true } },
		}, undefined, undefined, { hasUI: false, cwd: "/tmp/project", ui: {}, sessionManager: { getSessionFile: () => undefined } } as any);
		const onDecision = getMonitorOptions()?.semantic?.onDecision;
		const resultDecision = {
			kind: "observation" as const, route: "notify" as const, model: "jev-1.13.0", observationHash: "private", generation: 1, latencyMs: 1,
			answers: { requestsInput: 0, requestsApproval: 0, presentsResult: 0.05, requiresIntervention: 0, meaningfulProgress: 0, watches: {}, attention: { value: "presenting_result" as const, confidence: 0.9, probabilities: { working: 0.02, waiting_input: 0.02, waiting_approval: 0.02, presenting_result: 0.9, blocked: 0.02, other: 0.02 } } },
		};
		onDecision?.(resultDecision);
		await waitForMonitorNotification();
		onDecision?.({ ...resultDecision, generation: 2 });
		await new Promise((resolve) => setImmediate(resolve));
		onDecision?.({ ...resultDecision, generation: 3, route: "uncertain", answers: { ...resultDecision.answers, attention: { value: "other", confidence: 0.9, probabilities: { working: 0.02, waiting_input: 0.02, waiting_approval: 0.02, presenting_result: 0.02, blocked: 0.02, other: 0.9 } } } });
		await new Promise((resolve) => setImmediate(resolve));
		onDecision?.({ ...resultDecision, generation: 4 });
		await new Promise((resolve) => setImmediate(resolve));
		expect(sendMessage).toHaveBeenCalledTimes(2);
		expect(sendMessage.mock.calls[0]?.[0].content).toContain("result-ready");
		expect(sendMessage.mock.calls[1]?.[0].content).toContain("result-ready");
	});

	it("wires compiled monitor config and callback for monitor mode", async () => {
		const harness = await setupHarness();
		const result = await harness.toolDef.execute("call-1", {
			command: "npm test --watch",
			mode: "monitor",
			monitor: {
				strategy: "stream",
				triggers: [{ id: "error", regex: "/ERROR/i" }],
			},
		}, undefined, undefined, {
			hasUI: false,
			cwd: "/tmp/project",
			ui: {},
			sessionManager: { getSessionFile: () => "/tmp/project/session.jsonl" },
		} as any);

		expect(result.isError).not.toBe(true);
		expect(result.details.mode).toBe("monitor");
		expect(result.details.monitor.strategy).toBe("stream");
		expect(harness.getMonitorOptions()?.monitor?.strategy).toBe("stream");
		expect(harness.getMonitorOptions()?.monitor?.triggers[0]?.id).toBe("error");
		expect(typeof harness.getMonitorOptions()?.onMonitorEvent).toBe("function");
	});

	it("rejects legacy monitorFilter usage after hard cutover", async () => {
		const { toolDef } = await setupHarness();
		const result = await toolDef.execute("call-1", {
			command: "tail -f logs/dev.log",
			mode: "monitor",
			monitorFilter: "/tmp/log",
		}, undefined, undefined, {
			hasUI: false,
			cwd: "/tmp/project",
			ui: {},
			sessionManager: { getSessionFile: () => "/tmp/project/session.jsonl" },
		} as any);

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("monitorFilter was removed");
	});

	it("requires target session when querying monitorEvents", async () => {
		const { toolDef } = await setupHarness();
		const result = await toolDef.execute("call-1", {
			monitorEvents: true,
		}, undefined, undefined, {
			hasUI: false,
			cwd: "/tmp/project",
			ui: {},
			sessionManager: { getSessionFile: () => "/tmp/project/session.jsonl" },
		} as any);

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("monitorEvents requires monitorSessionId");
	});

	it("returns an error for unknown monitorEvents session ids", async () => {
		const { toolDef } = await setupHarness();
		const result = await toolDef.execute("call-1", {
			monitorEvents: true,
			monitorSessionId: "missing-monitor",
		}, undefined, undefined, {
			hasUI: false,
			cwd: "/tmp/project",
			ui: {},
			sessionManager: { getSessionFile: () => "/tmp/project/session.jsonl" },
		} as any);

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Monitor session not found: missing-monitor");
		expect(result.details).toEqual({
			sessionId: "missing-monitor",
			state: null,
			events: [],
			total: 0,
		});
	});

	it("wraps poll-diff monitor command into a recurring loop", async () => {
		const harness = await setupHarness();
		const result = await harness.toolDef.execute("call-1", {
			command: "echo health",
			mode: "monitor",
			monitor: {
				strategy: "poll-diff",
				triggers: [{ id: "changed", regex: "/./" }],
				poll: { intervalMs: 5000 },
			},
		}, undefined, undefined, {
			hasUI: false,
			cwd: "/tmp/project",
			ui: {},
			sessionManager: { getSessionFile: () => "/tmp/project/session.jsonl" },
		} as any);

		expect(result.isError).not.toBe(true);
		expect(harness.getLaunchedCommand()).toContain("while true; do");
		expect(harness.getLaunchedCommand()).toContain("echo health");
	});

	it("supports regex capture thresholds in triggers", async () => {
		const harness = await setupHarness();
		const result = await harness.toolDef.execute("call-1", {
			command: "echo prices",
			mode: "monitor",
			monitor: {
				strategy: "stream",
				triggers: [{
					id: "nvda-below",
					regex: "/NVDA:\\s*\\$?(\\d+(?:\\.\\d+)?)/",
					threshold: { captureGroup: 1, op: "lt", value: 120 },
				}],
			},
		}, undefined, undefined, {
			hasUI: false,
			cwd: "/tmp/project",
			ui: {},
			sessionManager: { getSessionFile: () => "/tmp/project/session.jsonl" },
		} as any);

		expect(result.isError).not.toBe(true);
		const match = harness.getMonitorOptions()?.monitor?.triggers[0]?.match;
		expect(match?.("NVDA: $119.50")).toBe("NVDA: $119.50");
		expect(match?.("NVDA: $120.50")).toBeUndefined();
	});

	it("rejects threshold config on literal triggers", async () => {
		const { toolDef } = await setupHarness();
		const result = await toolDef.execute("call-1", {
			command: "echo test",
			mode: "monitor",
			monitor: {
				strategy: "stream",
				triggers: [{
					id: "bad-threshold",
					literal: "NVDA",
					threshold: { captureGroup: 1, op: "lt", value: 120 },
				}],
			},
		}, undefined, undefined, {
			hasUI: false,
			cwd: "/tmp/project",
			ui: {},
			sessionManager: { getSessionFile: () => "/tmp/project/session.jsonl" },
		} as any);

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("threshold requires regex matcher");
	});

	it("requires fileWatch config for file-watch strategy", async () => {
		const { toolDef } = await setupHarness();
		const result = await toolDef.execute("call-1", {
			mode: "monitor",
			monitor: {
				strategy: "file-watch",
				triggers: [{ id: "pdf", regex: "/\\.pdf$/i" }],
			},
		}, undefined, undefined, {
			hasUI: false,
			cwd: "/tmp/project",
			ui: {},
			sessionManager: { getSessionFile: () => "/tmp/project/session.jsonl" },
		} as any);

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("monitor.fileWatch is required");
	});

	it("builds generated command for file-watch strategy", async () => {
		const harness = await setupHarness();
		const result = await harness.toolDef.execute("call-1", {
			mode: "monitor",
			monitor: {
				strategy: "file-watch",
				fileWatch: { path: "./uploads", recursive: true, events: ["rename"] },
				triggers: [{ id: "pdf", regex: "/\\.pdf$/i" }],
			},
		}, undefined, undefined, {
			hasUI: false,
			cwd: "/tmp/project",
			ui: {},
			sessionManager: { getSessionFile: () => "/tmp/project/session.jsonl" },
		} as any);

		expect(result.isError).not.toBe(true);
		expect(harness.getMonitorOptions()?.monitor?.strategy).toBe("file-watch");
		expect(harness.getLaunchedCommand()).toContain("-e");
		expect(harness.getLaunchedCommand()).toContain("uploads");
	});

	it("authorizes the generated file-watch command itself", async () => {
		const harness = await setupHarness({ launchRules: [] });
		const confirm = vi.fn(async (_title: string, message: string) => {
			expect(message).toContain("-e");
			expect(message).toContain("uploads");
			return true;
		});
		const result = await harness.toolDef.execute("file-watch-policy", {
			mode: "monitor",
			monitor: {
				strategy: "file-watch",
				fileWatch: { path: "./uploads", events: ["rename"] },
				triggers: [{ id: "pdf", regex: "/\\.pdf$/i" }],
			},
		}, undefined, undefined, { hasUI: true, cwd: "/tmp/project", ui: { confirm }, sessionManager: { getSessionFile: () => undefined } } as any);
		expect(result.isError).toBeUndefined();
		expect(confirm).toHaveBeenCalledOnce();
		expect(harness.getLaunchedCommand()).toContain("uploads");
	});

	it("rejects raw command mixed with file-watch before authorizing an unused identity", async () => {
		const harness = await setupHarness({ launchRules: [{ decision: "allow", operation: { kind: "launch-command", command: "npm test" } }] });
		const confirm = vi.fn(async () => true);
		const result = await harness.toolDef.execute("mixed-file-watch-command", {
			command: "npm test", mode: "monitor",
			monitor: { strategy: "file-watch", fileWatch: { path: "./uploads" }, triggers: [{ id: "changed", literal: "CHANGE" }] },
		}, undefined, undefined, { hasUI: true, cwd: "/tmp/project", ui: { confirm }, sessionManager: { getSessionFile: () => undefined } } as any);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("cannot be combined with command or spawn");
		expect(confirm).not.toHaveBeenCalled();
		expect(harness.getLaunchedCommand()).toBeUndefined();
		expect(harness.getSpawnResolutionOptions()).toEqual([]);
	});

	it("rejects a present empty command mixed with file-watch before authorization or construction", async () => {
		const harness = await setupHarness({ launchRules: [{ decision: "allow", operation: { kind: "launch-command", command: "other" } }] });
		const confirm = vi.fn(async () => true);
		const result = await harness.toolDef.execute("mixed-file-watch-empty-command", {
			command: "", mode: "monitor",
			monitor: { strategy: "file-watch", fileWatch: { path: "./uploads" }, triggers: [{ id: "changed", literal: "CHANGE" }] },
		}, undefined, undefined, { hasUI: true, cwd: "/tmp/project", ui: { confirm }, sessionManager: { getSessionFile: () => undefined } } as any);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("cannot be combined with command or spawn");
		expect(confirm).not.toHaveBeenCalled();
		expect(harness.getLaunchedCommand()).toBeUndefined();
		expect(harness.getSpawnResolutionOptions()).toEqual([]);
	});

	it("rejects structured spawn mixed with file-watch before worktree resolution", async () => {
		const harness = await setupHarness({ launchRules: [{ decision: "allow", operation: { kind: "launch-command", command: "codex" } }] });
		const result = await harness.toolDef.execute("mixed-file-watch-spawn", {
			spawn: { agent: "codex", worktree: true }, mode: "monitor",
			monitor: { strategy: "file-watch", fileWatch: { path: "./uploads" }, triggers: [{ id: "changed", literal: "CHANGE" }] },
		}, undefined, undefined, { hasUI: false, cwd: "/tmp/project", ui: {}, sessionManager: { getSessionFile: () => undefined } } as any);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("cannot be combined with command or spawn");
		expect(harness.getLaunchedCommand()).toBeUndefined();
		expect(harness.getSpawnResolutionOptions()).toEqual([]);
	});

	it("quotes Bash-sensitive file-watch paths literally", async () => {
		const harness = await setupHarness();
		const watchPath = "$HOME/it's `pwd`";
		const result = await harness.toolDef.execute("call-1", {
			mode: "monitor",
			monitor: {
				strategy: "file-watch",
				fileWatch: { path: watchPath, events: ["change"] },
				triggers: [{ id: "changed", literal: "CHANGE" }],
			},
		}, undefined, undefined, {
			hasUI: false,
			cwd: "/tmp/project",
			ui: {},
			sessionManager: { getSessionFile: () => "/tmp/project/session.jsonl" },
		} as any);

		expect(result.isError).not.toBe(true);
		const launchedCommand = harness.getLaunchedCommand() ?? "";
		expect(launchedCommand).toContain("$HOME/it");
		expect(launchedCommand).toContain("`pwd`");
		expect(launchedCommand).toContain("'\\''");
	});

	it("returns monitor status summaries", async () => {
		const harness = await setupHarness();
		const started = await harness.toolDef.execute("call-1", {
			command: "npm test --watch",
			mode: "monitor",
			monitor: {
				strategy: "stream",
				triggers: [{ id: "fail", literal: "FAIL" }],
			},
		}, undefined, undefined, {
			hasUI: false,
			cwd: "/tmp/project",
			ui: {},
			sessionManager: { getSessionFile: () => "/tmp/project/session.jsonl" },
		} as any);

		expect(started.isError).not.toBe(true);
		const status = await harness.toolDef.execute("call-2", {
			monitorStatus: true,
			monitorSessionId: "monitor-1",
		}, undefined, undefined, {
			hasUI: false,
			cwd: "/tmp/project",
			ui: {},
			sessionManager: { getSessionFile: () => "/tmp/project/session.jsonl" },
		} as any);

		expect(status.isError).not.toBe(true);
		expect(status.content[0].text).toContain("Monitor state for monitor-1");
		expect(status.content[0].text).toContain("Status: running");
	});

	it("supports monitorEvents filtering by trigger and sinceEventId", async () => {
		const harness = await setupHarness();
		await harness.toolDef.execute("call-1", {
			command: "npm test --watch",
			mode: "monitor",
			monitor: {
				strategy: "stream",
				triggers: [
					{ id: "fail", literal: "FAIL" },
					{ id: "warn", literal: "WARN" },
				],
			},
		}, undefined, undefined, {
			hasUI: false,
			cwd: "/tmp/project",
			ui: {},
			sessionManager: { getSessionFile: () => "/tmp/project/session.jsonl" },
		} as any);

		harness.getMonitorOptions()?.onMonitorEvent?.({
			strategy: "stream",
			triggerId: "fail",
			eventType: "fail",
			matchedText: "FAIL",
			lineOrDiff: "FAIL first",
			stream: "pty",
		});
		harness.getMonitorOptions()?.onMonitorEvent?.({
			strategy: "stream",
			triggerId: "warn",
			eventType: "warn",
			matchedText: "WARN",
			lineOrDiff: "WARN second",
			stream: "pty",
		});
		await new Promise((resolve) => setTimeout(resolve, 0));

		const filtered = await harness.toolDef.execute("call-2", {
			monitorEvents: true,
			monitorSessionId: "monitor-1",
			monitorTriggerId: "warn",
			monitorSinceEventId: 1,
		}, undefined, undefined, {
			hasUI: false,
			cwd: "/tmp/project",
			ui: {},
			sessionManager: { getSessionFile: () => "/tmp/project/session.jsonl" },
		} as any);

		expect(filtered.isError).not.toBe(true);
		expect(filtered.details.events).toHaveLength(1);
		expect(filtered.details.events[0]?.triggerId).toBe("warn");
		expect(filtered.details.sinceEventId).toBe(1);
		expect(filtered.details.triggerId).toBe("warn");
	});

	it("runs detector commands through the launch-resolved Bash and keeps JSON on stdin", async () => {
		const harness = await setupHarness();
		await harness.toolDef.execute("call-1", {
			command: "npm test --watch",
			mode: "monitor",
			monitor: {
				strategy: "stream",
				triggers: [{ id: "fail", literal: "FAIL" }],
				detector: { detectorCommand: "cat >/dev/null" },
			},
		}, undefined, undefined, {
			hasUI: false,
			cwd: "/tmp/project",
			ui: {},
			sessionManager: { getSessionFile: () => "/tmp/project/session.jsonl" },
		} as any);

		harness.getMonitorOptions()?.onMonitorEvent?.({
			strategy: "stream",
			triggerId: "fail",
			eventType: "fail",
			matchedText: "FAIL",
			lineOrDiff: "FAIL first",
			stream: "pty",
		});
		await harness.waitForMonitorNotification();

		const launch = harness.getDetectorLaunch();
		expect(launch).toMatchObject({
			shell: "/bin/bash",
			args: ["-c", "cat >/dev/null"],
			cwd: "/tmp/project",
		});
		expect(JSON.parse(launch?.stdin ?? "")).toMatchObject({
			sessionId: "monitor-1",
			triggerId: "fail",
			matchedText: "FAIL",
			lineOrDiff: "FAIL first",
		});
	});

	it("rejects detectorCommand decisions with invalid shapes", async () => {
		const harness = await setupHarness({ detectorStdout: "[]" });
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await harness.toolDef.execute("call-1", {
				command: "npm test --watch",
				mode: "monitor",
				monitor: {
					strategy: "stream",
					triggers: [{ id: "fail", literal: "FAIL" }],
					detector: { detectorCommand: "printf '[]'" },
				},
			}, undefined, undefined, {
				hasUI: false,
				cwd: "/tmp/project",
				ui: {},
				sessionManager: { getSessionFile: () => "/tmp/project/session.jsonl" },
			} as any);

			harness.getMonitorOptions()?.onMonitorEvent?.({
				strategy: "stream",
				triggerId: "fail",
				eventType: "fail",
				matchedText: "FAIL",
				lineOrDiff: "FAIL first",
				stream: "pty",
			});
			await new Promise((resolve) => setTimeout(resolve, 20));

			expect(harness.sendMessage).not.toHaveBeenCalledWith(
				expect.objectContaining({ customType: "interactive-shell-monitor-event" }),
				expect.any(Object),
			);
			expect(consoleError).toHaveBeenCalledWith(
				"interactive-shell: detectorCommand failed for monitor-1:",
				expect.objectContaining({ message: "detectorCommand returned invalid decision: expected boolean or object" }),
			);
		} finally {
			consoleError.mockRestore();
		}
	});

	it("includes dispatch completion fields in completed active-session query details", async () => {
		const harness = await setupHarness();
		harness.setActiveSession({
			retainAfterCompletion: true,
			getResult: vi.fn(() => ({
				exitCode: null,
				completionReason: "auto-close-quiet",
				timedOut: false,
				cancelled: true,
				completionOutput: { lines: ["done"], totalLines: 1, truncated: false },
			})),
			getOutput: vi.fn(() => ({ output: "done", truncated: false, totalBytes: 4, totalLines: 1, hasMore: false })),
			getStatus: vi.fn(() => "exited"),
			getRuntime: vi.fn(() => 1200),
			onComplete: vi.fn(),
		});

		const result = await harness.toolDef.execute("call-1", {
			sessionId: "dispatch-1",
		}, undefined, undefined, {
			hasUI: false,
			cwd: "/tmp/project",
			ui: {},
			sessionManager: { getSessionFile: () => "/tmp/project/session.jsonl" },
		} as any);

		expect(result.isError).not.toBe(true);
		expect(result.details).toMatchObject({
			sessionId: "dispatch-1",
			completionReason: "auto-close-quiet",
			timedOut: false,
			cancelled: true,
			completionOutput: { lines: ["done"], totalLines: 1, truncated: false },
		});
	});

	it("emits monitor lifecycle notification when monitor session completes", async () => {
		const harness = await setupHarness();
		await harness.toolDef.execute("call-1", {
			command: "npm test --watch",
			mode: "monitor",
			monitor: {
				strategy: "stream",
				triggers: [{ id: "fail", literal: "FAIL" }],
			},
		}, undefined, undefined, {
			hasUI: false,
			cwd: "/tmp/project",
			ui: {},
			sessionManager: { getSessionFile: () => "/tmp/project/session.jsonl" },
		} as any);

		harness.getMonitorCompleteCallback()?.({ exitCode: 1 });
		expect(harness.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ customType: "interactive-shell-monitor-lifecycle" }),
			expect.any(Object),
		);
	});
});
