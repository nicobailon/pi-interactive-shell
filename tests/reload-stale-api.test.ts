import { afterEach, describe, expect, it, vi } from "vitest";

const COORDINATOR_KEY = "__piInteractiveShellCoordinatorV1";
const MISSING_DIR = "/nonexistent/pi-interactive-shell-reload-test";

function mockModules(captured: { overlay?: any }) {
	vi.doMock("@earendil-works/pi-coding-agent", () => ({
		getAgentDir: () => MISSING_DIR,
		getShellConfig: () => ({ shell: "/bin/bash", args: ["-c"] }),
		SettingsManager: { create: () => ({ getShellPath: () => undefined }) },
	}));
	vi.doMock("@earendil-works/pi-tui", () => ({
		isKeyRelease: () => false,
		isKeyRepeat: () => false,
		matchesKey: () => false,
		truncateToWidth: (value: string) => value,
		visibleWidth: (value: string) => value.length,
	}));
	vi.doMock("../overlay-component.ts", () => ({
		InteractiveShellOverlay: class { constructor(_tui: unknown, _theme: unknown, options: unknown) { captured.overlay = options; } },
	}));
	vi.doMock("../background-widget.ts", () => ({ setupBackgroundWidget: () => () => {} }));
	vi.doMock("../session-manager.ts", () => ({
		sessionManager: new Proxy({}, { get: (target: any, key) => (target[key] ??= vi.fn(() => (key === "onChange" ? () => {} : undefined))) }),
		generateSessionId: () => "reload-session",
		releaseSessionManagerSingleton: vi.fn(),
	}));
}

function loadExtensionApi(extension: (pi: any) => void, { start = true } = {}) {
	let stale = false;
	let started = false;
	const guard = <T extends (...args: any[]) => any>(fn: T) => vi.fn((...args: Parameters<T>) => {
		if (stale) throw new Error("This extension ctx is stale after session replacement or reload.");
		return fn(...args);
	});
	// Pi's loader stub: action methods throw until the runtime is built, just before session_start.
	const action = <T extends (...args: any[]) => any>(fn: T) => guard((...args: Parameters<T>) => {
		if (!started) throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.");
		return fn(...args);
	});
	const handlers = new Map<string, any>();
	const tools = new Map<string, any>();
	const pi = {
		registerShortcut: guard(() => {}),
		registerCommand: guard(() => {}),
		registerTool: guard((tool: any) => tools.set(tool.name, tool)),
		on: guard((event: string, handler: any) => handlers.set(event, handler)),
		events: { emit: guard(() => {}) },
		sendMessage: action(() => {}),
	};
	extension(pi);
	const startSession = () => {
		started = true;
		handlers.get("session_start")({ reason: "startup" }, { ui: { notify: vi.fn(), onTerminalInput: () => () => {} } });
	};
	if (start) startSession();
	return { pi, handlers, tools, startSession, invalidate: () => { stale = true; } };
}

describe("hands-free sessions that survive /reload", () => {
	afterEach(() => {
		for (const id of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "../overlay-component.ts", "../background-widget.ts", "../session-manager.ts"]) vi.doUnmock(id);
		Reflect.deleteProperty(globalThis, COORDINATOR_KEY);
	});

	async function startHandsFreeThenShutdownForReload() {
		Reflect.deleteProperty(globalThis, COORDINATOR_KEY);
		const captured: { overlay?: any } = {};
		vi.resetModules();
		mockModules(captured);
		const before = loadExtensionApi((await import("../index.ts")).default);

		let finishOverlay!: (result: unknown) => void;
		await before.tools.get("interactive_shell").execute("call-1", { command: "sleep 60; echo done", mode: "hands-free" }, undefined, undefined, {
			hasUI: true, cwd: MISSING_DIR, isProjectTrusted: () => true, sessionManager: { getSessionFile: () => undefined },
			ui: { custom: (factory: any) => new Promise((resolve) => { finishOverlay = resolve; factory({ terminal: { columns: 120, rows: 40 } }, {}, undefined, resolve); }) },
		});
		expect(captured.overlay.onHandsFreeUpdate).toBeTypeOf("function");

		before.handlers.get("session_shutdown")({ reason: "reload" });
		before.invalidate();
		vi.resetModules();
		mockModules({});
		const loadReloaded = async (options?: { start?: boolean }) => loadExtensionApi((await import("../index.ts")).default, options);
		return { onHandsFreeUpdate: captured.overlay.onHandsFreeUpdate, finishOverlay, loadReloaded };
	}

	const update = (status: string) => ({ status, sessionId: "reload-session", runtime: 60000, tail: ["done"], tailTruncated: false, totalCharsSent: 4, budgetExhausted: false, exitCode: 0 });

	it("delivers later updates and transferred output through the reloaded API", async () => {
		const { onHandsFreeUpdate, finishOverlay, loadReloaded } = await startHandsFreeThenShutdownForReload();
		const after = await loadReloaded();

		const exited = update("exited");
		expect(() => onHandsFreeUpdate(exited)).not.toThrow();
		finishOverlay({ exitCode: 0, backgrounded: false, cancelled: false, sessionId: "reload-session", transferred: { lines: ["done"], totalLines: 1, truncated: false } });
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(after.pi.events.emit).toHaveBeenCalledWith("interactive-shell:update", exited);
		expect(after.pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: "interactive-shell-update", content: expect.stringContaining("Session reload-session exited") }), { triggerTurn: true });
		expect(after.pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: "interactive-shell-transfer" }), { triggerTurn: true });
		expect(after.pi.events.emit).toHaveBeenCalledWith("interactive-shell:transfer", expect.objectContaining({ sessionId: "reload-session" }));
	});

	it("holds updates from the reload window until the reloaded session starts", async () => {
		const { onHandsFreeUpdate, loadReloaded } = await startHandsFreeThenShutdownForReload();
		const beforeLoad = update("user-takeover");
		onHandsFreeUpdate(beforeLoad);
		const after = await loadReloaded({ start: false });
		const beforeStart = update("exited");
		expect(() => onHandsFreeUpdate(beforeStart)).not.toThrow();
		expect(after.pi.sendMessage).not.toHaveBeenCalled();

		after.startSession();

		expect(after.pi.events.emit).toHaveBeenCalledWith("interactive-shell:update", beforeLoad);
		expect(after.pi.events.emit).toHaveBeenCalledWith("interactive-shell:update", beforeStart);
		expect(after.pi.sendMessage).toHaveBeenCalledTimes(2);
		expect(after.pi.sendMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({ content: expect.stringContaining("user took over") }), { triggerTurn: true });
		expect(after.pi.sendMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({ content: expect.stringContaining("exited") }), { triggerTurn: true });
	});
});
