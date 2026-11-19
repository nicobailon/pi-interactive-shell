import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const LEGACY_COORDINATOR_KEY = "__piInteractiveShellCoordinatorV1";
const GLOBAL_KEYS = ["__piInteractiveShellCoordinatorsV2", "__piInteractiveShellSessionManagerV1", "__piInteractiveShellFinishedLogsV1", LEGACY_COORDINATOR_KEY];
const MOCKED = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "../background-widget.ts"];
const TRANSFER = "interactive-shell-transfer";

let agentDir: string;

function mockHostModules() {
	vi.doMock("@earendil-works/pi-coding-agent", () => ({
		getAgentDir: () => agentDir,
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
	vi.doMock("../background-widget.ts", () => ({ setupBackgroundWidget: () => () => {} }));
}

type Loading = "a module instance per session" | "one module instance for all sessions";

async function openPiSession(piSessionId: string, loading: Loading) {
	if (loading === "a module instance per session") vi.resetModules();
	mockHostModules();
	const extension = (await import("../index.ts")).default;
	const handlers = new Map<string, any>();
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	let activeTools: string[] = [];
	const pi = {
		registerShortcut: vi.fn(),
		registerCommand: vi.fn((name: string, options: any) => { commands.set(name, options); }),
		registerTool: vi.fn((tool: any) => { tools.set(tool.name, tool); activeTools.push(tool.name); }),
		on: vi.fn((event: string, handler: any) => handlers.set(event, handler)),
		events: { emit: vi.fn() },
		sendMessage: vi.fn(),
		getActiveTools: () => activeTools,
		setActiveTools: (next: string[]) => { activeTools = next; },
	};
	extension(pi as any);
	const ctx = {
		hasUI: false,
		cwd: process.cwd(),
		isProjectTrusted: () => true,
		sessionManager: { getSessionFile: () => undefined, getSessionId: () => piSessionId },
		ui: { notify: vi.fn(), onTerminalInput: () => () => {}, setWidget: vi.fn() },
	};
	handlers.get("session_start")({ reason: "startup" }, ctx);
	const call = async (params: Record<string, unknown>) => {
		const result = await tools.get("interactive_shell").execute("call", params, undefined, undefined, ctx);
		return result.content[0].text as string;
	};
	const command = async (name: string, args: string) => {
		ctx.ui.notify.mockClear();
		await commands.get(name).handler(args, ctx);
		return ctx.ui.notify.mock.calls.map(([text]) => text as string);
	};
	return {
		pi,
		call,
		command,
		notices: () => pi.sendMessage.mock.calls.map(([message]) => message.customType as string),
		startInBackground: async (command: string) => {
			const result = await tools.get("interactive_shell").execute("call", { command, mode: "dispatch", background: true }, undefined, undefined, ctx);
			expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
			return result.details.sessionId as string;
		},
		shutdown: (reason: "quit" | "reload") => handlers.get("session_shutdown")({ reason }),
	};
}

const sharedSessionManager = () => (globalThis as any)[GLOBAL_KEYS[1]!];
const coordinatorOf = (piSessionId: string) => (globalThis as any)[GLOBAL_KEYS[0]!]?.get(piSessionId);
const processAlive = (pattern: string) => { try { return execFileSync("pgrep", ["-f", pattern]).toString().trim().length > 0; } catch { return false; } };
const processEnded = (pattern: string) => vi.waitFor(() => expect(processAlive(pattern)).toBe(false), { timeout: 5000, interval: 50 });

describe.runIf(process.platform !== "win32").each<Loading>([
	"a module instance per session",
	"one module instance for all sessions",
])("several Pi sessions in one process, %s", (loading) => {
	afterEach(() => {
		sharedSessionManager()?.killAll();
		for (const key of GLOBAL_KEYS) Reflect.deleteProperty(globalThis, key);
		for (const id of MOCKED) vi.doUnmock(id);
		vi.resetModules();
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("ends only the shutting-down session's shells, and everything once the last session leaves", async () => {
		agentDir = mkdtempSync(join(tmpdir(), "pi-shell-95-"));
		const a = await openPiSession("pi-a", loading);
		const epochA = coordinatorOf("pi-a").getRuntimeEpoch();
		const b = await openPiSession("pi-b", loading);
		const shellA = await a.startInBackground("sleep 30.951");
		const shellB = await b.startInBackground("sleep 30.952");
		await vi.waitFor(() => expect(processAlive("sleep 30.951") && processAlive("sleep 30.952")).toBe(true));

		b.shutdown("quit");
		await processEnded("sleep 30.952");

		expect(sharedSessionManager().getActive(shellB)).toBeUndefined();
		expect(processAlive("sleep 30.951"), "A's shell").toBe(true);
		expect(sharedSessionManager().getActive(shellA)?.getStatus()).toBe("running");
		expect(coordinatorOf("pi-a").isRuntimeEpochCurrent(epochA), "A's runtime epoch").toBe(true);

		a.shutdown("quit");
		await processEnded("sleep 30.951");

		expect(sharedSessionManager(), "shared state after the last session").toBeUndefined();
	});

	it("delivers a completion notice to the session that started the shell", async () => {
		agentDir = mkdtempSync(join(tmpdir(), "pi-shell-95-"));
		const a = await openPiSession("pi-a", loading);
		await a.startInBackground("sleep 0.4; echo done");
		const b = await openPiSession("pi-b", loading);

		await vi.waitFor(() => expect([...a.notices(), ...b.notices()]).toContain(TRANSFER), { timeout: 5000, interval: 50 });

		expect({ a: a.notices(), b: b.notices() }).toEqual({ a: [TRANSFER], b: [] });
	});

	it("still notifies a session after a later-started session has shut down", async () => {
		agentDir = mkdtempSync(join(tmpdir(), "pi-shell-95-"));
		const a = await openPiSession("pi-a", loading);
		await a.startInBackground("sleep 0.6; echo done");
		const b = await openPiSession("pi-b", loading);
		b.shutdown("quit");

		await vi.waitFor(() => expect(a.notices()).toEqual([TRANSFER]), { timeout: 5000, interval: 50 });
		expect(b.notices()).toEqual([]);
	});

	it("holds a reloading session's notice for its own replacement API", async () => {
		agentDir = mkdtempSync(join(tmpdir(), "pi-shell-95-"));
		const a = await openPiSession("pi-a", loading);
		const b = await openPiSession("pi-b", loading);
		const shell = await a.startInBackground("sleep 0.3; echo done");
		a.shutdown("reload");
		await vi.waitFor(() => expect(sharedSessionManager().getActive(shell)).toBeUndefined(), { timeout: 5000, interval: 50 });
		expect({ a: a.notices(), b: b.notices() }).toEqual({ a: [], b: [] });

		const reloadedA = await openPiSession("pi-a", loading);

		expect({ a: a.notices(), reloadedA: reloadedA.notices(), b: b.notices() }).toEqual({ a: [], reloadedA: [TRANSFER], b: [] });
	});

	it("lets a session list, query, kill, dismiss, and attach to only the shells it started", async () => {
		agentDir = mkdtempSync(join(tmpdir(), "pi-shell-95-"));
		const a = await openPiSession("pi-a", loading);
		const b = await openPiSession("pi-b", loading);
		const shellA = await a.startInBackground("sleep 30.953");
		await vi.waitFor(() => expect(processAlive("sleep 30.953")).toBe(true));

		expect(await b.call({ listBackground: true })).toBe("No background sessions.");
		expect(await b.call({ dismissBackground: true })).toBe("No background sessions to dismiss.");
		expect(await b.call({ dismissBackground: shellA })).toBe(`Background session not found: ${shellA}`);
		expect(await b.call({ attach: shellA })).toBe(`Background session not found: ${shellA}`);
		expect(await b.call({ sessionId: shellA })).toBe(`Session not found or no longer active: ${shellA}`);
		expect(await b.call({ sessionId: shellA, kill: true })).toBe(`Session not found or no longer active: ${shellA}`);
		expect(await a.call({ sessionId: shellA })).toContain(`Session ${shellA} running`);

		expect(processAlive("sleep 30.953"), "A's shell").toBe(true);
		expect(await a.call({ listBackground: true })).toContain(shellA);
		expect(await a.call({ dismissBackground: true })).toBe(`Dismissed session ${shellA}.`);
		await processEnded("sleep 30.953");
	});

	it("scopes /attach and /dismiss to the shells the session started", async () => {
		agentDir = mkdtempSync(join(tmpdir(), "pi-shell-95-"));
		const a = await openPiSession("pi-a", loading);
		const b = await openPiSession("pi-b", loading);
		const shellA = await a.startInBackground("sleep 30.955");
		await vi.waitFor(() => expect(processAlive("sleep 30.955")).toBe(true));

		expect(await b.command("attach", "")).toEqual(["No background sessions"]);
		expect(await b.command("dismiss", "")).toEqual(["No background sessions"]);

		await b.startInBackground("sleep 30.956");
		await vi.waitFor(() => expect(processAlive("sleep 30.956")).toBe(true));
		expect(await b.command("attach", shellA)).toEqual([`Session not found: ${shellA}`]);
		expect(await b.command("dismiss", shellA)).toEqual([`Session not found: ${shellA}`]);
		expect(await b.command("dismiss", "")).toEqual(["Dismissed 1 session"]);

		await processEnded("sleep 30.956");
		expect(processAlive("sleep 30.955"), "A's shell").toBe(true);
	});

	it("keeps a shell with no recorded owner visible to every session", async () => {
		agentDir = mkdtempSync(join(tmpdir(), "pi-shell-95-"));
		const a = await openPiSession("pi-a", loading);
		const b = await openPiSession("pi-b", loading);
		sharedSessionManager().restore({
			id: "started-before-upgrade", name: "legacy", command: "legacy", startedAt: new Date(),
			session: { exited: false, setEventHandlers() {}, dispose() {} },
		}, { noAutoCleanup: true });

		expect(await a.call({ listBackground: true })).toContain("started-before-upgrade");
		expect(await b.call({ listBackground: true })).toContain("started-before-upgrade");
	});

	it("leaves a session alone when an older runtime for it shuts down after a newer one took over", async () => {
		agentDir = mkdtempSync(join(tmpdir(), "pi-shell-95-"));
		const older = await openPiSession("pi-a", loading);
		const b = await openPiSession("pi-b", loading);
		await older.startInBackground("sleep 30.954");
		await vi.waitFor(() => expect(processAlive("sleep 30.954")).toBe(true));
		const newer = await openPiSession("pi-a", loading);

		older.shutdown("quit");
		b.shutdown("quit");
		await new Promise((resolve) => setTimeout(resolve, 300));

		expect(processAlive("sleep 30.954"), "the session's shell").toBe(true);
		expect(coordinatorOf("pi-a"), "the session's coordinator").toBeDefined();

		newer.shutdown("quit");
		await processEnded("sleep 30.954");
		expect(sharedSessionManager(), "shared state after the last session").toBeUndefined();
	});

	it("hands the coordinator 0.18 kept for the whole process to the session that reloads into this version", async () => {
		agentDir = mkdtempSync(join(tmpdir(), "pi-shell-95-"));
		const { InteractiveShellCoordinator } = await import("../runtime-coordinator.ts");
		const legacy = new InteractiveShellCoordinator();
		const heldSinceShutdown = vi.fn();
		legacy.runWithExtensionApi(heldSinceShutdown);
		(globalThis as any)[LEGACY_COORDINATOR_KEY] = legacy;

		const a = await openPiSession("pi-a", loading);

		expect(heldSinceShutdown).toHaveBeenCalledWith(a.pi);
		expect(coordinatorOf("pi-a")).toBe(legacy);
		expect((globalThis as any)[LEGACY_COORDINATOR_KEY]).toBeUndefined();
	});
});
