import { afterEach, describe, expect, it, vi } from "vitest";
import { PtyTerminalSession } from "../pty-session.ts";
import { resolvePiShell } from "../shell-resolution.ts";

vi.mock("@earendil-works/pi-coding-agent", async () => ({
	...(await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>("@earendil-works/pi-coding-agent")),
	getAgentDir: () => "/tmp/pi-agent",
	SettingsManager: { create: () => ({ getShellPath: () => undefined }) },
}));

const sessions: PtyTerminalSession[] = [];

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

afterEach(() => {
	for (const session of sessions.splice(0)) {
		if (!session.exited) session.kill("SIGKILL");
		session.dispose();
	}
});

describe("PtyTerminalSession cleanup", () => {
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
