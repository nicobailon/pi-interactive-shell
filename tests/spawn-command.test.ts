import { afterEach, describe, expect, it, vi } from "vitest";

type OverlayOptionsCapture = { command: string; reason?: string; cwd?: string } | null;

type SpawnConfigOverrides = {
	focusShortcut?: string;
	spawn?: {
		defaultAgent?: "pi" | "codex" | "claude";
		shortcut?: string;
		commands?: Partial<Record<"pi" | "codex" | "claude", string>>;
		defaultArgs?: Partial<Record<"pi" | "codex" | "claude", string[]>>;
		worktree?: boolean;
		worktreeBaseDir?: string;
	};
};

async function setupExtensionHarness(configOverrides: SpawnConfigOverrides = {}) {
	let lastOverlayOptions: OverlayOptionsCapture = null;
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
				exitAutoCloseDelay: 10,
				overlayWidthPercent: 95,
				overlayHeightPercent: 60,
				focusShortcut: configOverrides.focusShortcut ?? "alt+shift+f",
				spawn: {
					defaultAgent: configOverrides.spawn?.defaultAgent ?? "pi",
					shortcut: configOverrides.spawn?.shortcut ?? "alt+shift+p",
					commands: {
						pi: configOverrides.spawn?.commands?.pi ?? "pi",
						codex: configOverrides.spawn?.commands?.codex ?? "codex",
						claude: configOverrides.spawn?.commands?.claude ?? "claude",
					},
					defaultArgs: {
						pi: configOverrides.spawn?.defaultArgs?.pi ?? [],
						codex: configOverrides.spawn?.defaultArgs?.codex ?? [],
						claude: configOverrides.spawn?.defaultArgs?.claude ?? [],
					},
					worktree: configOverrides.spawn?.worktree ?? false,
					worktreeBaseDir: configOverrides.spawn?.worktreeBaseDir,
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
	vi.doMock("../overlay-component.js", () => ({
		InteractiveShellOverlay: class MockInteractiveShellOverlay {
			constructor(_tui: unknown, _theme: unknown, options: { command: string; reason?: string; cwd?: string }) {
				lastOverlayOptions = { command: options.command, reason: options.reason, cwd: options.cwd };
			}
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
		factory(
			{ terminal: { columns: 120, rows: 40 }, requestRender: vi.fn() },
			{ fg: (_color: string, text: string) => text },
			{},
			done,
		);
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
		getLastOverlayOptions: () => lastOverlayOptions,
	};
}

describe("/spawn command, shortcut, and tool spawn", () => {
	afterEach(() => {
		vi.doUnmock("@mariozechner/pi-coding-agent");
		vi.doUnmock("@mariozechner/pi-tui");
		vi.doUnmock("../config.js");
		vi.doUnmock("../overlay-component.js");
		vi.doUnmock("../spawn.js");
	});

	it("/spawn defaults to the configured default agent", async () => {
		const harness = await setupExtensionHarness({ spawn: { defaultAgent: "codex" } });
		const spawn = harness.commands.get("spawn");
		expect(spawn).toBeDefined();

		await spawn!.handler("", harness.ctx as any);
		expect(harness.custom).toHaveBeenCalledTimes(1);
		expect(harness.getLastOverlayOptions()).toMatchObject({
			command: "codex",
			reason: "spawn codex (fresh session)",
		});
	});

	it("/spawn accepts explicit one-shot agent overrides", async () => {
		const harness = await setupExtensionHarness({ spawn: { defaultAgent: "pi" } });
		const spawn = harness.commands.get("spawn");
		expect(spawn).toBeDefined();

		await spawn!.handler("claude", harness.ctx as any);
		expect(harness.getLastOverlayOptions()).toMatchObject({
			command: "claude",
			reason: "spawn claude (fresh session)",
		});
	});

	it("/spawn pi fork quotes the current session file safely for the active shell", async () => {
		const harness = await setupExtensionHarness();
		harness.ctx.sessionManager.getSessionFile = () => "/tmp/project/it's session.jsonl";
		const spawn = harness.commands.get("spawn");
		expect(spawn).toBeDefined();

		await spawn!.handler("pi fork", harness.ctx as any);
		const expectedForkArg = process.platform === "win32"
			? '"/tmp/project/it\'s session.jsonl"'
			: "'/tmp/project/it'\\''s session.jsonl'";
		expect(harness.getLastOverlayOptions()).toMatchObject({
			command: `pi --fork ${expectedForkArg}`,
			reason: "spawn pi (fork current session)",
		});
	});

	it("/spawn codex fork fails with a clear pi-only error", async () => {
		const harness = await setupExtensionHarness();
		const spawn = harness.commands.get("spawn");
		expect(spawn).toBeDefined();

		await spawn!.handler("codex fork", harness.ctx as any);
		expect(harness.custom).not.toHaveBeenCalled();
		expect(harness.notify).toHaveBeenCalledWith(
			"Cannot fork codex. Fork is only supported for pi sessions.",
			"error",
		);
	});

	it("spawn shortcut uses the configured default agent and configured key", async () => {
		const harness = await setupExtensionHarness({
			spawn: { defaultAgent: "claude", shortcut: "alt+shift+s" },
		});
		const shortcut = harness.shortcuts.get("alt+shift+s");
		expect(shortcut).toBeDefined();
		expect(harness.shortcuts.get("alt+shift+p")).toBeUndefined();

		await shortcut!.handler(harness.ctx as any);
		expect(harness.getLastOverlayOptions()).toMatchObject({ command: "claude" });
	});

	it("interactive_shell structured spawn uses the shared resolver", async () => {
		const harness = await setupExtensionHarness({
			spawn: { defaultAgent: "pi", commands: { codex: "/opt/codex/bin/codex" } },
		});
		const tool = harness.getTool();
		expect(tool).toBeTruthy();

		const result = await tool!.execute("call-1", {
			spawn: { agent: "codex" },
			mode: "interactive",
		}, undefined, undefined, harness.ctx as any);

		expect(harness.custom).toHaveBeenCalledTimes(1);
		expect(harness.getLastOverlayOptions()).toMatchObject({
			command: "/opt/codex/bin/codex",
			reason: "spawn codex (fresh session)",
		});
		expect(result.content[0].text).toContain("Session ended successfully");
	});

	it("interactive_shell structured spawn keeps the same pi-only fork rule", async () => {
		const harness = await setupExtensionHarness();
		const tool = harness.getTool();
		expect(tool).toBeTruthy();

		const result = await tool!.execute("call-1", {
			spawn: { agent: "claude", mode: "fork" },
			mode: "interactive",
		}, undefined, undefined, harness.ctx as any);

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toBe("Cannot fork claude. Fork is only supported for pi sessions.");
	});

	it("/spawn forwards transfer output back into the main agent conversation", async () => {
		const harness = await setupExtensionHarness();
		harness.setCustomResult({
			exitCode: 0,
			backgrounded: false,
			cancelled: false,
			transferred: {
				lines: ["line 1", "line 2"],
				totalLines: 2,
				truncated: false,
			},
		});
		const spawn = harness.commands.get("spawn");
		expect(spawn).toBeDefined();

		await spawn!.handler("", harness.ctx as any);
		expect(harness.pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
			customType: "interactive-shell-transfer",
			display: true,
			content: expect.stringContaining("Interactive shell output transferred (2 lines):"),
		}), { triggerTurn: true });
	});
});
