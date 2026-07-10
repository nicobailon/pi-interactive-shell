import { afterEach, describe, expect, it, vi } from "vitest";

type SessionOptionsCapture = { command: string; reason?: string; cwd?: string } | null;

type SpawnConfigOverrides = {
	focusShortcut?: string;
	pendingSession?: boolean;
	killSpy?: ReturnType<typeof vi.fn>;
	spawn?: {
		defaultAgent?: "pi" | "codex" | "claude" | "cursor";
		shortcut?: string;
		commands?: Partial<Record<"pi" | "codex" | "claude" | "cursor", string>>;
		defaultArgs?: Partial<Record<"pi" | "codex" | "claude" | "cursor", string[]>>;
		worktree?: boolean;
		worktreeBaseDir?: string;
	};
};

async function setupExtensionHarness(configOverrides: SpawnConfigOverrides = {}) {
	let lastSessionOptions: SessionOptionsCapture = null;
	let registeredTool: { execute: (...args: any[]) => Promise<any> } | null = null;

	vi.resetModules();
	vi.doMock("@mariozechner/pi-coding-agent", () => ({
		getAgentDir: () => "/tmp/pi-agent",
	}));
	vi.doMock("@mariozechner/pi-tui", () => ({
		matchesKey: () => false,
		truncateToWidth: (value: string) => value,
		visibleWidth: (value: string) => value.length,
	}));
	vi.doMock("../config.js", async () => {
		const actual = await vi.importActual<typeof import("../config.js")>("../config.js");
		return {
			...actual,
			loadConfig: vi.fn(() => ({
				focusShortcut: configOverrides.focusShortcut ?? "alt+shift+f",
				spawn: {
					defaultAgent: configOverrides.spawn?.defaultAgent ?? "pi",
					shortcut: configOverrides.spawn?.shortcut ?? "alt+shift+p",
					commands: {
						pi: configOverrides.spawn?.commands?.pi ?? "pi",
						codex: configOverrides.spawn?.commands?.codex ?? "codex",
						claude: configOverrides.spawn?.commands?.claude ?? "claude",
						cursor: configOverrides.spawn?.commands?.cursor ?? "agent",
					},
					defaultArgs: {
						pi: configOverrides.spawn?.defaultArgs?.pi ?? [],
						codex: configOverrides.spawn?.defaultArgs?.codex ?? [],
						claude: configOverrides.spawn?.defaultArgs?.claude ?? [],
						cursor: configOverrides.spawn?.defaultArgs?.cursor ?? ["--model", "composer-2-fast"],
					},
					worktree: configOverrides.spawn?.worktree ?? false,
					worktreeBaseDir: configOverrides.spawn?.worktreeBaseDir,
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
				handoffSnapshotEnabled: false,
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
			exited = configOverrides.pendingSession === true ? false : true;
			exitCode = configOverrides.pendingSession === true ? null : 0;
			signal = undefined;
			pid = 123;
			cols = 120;
			rows = 40;
			private exitListeners: Array<() => void> = [];
			constructor(options: { command: string; reason?: string; cwd?: string }) {
				lastSessionOptions = { command: options.command, reason: options.reason, cwd: options.cwd };
			}
			setEventHandlers() {}
			addDataListener() {
				return () => {};
			}
			addExitListener(cb: () => void) {
				this.exitListeners.push(cb);
				if (!configOverrides.pendingSession) queueMicrotask(cb);
				return () => {};
			}
			write() {}
			sendKeys() {}
			paste() {}
			focus() {}
			resize() {}
			getViewportLines() {
				return Promise.resolve([]);
			}
			getTailLines() {
				return Promise.resolve({ lines: [], totalLinesInBuffer: 0, truncatedByChars: false });
			}
			getRawStream() {
				return "";
			}
			getLogSlice() {
				return Promise.resolve({ slice: "", totalLines: 0, totalChars: 0, sliceLineCount: 0 });
			}
			scrollUp() {}
			scrollDown() {}
			scrollToBottom() {}
			isScrolledUp() {
				return false;
			}
			kill() {
				configOverrides.killSpy?.();
				this.exited = true;
				this.exitCode = null;
				for (const cb of this.exitListeners) cb();
			}
			dispose() {}
		},
	}));
	vi.doMock("../spawn.js", async () => {
		const actual = await vi.importActual<typeof import("../spawn.js")>("../spawn.js");
		return {
			...actual,
			resolveSpawn: vi.fn((config, cwd, request, getSessionFile) => actual.resolveSpawn(config, cwd, request, getSessionFile)),
		};
	});

	const extensionModule = await import("../index.js");
	const extension = extensionModule.default;

	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> | void }>();
	const shortcuts = new Map<string, { handler: (ctx: any) => Promise<void> | void }>();
	let nextCustomResult: any = { exitCode: 0, backgrounded: false, cancelled: false };

	const pi = {
		registerShortcut: vi.fn((shortcut: string, options: { handler: (ctx: any) => Promise<void> | void }) => {
			shortcuts.set(shortcut, options);
		}),
		registerCommand: vi.fn((name: string, options: { handler: (args: string, ctx: any) => Promise<void> | void }) => {
			commands.set(name, options);
		}),
		registerTool: vi.fn((tool: any) => {
			registeredTool = tool;
		}),
		on: vi.fn(),
		events: { emit: vi.fn() },
		sendMessage: vi.fn(),
	};

	extension(pi as any);

	const notify = vi.fn();
	const custom = vi.fn(async (factory: (tui: any, theme: any, kb: any, done: (result: unknown) => void) => unknown) => {
		const done = vi.fn();
		factory({ terminal: { columns: 120, rows: 40 }, requestRender: vi.fn() }, { fg: (_color: string, text: string) => text }, {}, done);
		return nextCustomResult;
	});

	const ctx = {
		ui: { notify, custom },
		cwd: "/tmp/project",
		hasUI: true,
		sessionManager: {
			getSessionFile: () => "/tmp/project/session.jsonl",
		},
	};

	return {
		commands,
		shortcuts,
		ctx,
		notify,
		custom,
		pi,
		getTool: () => registeredTool,
		setCustomResult: (result: any) => {
			nextCustomResult = result;
		},
		getLastSessionOptions: () => lastSessionOptions,
	};
}

describe("/spawn command, shortcut, and tool spawn", () => {
	afterEach(() => {
		vi.doUnmock("@mariozechner/pi-coding-agent");
		vi.doUnmock("@mariozechner/pi-tui");
		vi.doUnmock("../config.js");
		vi.doUnmock("../kitty-session.js");
		vi.doUnmock("../spawn.js");
	});

	it("/spawn defaults to the configured default agent", async () => {
		const harness = await setupExtensionHarness({ spawn: { defaultAgent: "codex" } });
		const spawn = harness.commands.get("spawn");
		expect(spawn).toBeDefined();

		await spawn!.handler("", harness.ctx as any);
		expect(harness.getLastSessionOptions()).toMatchObject({
			command: "codex",
		});
	});

	it("/spawn accepts explicit one-shot agent overrides", async () => {
		const harness = await setupExtensionHarness({ spawn: { defaultAgent: "pi" } });
		const spawn = harness.commands.get("spawn");
		expect(spawn).toBeDefined();

		await spawn!.handler("claude", harness.ctx as any);
		expect(harness.getLastSessionOptions()).toMatchObject({
			command: "claude",
		});
	});

	it("/spawn cursor resolves through the cursor command mapping", async () => {
		const harness = await setupExtensionHarness({ spawn: { defaultAgent: "pi" } });
		const spawn = harness.commands.get("spawn");
		expect(spawn).toBeDefined();

		await spawn!.handler("cursor", harness.ctx as any);
		expect(harness.getLastSessionOptions()).toMatchObject({
			command: "agent --model composer-2-fast",
		});
	});

	it("/spawn supports monitored prompt-bearing launches with the shared resolver", async () => {
		const harness = await setupExtensionHarness({ spawn: { defaultAgent: "pi" } });
		const spawn = harness.commands.get("spawn");
		expect(spawn).toBeDefined();

		await spawn!.handler('"review the diffs" --dispatch', harness.ctx as any);
		expect(harness.getLastSessionOptions()).toMatchObject({
			command: "pi 'review the diffs'",
		});
		expect(harness.notify).not.toHaveBeenCalledWith(expect.stringContaining("requires"), "error");
	});

	it("/spawn pi fork quotes the current session file safely for the active shell", async () => {
		const harness = await setupExtensionHarness();
		harness.ctx.sessionManager.getSessionFile = () => "/tmp/project/it's session.jsonl";
		const spawn = harness.commands.get("spawn");
		expect(spawn).toBeDefined();

		await spawn!.handler("pi fork", harness.ctx as any);
		const expectedForkArg = process.platform === "win32" ? '"/tmp/project/it\'s session.jsonl"' : "'/tmp/project/it'\\''s session.jsonl'";
		expect(harness.getLastSessionOptions()).toMatchObject({
			command: `pi --fork ${expectedForkArg}`,
		});
	});

	it("/spawn codex fork fails with a clear pi-only error", async () => {
		const harness = await setupExtensionHarness();
		const spawn = harness.commands.get("spawn");
		expect(spawn).toBeDefined();

		await spawn!.handler("codex fork", harness.ctx as any);
		expect(harness.custom).not.toHaveBeenCalled();
		expect(harness.notify).toHaveBeenCalledWith("Cannot fork codex. Fork is only supported for pi sessions.", "error");
	});

	it("spawn shortcut uses the configured default agent and configured key", async () => {
		const harness = await setupExtensionHarness({
			spawn: { defaultAgent: "claude", shortcut: "alt+shift+s" },
		});
		const shortcut = harness.shortcuts.get("alt+shift+s");
		expect(shortcut).toBeDefined();
		expect(harness.shortcuts.get("alt+shift+p")).toBeUndefined();

		await shortcut!.handler(harness.ctx as any);
		expect(harness.getLastSessionOptions()).toMatchObject({ command: "claude" });
	});

	it("interactive_shell structured spawn uses the shared resolver", async () => {
		const harness = await setupExtensionHarness({
			spawn: { defaultAgent: "pi", commands: { codex: "/opt/codex/bin/codex" } },
		});
		const tool = harness.getTool();
		expect(tool).toBeTruthy();

		const result = await tool!.execute(
			"call-1",
			{
				spawn: { agent: "codex" },
				mode: "interactive",
			},
			undefined,
			undefined,
			harness.ctx as any,
		);

		expect(harness.getLastSessionOptions()).toMatchObject({
			command: "/opt/codex/bin/codex",
		});
		expect(result.content[0].text).toContain("Session ended successfully");
	});

	it("interactive_shell structured spawn supports native startup prompts", async () => {
		const harness = await setupExtensionHarness();
		const tool = harness.getTool();
		expect(tool).toBeTruthy();

		const result = await tool!.execute(
			"call-1",
			{
				spawn: { agent: "claude", prompt: "review the diffs" },
				mode: "dispatch",
			},
			undefined,
			undefined,
			harness.ctx as any,
		);

		expect(harness.getLastSessionOptions()).toMatchObject({
			command: "claude 'review the diffs'",
		});
		expect(result.content[0].text).toContain("Session dispatched");
	});

	it("interactive_shell structured spawn launches cursor prompts through the agent executable", async () => {
		const harness = await setupExtensionHarness();
		const tool = harness.getTool();
		expect(tool).toBeTruthy();

		const result = await tool!.execute(
			"call-1",
			{
				spawn: { agent: "cursor", prompt: "review the diffs" },
				mode: "dispatch",
			},
			undefined,
			undefined,
			harness.ctx as any,
		);

		expect(harness.getLastSessionOptions()).toMatchObject({
			command: "agent --model composer-2-fast 'review the diffs'",
		});
		expect(result.content[0].text).toContain("Session dispatched");
	});

	it("interactive_shell structured spawn keeps the same pi-only fork rule", async () => {
		const harness = await setupExtensionHarness();
		const tool = harness.getTool();
		expect(tool).toBeTruthy();

		const result = await tool!.execute(
			"call-1",
			{
				spawn: { agent: "claude", mode: "fork" },
				mode: "interactive",
			},
			undefined,
			undefined,
			harness.ctx as any,
		);

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toBe("Cannot fork claude. Fork is only supported for pi sessions.");
	});

	it("interactive_shell preserves the full missing-input guidance for new sessions", async () => {
		const harness = await setupExtensionHarness();
		const tool = harness.getTool();
		expect(tool).toBeTruthy();

		const result = await tool!.execute("call-1", {}, undefined, undefined, harness.ctx as any);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toBe(
			"One of 'command', 'spawn', 'sessionId', 'attach', 'listBackground', or 'dismissBackground' is required.",
		);
	});

	it("interactive_shell cancels an interactive session when the tool signal aborts", async () => {
		const killSpy = vi.fn();
		const harness = await setupExtensionHarness({ pendingSession: true, killSpy });
		const tool = harness.getTool();
		expect(tool).toBeTruthy();
		const controller = new AbortController();

		const pending = tool!.execute(
			"call-1",
			{
				command: "sleep 60",
				mode: "interactive",
			},
			controller.signal,
			undefined,
			harness.ctx as any,
		);
		await Promise.resolve();
		controller.abort();
		const result = await pending;

		expect(killSpy).toHaveBeenCalledTimes(1);
		expect(result.details.cancelled).toBe(true);
		expect(result.details.sessionId).toEqual(expect.any(String));
	});

	it("/spawn starts a kitty session via KittyTerminalSession", async () => {
		const harness = await setupExtensionHarness();
		const spawn = harness.commands.get("spawn");
		expect(spawn).toBeDefined();

		await spawn!.handler("", harness.ctx as any);
		expect(harness.custom).not.toHaveBeenCalled();
		expect(harness.getLastSessionOptions()).toMatchObject({ command: "pi" });
	});
});
