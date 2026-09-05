import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

type MonitorOptionsCapture = {
	monitor?: {
		strategy: "stream" | "poll-diff" | "file-watch";
		triggers: Array<{ id: string; match: (input: string) => string | undefined; cooldownMs?: number }>;
		pollIntervalMs: number;
		dedupeExactLine: boolean;
		cooldownMs?: number;
	};
	onMonitorEvent?: (event: unknown) => void | Promise<void>;
} | null;

type DetectorLaunchCapture = {
	shell: string;
	args: string[];
	cwd?: string;
	stdin: string;
} | null;

async function setupHarness(options: { detectorStdout?: string } = {}) {
	let toolDef: any;
	let monitorOptions: MonitorOptionsCapture = null;
	let detectorLaunch: DetectorLaunchCapture = null;
	let launchedCommand: string | undefined;
	let monitorCompleteCallback: ((info: unknown) => void) | undefined;
	let activeSession: unknown;
	const sendMessage = vi.fn();

	vi.resetModules();
	vi.doMock("@earendil-works/pi-coding-agent", () => ({
		getAgentDir: () => "/tmp/pi-agent",
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
			})),
		};
	});
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
			constructor(
				_session: unknown,
				_config: unknown,
				options: MonitorOptionsCapture,
				onComplete: (info: unknown) => void,
			) {
				monitorOptions = options;
				monitorCompleteCallback = onComplete;
			}
			getResult() { return undefined; }
			registerCompleteCallback() {}
			dispose() { this.disposed = true; }
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
		events: { emit: vi.fn() },
		sendMessage,
	} as any);

	return {
		toolDef,
		getMonitorOptions: () => monitorOptions,
		getDetectorLaunch: () => detectorLaunch,
		getLaunchedCommand: () => launchedCommand,
		getMonitorCompleteCallback: () => monitorCompleteCallback,
		setActiveSession: (session: unknown) => { activeSession = session; },
		sendMessage,
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
		await new Promise((resolve) => setTimeout(resolve, 20));

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
