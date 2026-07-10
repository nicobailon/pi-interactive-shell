import { afterEach, describe, expect, it, vi } from "vitest";

async function setupHarness() {
	const activeSession: any = {
		write: vi.fn(),
		paste: vi.fn(),
		sendKeys: vi.fn(),
	};
	const sessionManager = {
		getActive: vi.fn(() => activeSession),
		writeToActive: vi.fn(() => true),
		setActiveUpdateInterval: vi.fn(() => false),
		setActiveQuietThreshold: vi.fn(() => false),
		registerActive: vi.fn(),
		unregisterActive: vi.fn(),
		add: vi.fn(() => "mock-session-id"),
		list: vi.fn(() => []),
		get: vi.fn(() => undefined),
		take: vi.fn(() => undefined),
		restore: vi.fn(),
		remove: vi.fn(),
		scheduleCleanup: vi.fn(),
		restartAutoCleanup: vi.fn(),
		killAll: vi.fn(),
		onChange: vi.fn(() => () => {}),
	};

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

	const extensionModule = await import("../index.js");
	const extension = extensionModule.default;

	let registeredTool: { execute: (...args: any[]) => Promise<any> } | null = null;
	const pi = {
		registerShortcut: vi.fn(),
		registerCommand: vi.fn(),
		registerTool: vi.fn((tool: any) => {
			registeredTool = tool;
		}),
		on: vi.fn(),
		events: { emit: vi.fn() },
		sendMessage: vi.fn(),
	};

	extension(pi as any);

	return {
		tool: registeredTool,
		sessionManager,
		activeSession,
		ctx: {
			cwd: "/tmp/project",
			hasUI: true,
			sessionManager: {
				getSessionFile: () => "/tmp/project/current.jsonl",
			},
			ui: {
				notify: vi.fn(),
				custom: vi.fn(),
				select: vi.fn(),
			},
		},
	};
}

describe("interactive_shell submit input helper", () => {
	afterEach(() => {
		vi.doUnmock("@mariozechner/pi-coding-agent");
		vi.doUnmock("@mariozechner/pi-tui");
		vi.doUnmock("../session-manager.js");
	});

	it("mentions submit=true in the prompt snippet so agents are nudged toward real submission", async () => {
		const harness = await setupHarness();
		expect(harness.tool).toBeTruthy();
		expect((harness.tool as any).promptSnippet).toContain("submit=true");
		expect((harness.tool as any).promptSnippet).toContain("existing session");
	});

	it("appends Enter after plain text input when submit=true", async () => {
		const harness = await setupHarness();
		expect(harness.tool).toBeTruthy();

		const result = await harness.tool!.execute(
			"call-1",
			{
				sessionId: "sess-1",
				input: "/run manual-slash-check summarize src/alpha.ts in 2 short bullets",
				submit: true,
			},
			undefined,
			undefined,
			harness.ctx as any,
		);

		expect(harness.activeSession.write).toHaveBeenCalledWith("/run manual-slash-check summarize src/alpha.ts in 2 short bullets\r");
		expect(result.content[0].text).toContain("sent: /run manual-slash-check summarize src/alpha.ts ");
		expect(result.content[0].text).toContain("+ enter");
	});

	it("returns write_failed when async input delivery rejects", async () => {
		const harness = await setupHarness();
		expect(harness.tool).toBeTruthy();
		harness.activeSession.writeAsync = vi.fn().mockRejectedValue(new Error("remote control failed"));

		const result = await harness.tool!.execute(
			"call-1",
			{
				sessionId: "sess-1",
				input: "/run fails",
				submit: true,
			},
			undefined,
			undefined,
			harness.ctx as any,
		);

		expect(result.isError).toBe(true);
		expect(result.details).toEqual({ sessionId: "sess-1", error: "write_failed" });
		expect(harness.activeSession.writeAsync).toHaveBeenCalledWith("/run fails\r");
	});

	it("appends Enter after structured paste input when submit=true", async () => {
		const harness = await setupHarness();
		expect(harness.tool).toBeTruthy();

		await harness.tool!.execute(
			"call-1",
			{
				sessionId: "sess-2",
				inputPaste: "/run review",
				submit: true,
			},
			undefined,
			undefined,
			harness.ctx as any,
		);

		expect(harness.activeSession.paste).toHaveBeenCalledWith("/run review");
		expect(harness.activeSession.sendKeys).toHaveBeenCalledWith(["enter"]);
	});

	it("restarts background cleanup when attach focus fails", async () => {
		const harness = await setupHarness();
		expect(harness.tool).toBeTruthy();

		harness.sessionManager.get.mockReturnValueOnce({
			id: "bg-1",
			name: "bg-1",
			command: "pi",
			session: {
				exited: false,
				focus: vi.fn().mockRejectedValue(new Error("window closed")),
			},
			startedAt: new Date(),
		});

		const result = await harness.tool!.execute(
			"call-1",
			{
				attach: "bg-1",
			},
			undefined,
			undefined,
			harness.ctx as any,
		);

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Failed to focus kitty session bg-1");
		expect(harness.sessionManager.restartAutoCleanup).toHaveBeenCalledWith("bg-1");
	});
});
