import { afterEach, describe, expect, it, vi } from "vitest";
import type { JevClient } from "../jev-client.ts";
import { compileSemanticActions } from "../semantic-actions.ts";
import { SemanticSupervisor, type SemanticObservationSession } from "../semantic-supervisor.ts";

type MockBackgroundSession = {
	id: string;
	command: string;
	reason?: string;
	session: { exited: boolean; exitCode?: number | null; signal?: number; setEventHandlers?: (handlers: unknown) => void };
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
		coordinator: (globalThis as typeof globalThis & { __piInteractiveShellCoordinatorV1: import("../runtime-coordinator.ts").InteractiveShellCoordinator }).__piInteractiveShellCoordinatorV1,
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

	it("/attach pauses semantic authority before user control and resumes behind the monitor fence on background", async () => {
		const id = "semantic-attach";
		const terminal = { exited: false, exitCode: null, signal: undefined, setEventHandlers: vi.fn() };
		const harness = await setupHarness([{ id, command: "agent", session: terminal, startedAt: new Date() }]);
		const pauseSemantic = vi.fn();
		const resumeSemantic = vi.fn();
		const monitor = { disposed: false, pauseSemantic, resumeSemantic };
		harness.coordinator.setMonitor(id, monitor as never);
		harness.coordinator.registerSemanticSession(id, new Date());
		(harness.sessionManager.get as ReturnType<typeof vi.fn>).mockReturnValue({ id, command: "agent", session: terminal, startedAt: new Date() });
		harness.ctx.ui.custom.mockImplementationOnce(async () => {
			expect(pauseSemantic).toHaveBeenCalledTimes(1);
			expect(resumeSemantic).not.toHaveBeenCalled();
			expect(harness.coordinator.getSemanticSessionState(id)?.status).toBe("paused");
			return { exitCode: null, backgrounded: true, backgroundId: id, cancelled: false };
		});

		await harness.commands.get("attach")!.handler(id, harness.ctx as any);

		expect(resumeSemantic).toHaveBeenCalledTimes(1);
		expect(harness.coordinator.getSemanticSessionState(id)?.status).toBe("running");
		harness.coordinator.deleteMonitor(id);
		harness.coordinator.clearSemanticDecisions(id);
	});

	it("/attach fences in-flight actions and requires fresh output after semantic resume", async () => {
		vi.useFakeTimers();
		const id = "semantic-attach-fence";
		let listeners: Array<() => void> = [];
		const terminal = {
			exited: false, exitCode: null, signal: undefined, visualGeneration: 0, lines: ["Confirm?"], writes: [] as string[],
			setEventHandlers: vi.fn(), getViewportLines: () => terminal.lines,
			addVisualChangeListener: (listener: () => void) => { listeners.push(listener); return () => { listeners = listeners.filter((item) => item !== listener); }; },
			writeIfActive: (data: string) => { terminal.writes.push(data); return true; },
			mutate: (line: string) => { terminal.lines = [line]; terminal.visualGeneration += 1; for (const listener of [...listeners]) listener(); },
		};
		const harness = await setupHarness([{ id, command: "agent", session: terminal, startedAt: new Date() }]);
		(harness.sessionManager.get as ReturnType<typeof vi.fn>).mockReturnValue({ id, command: "agent", session: terminal, startedAt: new Date() });
		const resolvers: Array<(value: unknown) => void> = [];
		const evaluate = vi.fn(() => new Promise<unknown>((resolve) => resolvers.push(resolve)));
		const action = { id: "confirm", description: "Confirm the visible ordinary prompt", input: "yes", submit: true };
		const actionRegistry = compileSemanticActions({ enabled: true, items: [action] })!;
		const supervisor = new SemanticSupervisor({
			session: terminal as SemanticObservationSession, mode: "monitor", config: { minIntervalMs: 250, actions: { enabled: true, items: [action] } },
			client: { evaluate } as JevClient, model: "jev-1.13.0", requestTimeoutMs: 1_000,
			bounds: { maxViewportLines: 10, maxRecentChars: 100, redactionPatterns: [] }, startedAt: Date.now(),
			isEpochCurrent: () => true, isActionOwner: () => true, reserveGlobalAction: () => true, actionRegistry, onDecision: vi.fn(),
		});
		const monitor = { disposed: false, pauseSemantic: () => supervisor.pause(), resumeSemantic: () => supervisor.resume() };
		harness.coordinator.setMonitor(id, monitor as never);
		harness.coordinator.registerSemanticSession(id, new Date());
		terminal.mutate("Confirm?"); supervisor.handleOutput("Confirm?");
		await vi.advanceTimersByTimeAsync(0);
		expect(evaluate).toHaveBeenCalledTimes(1);
		harness.ctx.ui.custom.mockImplementationOnce(async () => {
			resolvers[0]!({
				model: "jev-1.13.0", usage: { input_tokens: 1, output_tokens: 1 }, answers: {
					requests_input: { type: "noul", noul: 0.1 }, requests_approval: { type: "noul", noul: 0.1 }, presents_result: { type: "noul", noul: 0.1 }, requires_intervention: { type: "noul", noul: 0.1 }, meaningful_progress: { type: "noul", noul: 0.8 },
					attention: { type: "choice", choice: "working", confidence: 0.99, probabilities: { working: 0.99, waiting_input: 0.002, waiting_approval: 0.002, presenting_result: 0.002, blocked: 0.002, other: 0.002 } },
					"action_ready:confirm": { type: "noul", noul: 0.99 }, action: { type: "choice", choice: "confirm", confidence: 0.99, probabilities: { confirm: 0.99, observe_again: 0.002, notify_pi: 0.002, stop_automation: 0.002 } },
				},
			});
			await Promise.resolve(); await Promise.resolve();
			expect(terminal.writes).toEqual([]);
			return { exitCode: null, backgrounded: true, backgroundId: id, cancelled: false };
		});

		await harness.commands.get("attach")!.handler(id, harness.ctx as any);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(evaluate).toHaveBeenCalledTimes(1);
		terminal.mutate("Fresh confirmation prompt"); supervisor.handleOutput("Fresh confirmation prompt");
		await vi.advanceTimersByTimeAsync(0);
		expect(evaluate).toHaveBeenCalledTimes(2);
		expect(terminal.writes).toEqual([]);
		supervisor.dispose();
		harness.coordinator.deleteMonitor(id);
		harness.coordinator.clearSemanticDecisions(id);
	});

	it("/attach restores paused semantic supervision after an overlay error while the process remains owned", async () => {
		const id = "semantic-attach-error";
		const terminal = { exited: false, exitCode: null, signal: undefined, setEventHandlers: vi.fn() };
		const harness = await setupHarness([{ id, command: "agent", session: terminal, startedAt: new Date() }]);
		(harness.sessionManager.get as ReturnType<typeof vi.fn>).mockReturnValue({ id, command: "agent", session: terminal, startedAt: new Date() });
		const pauseSemantic = vi.fn();
		const resumeSemantic = vi.fn();
		harness.coordinator.setMonitor(id, { disposed: false, pauseSemantic, resumeSemantic } as never);
		harness.coordinator.registerSemanticSession(id, new Date());
		harness.ctx.ui.custom.mockRejectedValueOnce(new Error("overlay failed"));

		await expect(harness.commands.get("attach")!.handler(id, harness.ctx as any)).rejects.toThrow("overlay failed");
		expect(pauseSemantic).toHaveBeenCalledTimes(1);
		expect(resumeSemantic).toHaveBeenCalledTimes(1);
		expect(harness.coordinator.getSemanticSessionState(id)?.status).toBe("running");
		harness.coordinator.deleteMonitor(id);
		harness.coordinator.clearSemanticDecisions(id);
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
