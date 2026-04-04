import { afterEach, describe, expect, it, vi } from "vitest";

type OverlayOptionsCapture = { command: string; reason?: string } | null;

async function setupExtensionHarness(configOverrides: Partial<{ focusShortcut: string; spawnShortcut: string }> = {}) {
	let lastOverlayOptions: OverlayOptionsCapture = null;

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
				spawnShortcut: configOverrides.spawnShortcut ?? "alt+shift+p",
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
			constructor(_tui: unknown, _theme: unknown, options: { command: string; reason?: string }) {
				lastOverlayOptions = { command: options.command, reason: options.reason };
			}
		},
	}));

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
		registerTool: vi.fn(),
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
		setCustomResult: (result: any) => {
			nextCustomResult = result;
		},
		getLastOverlayOptions: () => lastOverlayOptions,
	};
}

describe("/spawn command and shortcut", () => {
	afterEach(() => {
		vi.doUnmock("@mariozechner/pi-coding-agent");
		vi.doUnmock("@mariozechner/pi-tui");
		vi.doUnmock("../config.js");
		vi.doUnmock("../overlay-component.js");
	});

	it("/spawn defaults to a fresh pi session", async () => {
		const harness = await setupExtensionHarness();
		const spawn = harness.commands.get("spawn");
		expect(spawn).toBeDefined();

		await spawn!.handler("", harness.ctx as any);
		expect(harness.custom).toHaveBeenCalledTimes(1);
		expect(harness.getLastOverlayOptions()).toMatchObject({
			command: "pi",
			reason: "spawn pi (fresh session)",
		});
	});

	it("/spawn fork quotes the current session file safely for the active shell", async () => {
		const harness = await setupExtensionHarness();
		harness.ctx.sessionManager.getSessionFile = () => "/tmp/project/it's session.jsonl";
		const spawn = harness.commands.get("spawn");
		expect(spawn).toBeDefined();

		await spawn!.handler("fork", harness.ctx as any);
		expect(harness.custom).toHaveBeenCalledTimes(1);
		const expectedForkArg = process.platform === "win32"
			? '"/tmp/project/it\'s session.jsonl"'
			: "'/tmp/project/it'\\''s session.jsonl'";
		expect(harness.getLastOverlayOptions()).toMatchObject({
			command: `pi --fork ${expectedForkArg}`,
			reason: "spawn pi (fork current session)",
		});
	});

	it("/spawn fork errors when current session is not persisted", async () => {
		const harness = await setupExtensionHarness();
		harness.ctx.sessionManager.getSessionFile = () => undefined;
		const spawn = harness.commands.get("spawn");
		expect(spawn).toBeDefined();

		await spawn!.handler("fork", harness.ctx as any);
		expect(harness.custom).not.toHaveBeenCalled();
		expect(harness.notify).toHaveBeenCalledWith(
			"Cannot fork the current session because it is not persisted (likely --no-session mode).",
			"error",
		);
	});

	it("spawnShortcut config registers the fresh pi overlay shortcut", async () => {
		const harness = await setupExtensionHarness();
		const shortcut = harness.shortcuts.get("alt+shift+p");
		expect(shortcut).toBeDefined();

		await shortcut!.handler(harness.ctx as any);
		expect(harness.custom).toHaveBeenCalledTimes(1);
		expect(harness.getLastOverlayOptions()).toMatchObject({ command: "pi" });
	});

	it("non-default spawnShortcut is honored", async () => {
		const harness = await setupExtensionHarness({ spawnShortcut: "alt+shift+s" });
		expect(harness.shortcuts.get("alt+shift+s")).toBeDefined();
		expect(harness.shortcuts.get("alt+shift+p")).toBeUndefined();
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
