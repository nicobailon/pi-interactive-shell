import { expect, it } from "vitest";
import type { InteractiveShellConfig } from "../config.ts";
import { HeadlessDispatchMonitor, type HeadlessCompletionInfo } from "../headless-monitor.ts";
import { PtyTerminalSession } from "../pty-session.ts";

const config = {
	completionNotifyLines: 20,
	completionNotifyMaxChars: 2000,
	autoExitGracePeriod: 0,
} as InteractiveShellConfig;

function monitorProcess(autoExitOnQuiet: boolean, script: string) {
	const session = new PtyTerminalSession({
		command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
		cwd: "/tmp",
		cols: 80,
		rows: 24,
		scrollback: 100,
	});
	const completion = new Promise<HeadlessCompletionInfo>((resolve) => {
		new HeadlessDispatchMonitor(session, config, {
			autoExitOnQuiet,
			quietThreshold: 75,
			gracePeriod: 0,
		}, resolve);
	});
	return { session, completion };
}

it("waits through quiet PTY output by default and retains explicit quiet auto-close", async () => {
	const startedAt = Date.now();
	const natural = monitorProcess(false, "process.stdout.write('started\\n'); setTimeout(() => process.exit(0), 300)");
	try {
		const result = await natural.completion;
		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(150);
		expect(result).toMatchObject({ exitCode: 0, completionReason: "exited" });
		expect(result.cancelled).not.toBe(true);
	} finally {
		natural.session.dispose();
	}

	const quietClose = monitorProcess(true, "process.stdout.write('started\\n'); setTimeout(() => process.exit(0), 2000)");
	try {
		const result = await quietClose.completion;
		expect(result).toMatchObject({ cancelled: true, completionReason: "auto-close-quiet" });
	} finally {
		quietClose.session.dispose();
	}
});
