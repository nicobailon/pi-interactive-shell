import { afterEach, describe, expect, it, vi } from "vitest";
import { ChildProcess } from "node:child_process";
import { createPtyProcess, type PtyProcess } from "../pty-process.ts";
import { PtyTerminalSession } from "../pty-session.ts";
import { resolvePiShell } from "../shell-resolution.ts";
import { OUTPUT_SOURCE_REPRESENTATION, type OutputCapture } from "../output-source-store.ts";

vi.mock("@earendil-works/pi-coding-agent", async () => ({
	...(await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>("@earendil-works/pi-coding-agent")),
	getAgentDir: () => "/tmp/pi-agent",
	SettingsManager: { create: () => ({ getShellPath: () => undefined }) },
}));

const sessions: PtyTerminalSession[] = [];
const ptyProcesses: PtyProcess[] = [];
const itLinux = it.runIf(process.platform === "linux");

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForProcessExit(pid: number, timeoutMs = 1000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (processExists(pid) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

function createLinuxPty(command: string): PtyProcess {
	const shellConfig = resolvePiShell(process.cwd(), true);
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	if (!env.TERM) env.TERM = "xterm-256color";
	return createPtyProcess(shellConfig.shell, [...shellConfig.args, command], {
		name: "xterm-256color",
		cols: 80,
		rows: 24,
		cwd: process.cwd(),
		env,
	});
}

afterEach(() => {
	for (const session of sessions.splice(0)) {
		if (!session.exited) session.kill("SIGKILL");
		session.dispose();
	}
	for (const pty of ptyProcesses.splice(0)) {
		if (!pty.processExited) pty.kill("SIGKILL");
		pty.close();
	}
});

describe("PtyTerminalSession cleanup", () => {
	it.runIf(process.platform !== "win32")("captures exact process text before rollover and finalizes before exit publication", async () => {
		const fragments: string[] = [];
		let finalized = false;
		const capture: OutputCapture = {
			ref: { sourceId: "00000000-0000-4000-8000-000000000000", sessionId: "capture-test", representation: OUTPUT_SOURCE_REPRESENTATION },
			appendProcessText: (text) => { fragments.push(text); },
			finalize: async () => { finalized = true; return { sourceId: "test", state: "complete", length: fragments.join("").length }; },
			markIncomplete: async (reason) => ({ sourceId: "test", state: "incomplete", length: fragments.join("").length, reason }),
		};
		let resolveExit!: () => void;
		const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
		const session = new PtyTerminalSession({
			command: `node -e "process.stdout.write('\\u001b[31mhead\\rnext\\u001b[0m' + 'x'.repeat(1100000) + 'tail')"`,
			shellConfig: resolvePiShell(process.cwd(), true), outputCapture: capture,
		}, { onExit: () => { expect(finalized).toBe(true); resolveExit(); } });
		sessions.push(session);
		await exited;
		const captured = fragments.join("");
		expect(captured).toContain("\x1b[31mhead\rnext\x1b[0m");
		expect(captured.length).toBeGreaterThan(1024 * 1024);
		expect(captured.endsWith("tail")).toBe(true);
		expect(captured).not.toContain("[Process exited");
	});

	it("increments visual generation for viewport scroll mutations", async () => {
		let resolveExit!: () => void;
		const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
		const session = new PtyTerminalSession({
			command: "for i in {1..40}; do echo line-$i; done",
			shellConfig: resolvePiShell(process.cwd(), true), rows: 10,
		}, { onExit: () => resolveExit() });
		sessions.push(session);
		await exited;
		const generation = session.visualGeneration;
		session.scrollUp(1);
		expect(session.visualGeneration).toBe(generation + 1);
		session.scrollDown(1);
		expect(session.visualGeneration).toBe(generation + 2);
	});

	it("executes commands through the resolved Pi shell argv", async () => {
		if (process.platform === "win32") return;
		const previousShell = process.env.SHELL;
		process.env.SHELL = "/bin/sh";
		const output: string[] = [];
		try {
			let resolveExit!: () => void;
			const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
			const session = new PtyTerminalSession(
				{
					command: `if [[ "$BASH" == *bash ]]; then printf 'pi-bash-selection-ok\\n'; fi`,
					shellConfig: resolvePiShell(process.cwd(), true),
				},
				{ onData: (data) => output.push(data), onExit: () => resolveExit() },
			);
			sessions.push(session);

			await exited;
			expect(session.exited).toBe(true);
			expect(output.join("")).toContain("pi-bash-selection-ok");
		} finally {
			if (previousShell === undefined) delete process.env.SHELL;
			else process.env.SHELL = previousShell;
		}
	});

	it.runIf(process.platform !== "win32")("reports a non-ESRCH process-group signaling failure", () => {
		const session = new PtyTerminalSession({
			command: "trap '' TERM; while :; do sleep 1; done",
			shellConfig: resolvePiShell(process.cwd(), true),
		});
		sessions.push(session);
		const originalKill = process.kill.bind(process);
		const failure = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
		const groupKill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
			if (pid < 0) throw failure;
			return originalKill(pid, signal);
		});
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

		expect(session.kill()).toBeUndefined();
		expect(errorLog).toHaveBeenCalledWith("interactive-shell: failed to signal PTY with SIGTERM:", failure);
		groupKill.mockRestore();
		expect(session.kill("SIGKILL")).toBeUndefined();
		session.dispose();
		sessions.splice(sessions.indexOf(session), 1);
		errorLog.mockRestore();
	});

	it.runIf(process.platform !== "win32")("makes disposal timer-free and suppresses stale completion", async () => {
		let resolveReady!: () => void;
		const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
		const onExit = vi.fn();
		const session = new PtyTerminalSession(
			{ command: "trap '' TERM; printf 'ready\\n'; while :; do sleep 1; done", shellConfig: resolvePiShell(process.cwd(), true) },
			{ onData: (data) => { if (data.includes("ready")) resolveReady(); }, onExit },
		);
		await ready;
		const originalKill = process.kill.bind(process);
		const groupSignals: Array<string | number | undefined> = [];
		const groupKill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
			if (pid < 0) {
				groupSignals.push(signal);
				return true;
			}
			return originalKill(pid, signal);
		});

		session.kill();
		session.dispose();
		session.dispose();
		session.kill();
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(groupSignals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(onExit).not.toHaveBeenCalled();
		groupKill.mockRestore();
	});

	itLinux("does not fabricate child exit from post-spawn kill errors", async () => {
		const exits: Array<{ exitCode: number; signal?: number }> = [];
		let resolveExit!: () => void;
		const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
		const session = new PtyTerminalSession(
			{ command: "trap '' TERM; printf 'ready\\n'; while :; do sleep 1; done", shellConfig: resolvePiShell(process.cwd(), true) },
			{ onExit: (exitCode, signal) => { exits.push({ exitCode, signal }); resolveExit(); } },
		);
		sessions.push(session);
		const originalGroupKill = process.kill.bind(process);
		const groupKill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => pid < 0 ? true : originalGroupKill(pid, signal));
		const failure = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
		const childKill = vi.spyOn(ChildProcess.prototype, "kill").mockImplementation(function (this: ChildProcess) {
			queueMicrotask(() => this.emit("error", failure));
			return false;
		});

		session.kill("SIGKILL");
		session.kill("SIGKILL");
		await new Promise((resolve) => setImmediate(resolve));
		expect(session.exited).toBe(false);
		expect(exits).toEqual([]);
		expect(errorLog).toHaveBeenCalledTimes(4);

		childKill.mockRestore();
		groupKill.mockRestore();
		errorLog.mockRestore();
		session.kill("SIGKILL");
		await exited;
		expect(exits).toEqual([{ exitCode: 0, signal: 9 }]);
	});

	itLinux("retains one pending escalation after an immediate SIGKILL failure", async () => {
		let resolveReady!: () => void;
		let resolveExit!: () => void;
		const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
		const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
		const session = new PtyTerminalSession(
			{ command: `trap '' TERM; bash -c 'trap "" HUP TERM; printf "retained-ready\\n"; while :; do sleep 1; done' & wait`, shellConfig: resolvePiShell(process.cwd(), true) },
			{ onData: (data) => { if (data.includes("retained-ready")) resolveReady(); }, onExit: () => resolveExit() },
		);
		sessions.push(session);
		await ready;
		const originalKill = process.kill.bind(process);
		let groupAttempt = 0;
		const failure = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
		const groupKill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
			if (pid >= 0) return originalKill(pid, signal);
			groupAttempt++;
			if (groupAttempt === 1) return true;
			if (groupAttempt === 2) throw failure;
			return originalKill(pid, signal);
		});
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

		session.kill();
		session.kill("SIGKILL");
		await exited;
		expect(groupAttempt).toBe(3);
		expect(errorLog).toHaveBeenCalledWith("interactive-shell: failed to signal PTY with SIGKILL:", failure);
		groupKill.mockRestore();
		errorLog.mockRestore();
	});

	itLinux("delivers final output before a nonzero exit exactly once", async () => {
		const output: string[] = [];
		const exits: Array<{ exitCode: number; signal?: number }> = [];
		const suffix = "final-without-newline";
		const expectedOutput = `${"x".repeat(262144)}${suffix}`;
		let outputAtExit = "";
		let resolveExit!: () => void;
		const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
		const session = new PtyTerminalSession(
			{
				command: `[[ -t 0 && -r /dev/tty && -z "$(jobs -p)" && -z "$TMUX$TMUX_PANE$STY$WINDOW$WINDOWID$TERMCAP$COLUMNS$LINES" && "$PTY_KEEP" == kept ]] || exit 90; trap '' HUP; leader=$$; (while kill -0 "$leader" 2>/dev/null; do :; done; printf '%262144s' '' | tr ' ' x; printf '${suffix}') & exit 37`,
				shellConfig: resolvePiShell(process.cwd(), true),
				env: {
					PTY_KEEP: "kept",
					TMUX: "leak",
					TMUX_PANE: "leak",
					STY: "leak",
					WINDOW: "leak",
					WINDOWID: "leak",
					TERMCAP: "leak",
					COLUMNS: "leak",
					LINES: "leak",
				},
			},
			{
				onData: (data) => output.push(data),
				onExit: (exitCode, signal) => {
					outputAtExit = output.join("");
					exits.push({ exitCode, signal });
					resolveExit();
				},
			},
		);
		sessions.push(session);

		await exited;
		expect(outputAtExit).toBe(expectedOutput);
		expect(Buffer.byteLength(outputAtExit)).toBe(Buffer.byteLength(expectedOutput));
		expect(exits).toEqual([{ exitCode: 37, signal: 0 }]);
		expect(session.exited).toBe(true);
		expect(session.exitCode).toBe(37);
	});

	itLinux("supports descendant input and resize after the leader exits", async () => {
		const output: string[] = [];
		let session!: PtyTerminalSession;
		let sawReady = false;
		let sawPostExitReady = false;
		let resolveReady!: () => void;
		let resolvePostExitReady!: () => void;
		let resolveExit!: () => void;
		const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
		const postExitReady = new Promise<void>((resolve) => { resolvePostExitReady = resolve; });
		const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
		session = new PtyTerminalSession(
			{
				command: `[[ -t 0 && -r /dev/tty ]] || exit 90; leader=$$; (trap '' HUP; exec 4<>/dev/tty; stty raw -echo <&4; printf 'pty-ready\\n'; IFS= read -r -N 1 _ <&4; kill -CONT "$leader"; while kill -0 "$leader" 2>/dev/null; do :; done; payload=$(head -c 262143 <&4); stty sane <&4; printf 'prewrite=%s\\npost-exit-ready\\n' "\${#payload}"; read value <&4; printf 'value=%s size=%s\\n' "$value" "$(stty size <&4)") & kill -STOP "$$"; exit 0`,
				shellConfig: resolvePiShell(process.cwd(), true),
			},
			{
				onData: (data) => {
					output.push(data);
					if (!sawReady && output.join("").includes("pty-ready")) {
						sawReady = true;
						resolveReady();
					}
					if (!sawPostExitReady && output.join("").includes("post-exit-ready")) {
						sawPostExitReady = true;
						resolvePostExitReady();
					}
				},
				onExit: () => resolveExit(),
			},
		);
		sessions.push(session);

		await ready;
		session.write("x".repeat(262144));
		await postExitReady;
		expect(output.join("")).toContain("prewrite=262143");
		await waitForProcessExit(session.pid);
		expect(processExists(session.pid)).toBe(false);
		await new Promise((resolve) => setImmediate(resolve));
		expect(session.exited).toBe(false);
		const beforeResizeGeneration = session.visualGeneration;
		const visualChange = vi.fn();
		const unsubscribeVisual = session.addVisualChangeListener(visualChange);
		session.resize(80, 20);
		session.resize(90, 25);
		session.resize(103, 31);
		expect(session.visualGeneration).toBe(beforeResizeGeneration + 3);
		expect(visualChange).toHaveBeenCalledTimes(3);
		unsubscribeVisual();
		session.write("hello-from-pty\n");
		await exited;
		expect(output.join("")).toContain("value=hello-from-pty size=31 103");
	});

	itLinux("escalates cancellation for a retained same-group descendant", async () => {
		let descendantPid = 0;
		let output = "";
		let resolveReady!: () => void;
		let resolveExit!: () => void;
		const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
		const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
		const session = new PtyTerminalSession(
			{
				command: `bash -c 'trap "" HUP TERM; printf "descendant=%s\\n" "$$"; while :; do sleep 1; done' & wait`,
				shellConfig: resolvePiShell(process.cwd(), true),
			},
			{
				onData: (data) => {
					output += data;
					const match = output.match(/descendant=(\d+)/);
					if (match && descendantPid === 0) {
						descendantPid = Number(match[1]);
						resolveReady();
					}
				},
				onExit: () => resolveExit(),
			},
		);
		sessions.push(session);

		await ready;
		session.kill();
		await exited;
		await waitForProcessExit(descendantPid);
		expect(processExists(descendantPid)).toBe(false);
	});

	itLinux("disposal kills a retained descendant after the leader exits", async () => {
		let descendantPid = 0;
		let output = "";
		let resolveReady!: () => void;
		const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
		const session = new PtyTerminalSession(
			{
				command: `trap 'exit 0' USR1; bash -c 'trap "" HUP TERM; printf "descendant=%s\\n" "$$"; while :; do sleep 1; done' & wait`,
				shellConfig: resolvePiShell(process.cwd(), true),
			},
			{
				onData: (data) => {
					output += data;
					const match = output.match(/descendant=(\d+)/);
					if (match && descendantPid === 0) {
						descendantPid = Number(match[1]);
						resolveReady();
					}
				},
			},
		);
		sessions.push(session);

		await ready;
		process.kill(session.pid, "SIGUSR1");
		await waitForProcessExit(session.pid);
		expect(processExists(session.pid)).toBe(false);
		expect(processExists(descendantPid)).toBe(true);
		expect(session.exited).toBe(false);
		session.dispose();
		await waitForProcessExit(descendantPid);
		expect(processExists(descendantPid)).toBe(false);
		sessions.splice(sessions.indexOf(session), 1);
	});

	itLinux("decodes UTF-8 split across separately activated PTY reads", async () => {
		let output = "";
		let sentInput = false;
		let resolveExit!: () => void;
		const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
		let session!: PtyTerminalSession;
		session = new PtyTerminalSession(
			{
				command: `stty raw -echo; printf 'ready:\\xE2'; IFS= read -r -N 1 _; printf '\\x82\\xACdone'`,
				shellConfig: resolvePiShell(process.cwd(), true),
			},
			{
				onData: (data) => {
					output += data;
					if (!sentInput && output === "ready:") {
						sentInput = true;
						session.write("x");
					}
				},
				onExit: () => resolveExit(),
			},
		);
		sessions.push(session);

		await exited;
		expect(output).toBe("ready:€done");
	});

	itLinux("records leader exit before direct post-leader payload delivery", async () => {
		const output: string[] = [];
		const exits: Array<{ exitCode: number; signal: number }> = [];
		let sawPayload = false;
		let processExitedAtPayload = false;
		let resolveExit!: () => void;
		const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
		let pty!: PtyProcess;
		pty = createLinuxPty(`trap '' HUP; leader=$$; (while kill -0 "$leader" 2>/dev/null; do :; done; printf 'post-leader-payload') & exit 37`);
		ptyProcesses.push(pty);
		pty.onData((data) => {
			if (!sawPayload) {
				sawPayload = true;
				processExitedAtPayload = pty.processExited;
			}
			output.push(String(data));
		});
		pty.onExit((event) => {
			exits.push(event);
			resolveExit();
		});

		await exited;
		expect(processExitedAtPayload).toBe(true);
		expect(output.join("")).toBe("post-leader-payload");
		expect(exits).toEqual([{ exitCode: 37, signal: 0 }]);
	});

	itLinux("cancels a pending adapter resume and synchronous listener dispatch on close", async () => {
		const firstListener = vi.fn();
		const secondListener = vi.fn();
		const exit = vi.fn();
		const resumeSpy = vi.spyOn(globalThis, "setImmediate");
		const cancelSpy = vi.spyOn(globalThis, "clearImmediate");
		let pendingResume: ReturnType<typeof setImmediate> | undefined;
		let resolveFirst!: () => void;
		const first = new Promise<void>((resolve) => { resolveFirst = resolve; });
		const pty = createLinuxPty(`trap '' TERM; printf '%262144s' '' | tr ' ' x; while :; do :; done`);
		ptyProcesses.push(pty);
		pty.onData((chunk) => {
			firstListener(chunk);
			pendingResume = resumeSpy.mock.results.at(-1)?.value;
			pty.kill("SIGKILL");
			pty.close();
			resolveFirst();
		});
		pty.onData(secondListener);
		pty.onExit(exit);

		await first;
		expect(pendingResume).toBeDefined();
		expect(cancelSpy).toHaveBeenCalledWith(pendingResume);
		await new Promise((resolve) => setImmediate(resolve));
		await new Promise((resolve) => setImmediate(resolve));
		expect(firstListener).toHaveBeenCalledTimes(1);
		expect(secondListener).not.toHaveBeenCalled();
		expect(exit).not.toHaveBeenCalled();
		resumeSpy.mockRestore();
		cancelSpy.mockRestore();
	});

	it("kill forcefully terminates an interactive shell", async () => {
		const session = new PtyTerminalSession({ command: "bash -i", shellConfig: resolvePiShell(process.cwd(), true) });
		sessions.push(session);
		const pid = session.pid;
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(processExists(pid)).toBe(true);

		session.kill();
		await waitForProcessExit(pid);

		expect(processExists(pid)).toBe(false);
	});
});
