import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { computeSnapshotDelta } from "../kitty-snapshot.js";

describe("computeSnapshotDelta", () => {
	it("appends only the new suffix when next extends previous", () => {
		expect(computeSnapshotDelta("hello", "hello world")).toEqual({ delta: " world", rewrite: false });
	});

	it("returns empty when snapshots are identical", () => {
		expect(computeSnapshotDelta("abc", "abc")).toEqual({ delta: "", rewrite: false });
	});

	it("handles scrollback head roll-off via suffix/prefix overlap", () => {
		const previous = "line1\nline2\nline3\n";
		const next = "line2\nline3\nline4\n";
		expect(computeSnapshotDelta(previous, next)).toEqual({ delta: "line4\n", rewrite: false });
	});

	it("does not treat weak whitespace overlap as append", () => {
		const previous = "old screen\n";
		const next = "\nnew screen\n";
		expect(computeSnapshotDelta(previous, next)).toEqual({ delta: "", rewrite: true });
	});

	it("does not treat a single matching character as scrollback roll-off", () => {
		const previous = "abc";
		const next = "cdef";
		expect(computeSnapshotDelta(previous, next)).toEqual({ delta: "", rewrite: true });
	});

	it("marks full rewrites instead of re-appending the entire snapshot", () => {
		const previous = "aaaa\nbbbb\ncccc\n";
		const next = "xxxx\nyyyy\nzzzz\n";
		expect(computeSnapshotDelta(previous, next)).toEqual({ delta: "", rewrite: true });
	});

	it("treats first snapshot as full delta", () => {
		expect(computeSnapshotDelta("", "hello")).toEqual({ delta: "hello", rewrite: false });
	});
});

describe("buildEnv", () => {
	it("preserves the Pi process environment and applies session overrides", async () => {
		const oldPath = process.env.PATH;
		const oldApiKey = process.env.PI_INTERACTIVE_TEST_API_KEY;
		const oldTerm = process.env.TERM;
		try {
			vi.resetModules();
			vi.doMock("@mariozechner/pi-coding-agent", () => ({
				getAgentDir: () => "/tmp/pi-agent-kitty-session-test",
			}));
			const { buildEnv } = await import("../kitty-session.js");

			process.env.PATH = "/tmp/pi-bin";
			process.env.PI_INTERACTIVE_TEST_API_KEY = "from-pi";
			delete process.env.TERM;

			const env = buildEnv({
				PI_INTERACTIVE_TEST_API_KEY: "override",
				CUSTOM_SESSION_ENV: "session-value",
			});

			expect(env).toContain("PATH=/tmp/pi-bin");
			expect(env).toContain("PI_INTERACTIVE_TEST_API_KEY=override");
			expect(env).toContain("CUSTOM_SESSION_ENV=session-value");
			expect(env).toContain("TERM=xterm-kitty");
		} finally {
			if (oldPath === undefined) delete process.env.PATH;
			else process.env.PATH = oldPath;
			if (oldApiKey === undefined) delete process.env.PI_INTERACTIVE_TEST_API_KEY;
			else process.env.PI_INTERACTIVE_TEST_API_KEY = oldApiKey;
			if (oldTerm === undefined) delete process.env.TERM;
			else process.env.TERM = oldTerm;
			vi.doUnmock("@mariozechner/pi-coding-agent");
			vi.resetModules();
		}
	});

	it("forces TERM=xterm-kitty even when the parent shell has TERM set", async () => {
		const oldTerm = process.env.TERM;
		try {
			vi.resetModules();
			vi.doMock("@mariozechner/pi-coding-agent", () => ({
				getAgentDir: () => "/tmp/pi-agent-kitty-session-test",
			}));
			const { buildEnv } = await import("../kitty-session.js");

			process.env.TERM = "xterm-256color";
			const env = buildEnv();
			expect(env).toContain("TERM=xterm-kitty");
			expect(env).not.toContain("TERM=xterm-256color");

			const overridden = buildEnv({ TERM: "xterm-256color" });
			expect(overridden).toContain("TERM=xterm-256color");
		} finally {
			if (oldTerm === undefined) delete process.env.TERM;
			else process.env.TERM = oldTerm;
			vi.doUnmock("@mariozechner/pi-coding-agent");
			vi.resetModules();
		}
	});
});

function mockLsWithManagedWindow() {
	return vi.fn().mockResolvedValue([
		{
			id: 1,
			tabs: [
				{
					id: 1,
					title: "t",
					windows: [
						{
							id: 42,
							pid: 100,
							title: "w",
							columns: 80,
							lines: 24,
							user_vars: { pi_interactive_kitty_os_window: "1", pi_interactive_kitty: "1" },
							foreground_processes: [{ pid: 100 }],
						},
					],
				},
			],
		},
	]);
}

describe("KittyTerminalSession poll transient failures", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.useFakeTimers();
	});

	afterEach(async () => {
		vi.useRealTimers();
		try {
			const mod = await import("../kitty-session.js");
			mod.__resetKittyScrollbackCacheForTests?.();
		} catch {
			// module may not have been loaded
		}
		vi.doUnmock("@mariozechner/pi-coding-agent");
		vi.doUnmock("../kitty-client.js");
	});

	it("applies scrollbackLines to kitty via load-config override before launch", async () => {
		const loadConfig = vi.fn().mockResolvedValue(undefined);
		const launch = vi.fn().mockResolvedValue(42);
		const getText = vi.fn().mockResolvedValue("hello\n");
		const ls = mockLsWithManagedWindow();

		vi.doMock("@mariozechner/pi-coding-agent", () => ({
			getAgentDir: () => "/tmp/pi-agent-kitty-session-test",
		}));
		vi.doMock("../kitty-client.js", async () => {
			const actual = await vi.importActual<typeof import("../kitty-client.js")>("../kitty-client.js");
			return {
				...actual,
				KittyClient: class MockKittyClient {
					loadConfig = loadConfig;
					launch = launch;
					getText = getText;
					ls = ls;
					focusWindow = vi.fn().mockResolvedValue(undefined);
					focusTabForWindow = vi.fn().mockResolvedValue(undefined);
					closeWindow = vi.fn().mockResolvedValue(undefined);
					sendText = vi.fn();
					sendKeys = vi.fn();
					signalChild = vi.fn();
				},
			};
		});

		const { KittyTerminalSession, __resetKittyScrollbackCacheForTests } = await import("../kitty-session.js");
		__resetKittyScrollbackCacheForTests();
		const session = new KittyTerminalSession({ command: "echo hi", id: "scrollback-apply" }, {
			scrollbackLines: 7777,
			kitty: {
				version: [0, 47, 4] as [number, number, number],
				responseTimeoutMs: 5000,
				pollIntervalMs: 500,
				osWindowTitle: "test",
				tabTitlePrefix: "pi-shell",
				focusNewSessions: false,
			},
		} as any);
		await session.ready;
		expect(loadConfig).toHaveBeenCalledWith({ overrides: ["scrollback_lines=7777"] });
		expect(launch).toHaveBeenCalled();
		// Second session with same value should not re-apply.
		loadConfig.mockClear();
		const session2 = new KittyTerminalSession({ command: "echo hi", id: "scrollback-apply-2" }, {
			scrollbackLines: 7777,
			kitty: {
				version: [0, 47, 4] as [number, number, number],
				responseTimeoutMs: 5000,
				pollIntervalMs: 500,
				osWindowTitle: "test",
				tabTitlePrefix: "pi-shell",
				focusNewSessions: false,
			},
		} as any);
		await session2.ready;
		expect(loadConfig).not.toHaveBeenCalled();
		session.dispose();
		session2.dispose();
	});

	it("does not mark exited on a single getText failure", async () => {
		const getText = vi.fn().mockRejectedValueOnce(new Error("timeout")).mockResolvedValue("hello");
		const ls = mockLsWithManagedWindow();
		const launch = vi.fn().mockResolvedValue(42);
		const focusWindow = vi.fn().mockResolvedValue(undefined);
		const focusTabForWindow = vi.fn().mockResolvedValue(undefined);
		const closeWindow = vi.fn().mockResolvedValue(undefined);

		vi.doMock("@mariozechner/pi-coding-agent", () => ({
			getAgentDir: () => "/tmp/pi-agent-kitty-session-test",
		}));
		vi.doMock("../kitty-client.js", async () => {
			const actual = await vi.importActual<typeof import("../kitty-client.js")>("../kitty-client.js");
			return {
				...actual,
				KittyClient: class MockKittyClient {
					loadConfig = vi.fn().mockResolvedValue(undefined);
					launch = launch;
					getText = getText;
					ls = ls;
					focusWindow = focusWindow;
					focusTabForWindow = focusTabForWindow;
					closeWindow = closeWindow;
					sendText = vi.fn();
					sendKeys = vi.fn();
					signalChild = vi.fn();
				},
			};
		});

		const { KittyTerminalSession } = await import("../kitty-session.js");
		const config = {
			scrollbackLines: 5000,
			kitty: {
				version: [0, 47, 4] as [number, number, number],
				responseTimeoutMs: 5000,
				pollIntervalMs: 500,
				osWindowTitle: "test",
				tabTitlePrefix: "pi-shell",
				focusNewSessions: false,
			},
		} as any;

		const session = new KittyTerminalSession({ command: "echo hi", id: "poll-test" }, config);
		await session.ready;
		expect(session.exited).toBe(false);

		// First interval tick — getText rejects once; must not exit.
		await vi.advanceTimersByTimeAsync(500);
		await Promise.resolve();
		await Promise.resolve();
		expect(session.exited).toBe(false);
		expect(getText).toHaveBeenCalled();

		session.dispose();
	});

	it("captures final kitty text before marking exit from exit file", async () => {
		const sessionId = `exit-capture-test-${Math.random().toString(36).slice(2)}`;
		const getText = vi.fn().mockResolvedValueOnce("initial\n").mockResolvedValue("final output\n[Process exited with code 0]\n");
		const ls = vi.fn().mockResolvedValue([
			{
				id: 1,
				tabs: [
					{
						id: 1,
						title: "t",
						windows: [
							{
								id: 42,
								pid: 100,
								title: "w",
								columns: 80,
								lines: 24,
								user_vars: { pi_interactive_kitty_os_window: "1", pi_interactive_kitty: "1" },
								foreground_processes: [{ pid: 100 }],
							},
						],
					},
				],
			},
		]);
		const launch = vi.fn().mockResolvedValue(42);
		const focusWindow = vi.fn().mockResolvedValue(undefined);
		const focusTabForWindow = vi.fn().mockResolvedValue(undefined);
		const closeWindow = vi.fn().mockResolvedValue(undefined);

		vi.doMock("@mariozechner/pi-coding-agent", () => ({
			getAgentDir: () => "/tmp/pi-agent-kitty-session-test",
		}));
		vi.doMock("../kitty-client.js", async () => {
			const actual = await vi.importActual<typeof import("../kitty-client.js")>("../kitty-client.js");
			return {
				...actual,
				KittyClient: class MockKittyClient {
					loadConfig = vi.fn().mockResolvedValue(undefined);
					launch = launch;
					getText = getText;
					ls = ls;
					focusWindow = focusWindow;
					focusTabForWindow = focusTabForWindow;
					closeWindow = closeWindow;
					sendText = vi.fn();
					sendKeys = vi.fn();
					signalChild = vi.fn();
				},
			};
		});

		const { KittyTerminalSession } = await import("../kitty-session.js");
		const config = {
			scrollbackLines: 5000,
			kitty: {
				version: [0, 47, 4] as [number, number, number],
				responseTimeoutMs: 5000,
				pollIntervalMs: 500,
				osWindowTitle: "test",
				tabTitlePrefix: "pi-shell",
				focusNewSessions: false,
			},
		} as any;

		const session = new KittyTerminalSession({ command: "echo hi", id: sessionId }, config);
		await session.ready;
		await Promise.resolve();
		await Promise.resolve();

		writeFileSync(`/tmp/pi-agent-kitty-session-test/cache/interactive-kitty/kitty/${sessionId}/exit-code.txt`, "0", "utf8");
		// Fire poll interval, then settle captureFinalSnapshot delays (50ms × up to 2).
		await vi.advanceTimersByTimeAsync(500);
		await vi.advanceTimersByTimeAsync(150);
		await Promise.resolve();

		expect(session.exited).toBe(true);
		expect(session.exitCode).toBe(0);
		expect((await session.getTailLines({ lines: 5, ansi: false })).lines).toContain("final output");
		// Final capture should re-read text after the exit file appears (not only the initial poll).
		expect(getText.mock.calls.length).toBeGreaterThanOrEqual(2);

		session.dispose();
	});

	it("removes a stale exit file before launching a reused session id", async () => {
		const sessionId = `reused-name-${Math.random().toString(36).slice(2)}`;
		const agentDir = "/tmp/pi-agent-kitty-session-test";
		const sessionDir = `${agentDir}/cache/interactive-kitty/kitty/${sessionId}`;
		const exitFile = `${sessionDir}/exit-code.txt`;
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(exitFile, "7", "utf8");

		const getText = vi.fn().mockResolvedValue("running\n");
		const ls = vi.fn().mockResolvedValue([
			{
				id: 1,
				tabs: [
					{
						id: 1,
						title: "t",
						windows: [
							{
								id: 42,
								pid: 100,
								title: "w",
								columns: 80,
								lines: 24,
								user_vars: { pi_interactive_kitty_os_window: "1", pi_interactive_kitty: "1" },
								foreground_processes: [{ pid: 100 }],
							},
						],
					},
				],
			},
		]);

		vi.doMock("@mariozechner/pi-coding-agent", () => ({
			getAgentDir: () => agentDir,
		}));
		vi.doMock("../kitty-client.js", async () => {
			const actual = await vi.importActual<typeof import("../kitty-client.js")>("../kitty-client.js");
			return {
				...actual,
				KittyClient: class MockKittyClient {
					loadConfig = vi.fn().mockResolvedValue(undefined);
					launch = vi.fn().mockResolvedValue(42);
					getText = getText;
					ls = ls;
					focusWindow = vi.fn().mockResolvedValue(undefined);
					focusTabForWindow = vi.fn().mockResolvedValue(undefined);
					closeWindow = vi.fn().mockResolvedValue(undefined);
					sendText = vi.fn();
					sendKeys = vi.fn();
					signalChild = vi.fn();
				},
			};
		});

		const { KittyTerminalSession } = await import("../kitty-session.js");
		const session = new KittyTerminalSession(
			{
				command: "echo hi",
				id: sessionId,
			},
			{
				scrollbackLines: 5000,
				kitty: {
					version: [0, 47, 4] as [number, number, number],
					responseTimeoutMs: 5000,
					pollIntervalMs: 500,
					osWindowTitle: "test",
					tabTitlePrefix: "pi-shell",
					focusNewSessions: false,
				},
			} as any,
		);

		expect(existsSync(exitFile)).toBe(false);
		await session.ready;
		await Promise.resolve();
		await Promise.resolve();
		expect(session.exited).toBe(false);

		session.dispose();
	});

	it("pulses data listeners on full snapshot rewrite without duplicating raw stream", async () => {
		const sessionId = `rewrite-pulse-${Math.random().toString(36).slice(2)}`;
		let text = "screen-a\nline-2\n";
		const getText = vi.fn(async () => text);
		const ls = vi.fn().mockResolvedValue([
			{
				id: 1,
				tabs: [
					{
						id: 1,
						title: "t",
						windows: [
							{
								id: 42,
								pid: 100,
								title: "w",
								columns: 80,
								lines: 24,
								user_vars: { pi_interactive_kitty_os_window: "1", pi_interactive_kitty: "1" },
								foreground_processes: [{ pid: 100 }],
							},
						],
					},
				],
			},
		]);

		vi.doMock("@mariozechner/pi-coding-agent", () => ({
			getAgentDir: () => "/tmp/pi-agent-kitty-session-test",
		}));
		vi.doMock("../kitty-client.js", async () => {
			const actual = await vi.importActual<typeof import("../kitty-client.js")>("../kitty-client.js");
			return {
				...actual,
				KittyClient: class MockKittyClient {
					loadConfig = vi.fn().mockResolvedValue(undefined);
					launch = vi.fn().mockResolvedValue(42);
					getText = getText;
					ls = ls;
					focusWindow = vi.fn().mockResolvedValue(undefined);
					focusTabForWindow = vi.fn().mockResolvedValue(undefined);
					closeWindow = vi.fn().mockResolvedValue(undefined);
					sendText = vi.fn();
					sendKeys = vi.fn();
					signalChild = vi.fn();
				},
			};
		});

		const { KittyTerminalSession } = await import("../kitty-session.js");
		const session = new KittyTerminalSession(
			{
				command: "echo hi",
				id: sessionId,
			},
			{
				scrollbackLines: 5000,
				kitty: {
					version: [0, 47, 4] as [number, number, number],
					responseTimeoutMs: 5000,
					pollIntervalMs: 500,
					osWindowTitle: "test",
					tabTitlePrefix: "pi-shell",
					focusNewSessions: false,
				},
			} as any,
		);

		const pulses: string[] = [];
		session.addDataListener((data) => pulses.push(data));
		await session.ready;
		// Let the immediate first poll settle.
		await Promise.resolve();
		await Promise.resolve();

		const beforeRewrite = session.getRawStream({ stripAnsi: false });
		expect(beforeRewrite.length).toBeGreaterThan(0);
		text = "totally\ndifferent\nscreen\n";
		await vi.advanceTimersByTimeAsync(500);
		await Promise.resolve();
		await Promise.resolve();

		// Tail reflects rewrite (live get-text); append-only stream is not fully re-appended.
		expect((await session.getTailLines({ lines: 5, ansi: false })).lines.join("\n")).toContain("different");
		expect(session.getRawStream({ stripAnsi: false })).toBe(beforeRewrite);
		// Quiet timers get a non-empty activity pulse (ZWNJ).
		expect(pulses.some((p) => p.includes("\u200c"))).toBe(true);

		session.dispose();
	});

	it("does not pulse activity every poll when stable kitty scrollback exceeds local bounds", async () => {
		const sessionId = `bounded-snapshot-${Math.random().toString(36).slice(2)}`;
		const text = "line-1\nline-2\nline-3\nline-4\n";
		const getText = vi.fn(async () => text);
		const ls = vi.fn().mockResolvedValue([
			{
				id: 1,
				tabs: [
					{
						id: 1,
						title: "t",
						windows: [
							{
								id: 42,
								pid: 100,
								title: "w",
								columns: 80,
								lines: 24,
								user_vars: { pi_interactive_kitty_os_window: "1", pi_interactive_kitty: "1" },
								foreground_processes: [{ pid: 100 }],
							},
						],
					},
				],
			},
		]);

		vi.doMock("@mariozechner/pi-coding-agent", () => ({
			getAgentDir: () => "/tmp/pi-agent-kitty-session-test",
		}));
		vi.doMock("../kitty-client.js", async () => {
			const actual = await vi.importActual<typeof import("../kitty-client.js")>("../kitty-client.js");
			return {
				...actual,
				KittyClient: class MockKittyClient {
					loadConfig = vi.fn().mockResolvedValue(undefined);
					launch = vi.fn().mockResolvedValue(42);
					getText = getText;
					ls = ls;
					focusWindow = vi.fn().mockResolvedValue(undefined);
					focusTabForWindow = vi.fn().mockResolvedValue(undefined);
					closeWindow = vi.fn().mockResolvedValue(undefined);
					sendText = vi.fn();
					sendKeys = vi.fn();
					signalChild = vi.fn();
				},
			};
		});

		const { KittyTerminalSession } = await import("../kitty-session.js");
		const session = new KittyTerminalSession(
			{
				command: "echo hi",
				id: sessionId,
			},
			{
				scrollbackLines: 2,
				kitty: {
					version: [0, 47, 4] as [number, number, number],
					responseTimeoutMs: 5000,
					pollIntervalMs: 500,
					osWindowTitle: "test",
					tabTitlePrefix: "pi-shell",
					focusNewSessions: false,
				},
			} as any,
		);

		const pulses: string[] = [];
		session.addDataListener((data) => pulses.push(data));
		await session.ready;
		await Promise.resolve();
		await Promise.resolve();
		expect(pulses.join("")).toContain("line-4");

		pulses.length = 0;
		await vi.advanceTimersByTimeAsync(500);
		await Promise.resolve();
		await Promise.resolve();
		expect(pulses.some((p) => p.includes("\u200c"))).toBe(false);

		session.dispose();
	});

	it("dispose() fires exit listeners so waiters do not hang when a running session is dismissed", async () => {
		const sessionId = `dispose-notify-${Math.random().toString(36).slice(2)}`;
		const getText = vi.fn().mockResolvedValue("running\n");
		const ls = mockLsWithManagedWindow();

		vi.doMock("@mariozechner/pi-coding-agent", () => ({
			getAgentDir: () => "/tmp/pi-agent-kitty-session-test",
		}));
		vi.doMock("../kitty-client.js", async () => {
			const actual = await vi.importActual<typeof import("../kitty-client.js")>("../kitty-client.js");
			return {
				...actual,
				KittyClient: class MockKittyClient {
					loadConfig = vi.fn().mockResolvedValue(undefined);
					launch = vi.fn().mockResolvedValue(42);
					getText = getText;
					ls = ls;
					focusWindow = vi.fn().mockResolvedValue(undefined);
					focusTabForWindow = vi.fn().mockResolvedValue(undefined);
					closeWindow = vi.fn().mockResolvedValue(undefined);
					sendText = vi.fn();
					sendKeys = vi.fn();
					signalChild = vi.fn();
				},
			};
		});

		const { KittyTerminalSession } = await import("../kitty-session.js");
		const session = new KittyTerminalSession({ command: "echo hi", id: sessionId }, {
			scrollbackLines: 5000,
			kitty: {
				version: [0, 47, 4] as [number, number, number],
				responseTimeoutMs: 5000,
				pollIntervalMs: 500,
				osWindowTitle: "test",
				tabTitlePrefix: "pi-shell",
				focusNewSessions: false,
			},
		} as any);
		await session.ready;

		const exitFired = vi.fn();
		session.addExitListener(exitFired);
		expect(session.exited).toBe(false);

		session.dispose();
		expect(session.exited).toBe(true);
		expect(exitFired).toHaveBeenCalledTimes(1);
	});

	it("kill() preserves the real exit code when the runner writes exit-code.txt within killGraceMs", async () => {
		const sessionId = `kill-preserves-${Math.random().toString(36).slice(2)}`;
		const getText = vi.fn().mockResolvedValue("running\n");
		const ls = mockLsWithManagedWindow();
		const signalChild = vi.fn().mockResolvedValue(undefined);
		const closeWindow = vi.fn().mockResolvedValue(undefined);

		vi.doMock("@mariozechner/pi-coding-agent", () => ({
			getAgentDir: () => "/tmp/pi-agent-kitty-session-test",
		}));
		vi.doMock("../kitty-client.js", async () => {
			const actual = await vi.importActual<typeof import("../kitty-client.js")>("../kitty-client.js");
			return {
				...actual,
				KittyClient: class MockKittyClient {
					loadConfig = vi.fn().mockResolvedValue(undefined);
					launch = vi.fn().mockResolvedValue(42);
					getText = getText;
					ls = ls;
					focusWindow = vi.fn().mockResolvedValue(undefined);
					focusTabForWindow = vi.fn().mockResolvedValue(undefined);
					closeWindow = closeWindow;
					sendText = vi.fn();
					sendKeys = vi.fn();
					signalChild = signalChild;
				},
			};
		});

		const { KittyTerminalSession } = await import("../kitty-session.js");
		const session = new KittyTerminalSession({ command: "sleep 999", id: sessionId }, {
			scrollbackLines: 5000,
			kitty: {
				version: [0, 47, 4] as [number, number, number],
				responseTimeoutMs: 5000,
				connectTimeoutMs: 5000,
				pollIntervalMs: 500,
				killGraceMs: 3000,
				osWindowTitle: "test",
				tabTitlePrefix: "pi-shell",
				focusNewSessions: false,
			},
		} as any);
		await session.ready;

		session.kill("SIGTERM");
		// signalChild is enqueued through the async queue
		await vi.advanceTimersByTimeAsync(50);
		expect(signalChild).toHaveBeenCalled();

		// Simulate a slow (>1s) graceful shutdown that eventually writes the real exit code.
		await vi.advanceTimersByTimeAsync(1200);
		writeFileSync(`/tmp/pi-agent-kitty-session-test/cache/interactive-kitty/kitty/${sessionId}/exit-code.txt`, "0", "utf8");
		// Poll interval + captureFinalSnapshot delays.
		await vi.advanceTimersByTimeAsync(300);
		await Promise.resolve();
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(200);
		await Promise.resolve();

		expect(session.exited).toBe(true);
		expect(session.exitCode).toBe(0);
		// Force-close path (closeWindow followed by markExited(null)) must not have been used.
		expect(closeWindow).not.toHaveBeenCalled();
	});
});
