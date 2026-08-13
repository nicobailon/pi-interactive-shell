import { afterEach, describe, expect, it, vi } from "vitest";

const baseConfig = {
	defer: false,
	exitAutoCloseDelay: 10,
	overlayWidthPercent: 95,
	overlayHeightPercent: 60,
	overlayAnchor: "center",
	focusShortcut: "alt+shift+f",
	spawn: {
		defaultAgent: "pi",
		shortcut: "alt+shift+p",
		commands: { pi: "pi" },
		defaultArgs: { pi: [] },
		worktree: false,
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
};

async function setupHarness(defer: boolean, dynamicApis = true, allowedTools = ["interactive_shell", "enable_interactive_shell"]) {
	vi.resetModules();
	vi.doMock("@earendil-works/pi-coding-agent", () => ({
		getAgentDir: () => "/tmp/pi-agent",
	}));
	vi.doMock("@earendil-works/pi-tui", () => ({
		isKeyRelease: () => false,
		isKeyRepeat: () => false,
		matchesKey: () => false,
		truncateToWidth: (value: string) => value,
		visibleWidth: (value: string) => value.length,
	}));
	vi.doMock("../config.ts", () => ({
		loadConfig: () => ({ ...baseConfig, defer }),
	}));
	vi.doMock("../overlay-component.ts", () => ({ InteractiveShellOverlay: class {} }));
	vi.doMock("../reattach-overlay.ts", () => ({ ReattachOverlay: class {} }));
	vi.doMock("../pty-session.ts", () => ({ PtyTerminalSession: class {} }));
	vi.doMock("../headless-monitor.ts", () => ({ HeadlessDispatchMonitor: class {} }));
	vi.doMock("../background-widget.ts", () => ({ setupBackgroundWidget: () => () => {} }));
	vi.doMock("../session-manager.ts", () => ({
		sessionManager: {
			killAll: vi.fn(),
			onChange: vi.fn(() => () => {}),
			list: vi.fn(() => []),
		},
		generateSessionId: () => "test-session",
	}));

	const { default: extension } = await import("../index.ts");
	const tools = new Map<string, any>();
	const handlers = new Map<string, any>();
	let activeTools = ["read"];
	const setActiveTools = vi.fn((names: string[]) => {
		activeTools = names.filter((name) => !["interactive_shell", "enable_interactive_shell"].includes(name) || allowedTools.includes(name));
	});
	const pi: Record<string, any> = {
		registerShortcut: vi.fn(),
		registerCommand: vi.fn(),
		registerTool: vi.fn((tool: any) => {
			tools.set(tool.name, tool);
			activeTools.push(tool.name);
		}),
		on: vi.fn((event: string, handler: any) => handlers.set(event, handler)),
		events: { emit: vi.fn() },
		sendMessage: vi.fn(),
	};
	if (dynamicApis) {
		pi.getActiveTools = vi.fn(() => [...activeTools]);
		pi.setActiveTools = setActiveTools;
	}

	extension(pi as any);
	return { pi, tools, handlers, getActiveTools: () => activeTools, setActiveTools };
}

const sessionContext = {
	ui: {
		notify: vi.fn(),
		onTerminalInput: vi.fn(() => () => {}),
	},
};

describe("deferred interactive_shell loading", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.doUnmock("@earendil-works/pi-coding-agent");
		vi.doUnmock("@earendil-works/pi-tui");
		vi.doUnmock("../config.ts");
		vi.doUnmock("../overlay-component.ts");
		vi.doUnmock("../reattach-overlay.ts");
		vi.doUnmock("../pty-session.ts");
		vi.doUnmock("../headless-monitor.ts");
		vi.doUnmock("../background-widget.ts");
		vi.doUnmock("../session-manager.ts");
	});

	it("keeps the current eager tool contract by default", async () => {
		const harness = await setupHarness(false);

		expect([...harness.tools.keys()]).toEqual(["interactive_shell"]);
		expect(harness.tools.get("interactive_shell").promptSnippet).toContain("submit=true");
		expect(harness.setActiveTools).not.toHaveBeenCalled();
	});

	it("starts deferred sessions with only the loader and re-enables the tool additively", async () => {
		const harness = await setupHarness(true);
		const sessionStart = harness.handlers.get("session_start");

		expect([...harness.tools.keys()]).toEqual(["interactive_shell", "enable_interactive_shell"]);
		expect(harness.tools.get("interactive_shell").promptSnippet).toBeUndefined();
		expect(harness.pi.registerCommand).toHaveBeenCalledWith("spawn", expect.anything());
		expect(harness.pi.registerCommand).toHaveBeenCalledWith("attach", expect.anything());
		expect(harness.pi.registerCommand).toHaveBeenCalledWith("dismiss", expect.anything());
		expect(harness.pi.registerShortcut).toHaveBeenCalledTimes(2);

		sessionStart({ reason: "startup" }, sessionContext);
		expect(harness.getActiveTools()).toEqual(["read", "enable_interactive_shell"]);

		const loader = harness.tools.get("enable_interactive_shell");
		const result = await loader.execute("load-1", {}, undefined, undefined, sessionContext);
		expect(harness.getActiveTools()).toEqual(["read", "enable_interactive_shell", "interactive_shell"]);
		expect(result.content[0].text).toContain("next turn");
		expect(result.details.added).toEqual(["interactive_shell"]);

		const callsAfterActivation = harness.setActiveTools.mock.calls.length;
		const repeated = await loader.execute("load-2", {}, undefined, undefined, sessionContext);
		expect(harness.setActiveTools).toHaveBeenCalledTimes(callsAfterActivation);
		expect(repeated.details.added).toEqual([]);
	});

	it("keeps interactive_shell active when a CLI tool allowlist excludes the loader", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const harness = await setupHarness(true, true, ["interactive_shell"]);
		const sessionStart = harness.handlers.get("session_start");

		sessionStart({ reason: "startup" }, sessionContext);
		expect(harness.getActiveTools()).toEqual(["read", "interactive_shell"]);
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("include both enable_interactive_shell and interactive_shell"));
	});

	it("fails clearly when a CLI tool allowlist excludes interactive_shell", async () => {
		const harness = await setupHarness(true, true, ["enable_interactive_shell"]);
		const sessionStart = harness.handlers.get("session_start");
		const loader = harness.tools.get("enable_interactive_shell");

		sessionStart({ reason: "startup" }, sessionContext);
		await expect(loader.execute("load-1", {}, undefined, undefined, sessionContext)).rejects.toThrow(
			"include both enable_interactive_shell and interactive_shell",
		);
	});

	it("resets the interactive tool to inactive on every session start", async () => {
		const harness = await setupHarness(true);
		const sessionStart = harness.handlers.get("session_start");
		const loader = harness.tools.get("enable_interactive_shell");

		sessionStart({ reason: "startup" }, sessionContext);
		await loader.execute("load-1", {}, undefined, undefined, sessionContext);
		expect(harness.getActiveTools()).toContain("interactive_shell");

		sessionStart({ reason: "fork" }, sessionContext);
		expect(harness.getActiveTools()).toEqual(["read", "enable_interactive_shell"]);
	});

	it("warns and stays eager when the active-tool APIs are unavailable", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const harness = await setupHarness(true, false);

		expect([...harness.tools.keys()]).toEqual(["interactive_shell"]);
		expect(harness.tools.get("interactive_shell").promptSnippet).toContain("submit=true");
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("deferred loading requires"));
	});
});
