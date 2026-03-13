import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import type { InteractiveShellConfig } from "./config.js";
import type { InteractiveShellOptions, InteractiveShellResult } from "./types.js";
import type { PtyTerminalSession } from "./pty-session.js";

export function captureCompletionOutput(
	session: PtyTerminalSession,
	config: InteractiveShellConfig,
): InteractiveShellResult["completionOutput"] {
	const result = session.getTailLines({
		lines: config.completionNotifyLines,
		ansi: false,
		maxChars: config.completionNotifyMaxChars,
	});
	return {
		lines: result.lines,
		totalLines: result.totalLinesInBuffer,
		truncated: result.lines.length < result.totalLinesInBuffer || result.truncatedByChars,
	};
}

export function captureTransferOutput(
	session: PtyTerminalSession,
	config: InteractiveShellConfig,
): InteractiveShellResult["transferred"] {
	const result = session.getTailLines({
		lines: config.transferLines,
		ansi: false,
		maxChars: config.transferMaxChars,
	});
	return {
		lines: result.lines,
		totalLines: result.totalLinesInBuffer,
		truncated: result.lines.length < result.totalLinesInBuffer || result.truncatedByChars,
	};
}

export function maybeBuildHandoffPreview(
	session: PtyTerminalSession,
	when: "exit" | "detach" | "kill" | "timeout" | "transfer",
	config: InteractiveShellConfig,
	overrides?: Pick<InteractiveShellOptions, "handoffPreviewEnabled" | "handoffPreviewLines" | "handoffPreviewMaxChars">,
): InteractiveShellResult["handoffPreview"] | undefined {
	const enabled = overrides?.handoffPreviewEnabled ?? config.handoffPreviewEnabled;
	if (!enabled) return undefined;
	const lines = overrides?.handoffPreviewLines ?? config.handoffPreviewLines;
	const maxChars = overrides?.handoffPreviewMaxChars ?? config.handoffPreviewMaxChars;
	if (lines <= 0 || maxChars <= 0) return undefined;
	const result = session.getTailLines({ lines, ansi: false, maxChars });
	return { type: "tail", when, lines: result.lines };
}

export function maybeWriteHandoffSnapshot(
	session: PtyTerminalSession,
	when: "exit" | "detach" | "kill" | "timeout" | "transfer",
	config: InteractiveShellConfig,
	context: { command: string; cwd?: string },
	overrides?: Pick<InteractiveShellOptions, "handoffSnapshotEnabled" | "handoffSnapshotLines" | "handoffSnapshotMaxChars">,
): InteractiveShellResult["handoff"] | undefined {
	const enabled = overrides?.handoffSnapshotEnabled ?? config.handoffSnapshotEnabled;
	if (!enabled) return undefined;
	const lines = overrides?.handoffSnapshotLines ?? config.handoffSnapshotLines;
	const maxChars = overrides?.handoffSnapshotMaxChars ?? config.handoffSnapshotMaxChars;
	if (lines <= 0 || maxChars <= 0) return undefined;

	const baseDir = join(getAgentDir(), "cache", "interactive-shell");
	mkdirSync(baseDir, { recursive: true });
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const pid = session.pid;
	const filename = `snapshot-${timestamp}-pid${pid}.log`;
	const transcriptPath = join(baseDir, filename);
	const tailResult = session.getTailLines({
		lines,
		ansi: config.ansiReemit,
		maxChars,
	});
	const header = [
		`# interactive-shell snapshot (${when})`,
		`time: ${new Date().toISOString()}`,
		`command: ${context.command}`,
		`cwd: ${context.cwd ?? ""}`,
		`pid: ${pid}`,
		`exitCode: ${session.exitCode ?? ""}`,
		`signal: ${session.signal ?? ""}`,
		`lines: ${tailResult.lines.length} (requested ${lines}, maxChars ${maxChars})`,
		"",
	].join("\n");
	writeFileSync(transcriptPath, header + tailResult.lines.join("\n") + "\n", { encoding: "utf-8" });
	return { type: "snapshot", when, transcriptPath, linesWritten: tailResult.lines.length };
}
