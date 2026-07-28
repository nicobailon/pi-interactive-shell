import { afterEach, describe, expect, it, vi } from "vitest";

type MockBackgroundSession = {
	id: string;
	command: string;
	reason?: string;
	session: { exited: boolean; setEventHandlers?: (handlers: unknown) => void };
	startedAt: Date;
};

async function setupHarness(initialSessions: MockBackgroundSession[]) {
	const sessions = initialSessions;

	const sessionManager = {
		list: vi.fn(() => sessions),
		get: vi.fn(() => undefined),
		take: vi.fn(() => undefined),
		restore: vi.fn(),
		remove: vi.fn(),
		restartAutoCleanup: vi.fn(),
		scheduleCleanup: vi.fn(),
		registerActive: vi.fn(),
		unregisterActive: vi.fn(),
		getActive: vi.fn(() => undefined),
		writeToActive: vi.fn(() => false),
		setActiveUpdateInterval: vi.fn(() => false),
		setActiveQuietThreshold: vi.fn(() => false),
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

	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> | void }>();
	const pi = {
		registerShortcut: vi.fn(),
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
	const ctx = {
		cwd: "/tmp/project",
		hasUI: true,
		sessionManager: {
			getSessionFile: () => "/tmp/project/current.jsonl",
		},
		ui: {
			notify,
			custom: vi.fn(),
			select: vi.fn(async (_title: string, options: string[]): Promise<string | undefined> => options[0]),
		},
	};

	return {
		commands,
		ctx,
		notify,
		sessionManager,
	};
}

describe("command session selection", () => {
	afterEach(() => {
		vi.doUnmock("@earendil-works/pi-coding-agent");
		vi.doUnmock("@earendil-works/pi-tui");
		vi.doUnmock("../session-manager.ts");
	});

	it("/attach preserves full session id when id contains ' - '", async () => {
		const trickyId = "alpha - beta";
		const harness = await setupHarness([
			{
				id: trickyId,
				command: "pi",
				session: { exited: false },
				startedAt: new Date(),
			},
		]);
		const attach = harness.commands.get("attach");
		expect(attach).toBeDefined();

		harness.ctx.ui.select.mockImplementationOnce(async (_title: string, options: string[]) => options[0]);
		await attach!.handler("", harness.ctx as any);

		expect(harness.sessionManager.get).toHaveBeenCalledWith(trickyId);
		expect(harness.notify).toHaveBeenCalledWith(`Session not found: ${trickyId}`, "error");
	});

	it("/dismiss preserves full session id when id contains ' ('", async () => {
		const trickyId = "gamma (delta";
		const harness = await setupHarness([
			{
				id: "simple-id",
				command: "pi",
				session: { exited: false },
				startedAt: new Date(),
			},
			{
				id: trickyId,
				command: "pi",
				session: { exited: false },
				startedAt: new Date(),
			},
		]);
		const dismiss = harness.commands.get("dismiss");
		expect(dismiss).toBeDefined();

		harness.ctx.ui.select.mockImplementationOnce(async (_title: string, options: string[]) => {
			const match = options.find((option) => option.startsWith(`${trickyId} (`));
			return match;
		});
		await dismiss!.handler("", harness.ctx as any);

		expect(harness.sessionManager.remove).toHaveBeenCalledWith(trickyId);
	});
});
