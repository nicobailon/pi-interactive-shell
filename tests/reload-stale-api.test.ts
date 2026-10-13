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

function loadExtensionApi(extension: (pi: any) => void) {
	let stale = false;
	const guard = <T extends (...args: any[]) => any>(fn: T) => vi.fn((...args: Parameters<T>) => {
		if (stale) throw new Error("This extension ctx is stale after session replacement or reload.");
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
		sendMessage: guard(() => {}),
	};
	extension(pi);
	handlers.get("session_start")({ reason: "startup" }, { ui: { notify: vi.fn(), onTerminalInput: () => () => {} } });
	return { pi, handlers, tools, invalidate: () => { stale = true; } };
}

describe("hands-free sessions that survive /reload", () => {
	afterEach(() => {
		for (const id of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "../overlay-component.ts", "../background-widget.ts", "../session-manager.ts"]) vi.doUnmock(id);
		Reflect.deleteProperty(globalThis, COORDINATOR_KEY);
	});

	it("delivers later updates and transferred output through the reloaded API", async () => {
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
		const after = loadExtensionApi((await import("../index.ts")).default);

		const update = { status: "exited", sessionId: "reload-session", runtime: 60000, tail: ["done"], tailTruncated: false, totalCharsSent: 4, budgetExhausted: false, exitCode: 0 };
		expect(() => captured.overlay.onHandsFreeUpdate(update)).not.toThrow();
		finishOverlay({ exitCode: 0, backgrounded: false, cancelled: false, sessionId: "reload-session", transferred: { lines: ["done"], totalLines: 1, truncated: false } });
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(after.pi.events.emit).toHaveBeenCalledWith("interactive-shell:update", update);
		expect(after.pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: "interactive-shell-update", content: expect.stringContaining("Session reload-session exited") }), { triggerTurn: true });
		expect(after.pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: "interactive-shell-transfer" }), { triggerTurn: true });
		expect(after.pi.events.emit).toHaveBeenCalledWith("interactive-shell:transfer", expect.objectContaining({ sessionId: "reload-session" }));
	});
});
