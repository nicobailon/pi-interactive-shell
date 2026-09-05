import { afterEach, describe, expect, it } from "vitest";
import { PtyTerminalSession } from "../pty-session.ts";
import { resolvePiShell } from "../shell-resolution.ts";

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
		const output: string[] = [];
		const session = new PtyTerminalSession(
			{ command: "printf 'pi-shell-argv-ok\\n'", shellConfig: resolvePiShell(process.cwd(), true) },
			{ onData: (data) => output.push(data) },
		);
		sessions.push(session);

		const deadline = Date.now() + 1000;
		while (!session.exited && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}

		expect(session.exited).toBe(true);
		expect(output.join("")).toContain("pi-shell-argv-ok");
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
