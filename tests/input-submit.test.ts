import { afterEach, describe, expect, it, vi } from "vitest";

async function setupHarness() {
	const sessionManager = {
		getActive: vi.fn(() => ({ })),
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
	vi.doMock("@earendil-works/pi-coding-agent", () => ({
		getAgentDir: () => "/tmp/pi-agent",
	}));
	vi.doMock("@earendil-works/pi-tui", () => ({
		matchesKey: () => false,
		truncateToWidth: (value: string) => value,
		visibleWidth: (value: string) => value.length,
	}));
	vi.doMock("../session-manager.ts", () => ({
		sessionManager,
		generateSessionId: () => "mock-session-id",
	}));

	const extensionModule = await import("../index.ts");
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
		// TS narrows the closure-assigned local to null here; the runtime value is set by registerTool.
		tool: registeredTool as { execute: (...args: any[]) => Promise<any> } | null,
		sessionManager,
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
		vi.doUnmock("@earendil-works/pi-coding-agent");
		vi.doUnmock("@earendil-works/pi-tui");
		vi.doUnmock("../session-manager.ts");
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

		const result = await harness.tool!.execute("call-1", {
			sessionId: "sess-1",
			spawn: { agent: "", mode: "fresh", worktree: false, prompt: "" },
			input: "/run manual-slash-check summarize src/alpha.ts in 2 short bullets",
			submit: true,
		}, undefined, undefined, harness.ctx as any);

		expect(harness.sessionManager.writeToActive).toHaveBeenCalledWith(
			"sess-1",
			"/run manual-slash-check summarize src/alpha.ts in 2 short bullets\r",
		);
		expect(result.content[0].text).toContain("sent: /run manual-slash-check summarize src/alpha.ts ");
		expect(result.content[0].text).toContain("+ enter");
	});

	it("appends Enter after structured paste input when submit=true", async () => {
		const harness = await setupHarness();
		expect(harness.tool).toBeTruthy();

		await harness.tool!.execute("call-1", {
			sessionId: "sess-2",
			inputPaste: "/run review",
			submit: true,
		}, undefined, undefined, harness.ctx as any);

		expect(harness.sessionManager.writeToActive).toHaveBeenCalledWith(
			"sess-2",
			"\x1b[200~/run review\x1b[201~\r",
		);
	});
});
