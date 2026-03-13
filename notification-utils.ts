import type { InteractiveShellResult, HandsFreeUpdate } from "./types.js";
import type { HeadlessCompletionInfo } from "./headless-monitor.js";
import { formatDurationMs } from "./types.js";

const BRIEF_TAIL_LINES = 5;

export function buildDispatchNotification(sessionId: string, info: HeadlessCompletionInfo, duration: string): string {
	const parts = [buildDispatchStatusLine(sessionId, info, duration)];
	if (info.completionOutput && info.completionOutput.totalLines > 0) {
		parts.push(` ${info.completionOutput.totalLines} lines of output.`);
	}
	appendTailBlock(parts, info.completionOutput?.lines, BRIEF_TAIL_LINES);
	parts.push(`\n\nAttach to review full output: interactive_shell({ attach: "${sessionId}" })`);
	return parts.join("");
}

export function buildResultNotification(sessionId: string, result: InteractiveShellResult): string {
	const parts = [buildResultStatusLine(sessionId, result)];
	if (result.completionOutput && result.completionOutput.lines.length > 0) {
		const truncNote = result.completionOutput.truncated
			? ` (truncated from ${result.completionOutput.totalLines} total lines)`
			: "";
		parts.push(`\nOutput (${result.completionOutput.lines.length} lines${truncNote}):\n\n${result.completionOutput.lines.join("\n")}`);
	}
	return parts.join("");
}

export function buildHandsFreeUpdateMessage(update: HandsFreeUpdate): { content: string; details: HandsFreeUpdate } | null {
	if (update.status === "running") return null;

	const tail = update.tail.length > 0 ? `\n\n${update.tail.join("\n")}` : "";
	let statusLine: string;
	switch (update.status) {
		case "exited":
			statusLine = `Session ${update.sessionId} exited (${formatDurationMs(update.runtime)})`;
			break;
		case "killed":
			statusLine = `Session ${update.sessionId} killed (${formatDurationMs(update.runtime)})`;
			break;
		case "user-takeover":
			statusLine = `Session ${update.sessionId}: user took over (${formatDurationMs(update.runtime)})`;
			break;
		default:
			statusLine = `Session ${update.sessionId} update (${formatDurationMs(update.runtime)})`;
	}
	return { content: statusLine + tail, details: update };
}

export function summarizeInteractiveResult(command: string, result: InteractiveShellResult, timeout?: number, reason?: string): string {
	let summary = buildInteractiveSummary(result, timeout);

	if (result.userTookOver) {
		summary += "\n\nNote: User took over control during hands-free mode.";
	}

	if (!result.transferred && result.handoffPreview?.type === "tail" && result.handoffPreview.lines.length > 0) {
		summary += `\n\nOverlay tail (${result.handoffPreview.when}, last ${result.handoffPreview.lines.length} lines):\n${result.handoffPreview.lines.join("\n")}`;
	}

	const warning = buildIdlePromptWarning(command, reason);
	if (warning) {
		summary += `\n\n${warning}`;
	}

	return summary;
}

export function buildIdlePromptWarning(command: string, reason: string | undefined): string | null {
	if (!reason) return null;

	const tasky = /\b(scan|check|review|summariz|analyz|inspect|audit|find|fix|refactor|debug|investigat|explore|enumerat|list)\b/i;
	if (!tasky.test(reason)) return null;

	const trimmed = command.trim();
	const binaries = ["pi", "claude", "codex", "gemini", "cursor-agent"] as const;
	const bin = binaries.find((candidate) => trimmed === candidate || trimmed.startsWith(`${candidate} `));
	if (!bin) return null;

	const rest = trimmed === bin ? "" : trimmed.slice(bin.length).trim();
	const hasQuotedPrompt = /["']/.test(rest);
	const hasKnownPromptFlag =
		/\b(-p|--print|--prompt|--prompt-interactive|-i|exec)\b/.test(rest) ||
		(bin === "pi" && /\b-p\b/.test(rest)) ||
		(bin === "codex" && /\bexec\b/.test(rest));

	if (hasQuotedPrompt || hasKnownPromptFlag) return null;
	if (!looksLikeIdleCommand(rest)) return null;

	const examplePrompt = reason.replace(/\s+/g, " ").trim();
	const clipped = examplePrompt.length > 120 ? `${examplePrompt.slice(0, 117)}...` : examplePrompt;
	return `Note: \`reason\` is UI-only. This command likely started the agent idle. If you intended an initial prompt, embed it in \`command\`, e.g. \`${bin} "${clipped}"\`.`;
}

function buildDispatchStatusLine(sessionId: string, info: HeadlessCompletionInfo, duration: string): string {
	if (info.timedOut) return `Session ${sessionId} timed out (${duration}).`;
	if (info.cancelled) return `Session ${sessionId} completed (${duration}).`;
	if (info.exitCode === 0) return `Session ${sessionId} completed successfully (${duration}).`;
	return `Session ${sessionId} exited with code ${info.exitCode} (${duration}).`;
}

function buildResultStatusLine(sessionId: string, result: InteractiveShellResult): string {
	if (result.timedOut) return `Session ${sessionId} timed out.`;
	if (result.cancelled) return `Session ${sessionId} was killed.`;
	if (result.exitCode === 0) return `Session ${sessionId} completed successfully.`;
	return `Session ${sessionId} exited with code ${result.exitCode}.`;
}

function buildInteractiveSummary(result: InteractiveShellResult, timeout?: number): string {
	if (result.transferred) {
		const truncatedNote = result.transferred.truncated ? ` (truncated from ${result.transferred.totalLines} total lines)` : "";
		return `Session output transferred (${result.transferred.lines.length} lines${truncatedNote}):\n\n${result.transferred.lines.join("\n")}`;
	}
	if (result.backgrounded) {
		return `Session running in background (id: ${result.backgroundId}). User can reattach with /attach ${result.backgroundId}`;
	}
	if (result.cancelled) return "User killed the interactive session";
	if (result.timedOut) return `Session killed after timeout (${timeout ?? "?"}ms)`;
	const status = result.exitCode === 0 ? "successfully" : `with code ${result.exitCode}`;
	return `Session ended ${status}`;
}

function appendTailBlock(parts: string[], lines: string[] | undefined, tailLines: number): void {
	if (!lines || lines.length === 0) return;
	let end = lines.length;
	while (end > 0 && lines[end - 1].trim() === "") end--;
	const tail = lines.slice(Math.max(0, end - tailLines), end);
	if (tail.length > 0) {
		parts.push(`\n\n${tail.join("\n")}`);
	}
}

function looksLikeIdleCommand(rest: string): boolean {
	return rest.length === 0 || /^(-{1,2}[A-Za-z0-9][A-Za-z0-9-]*(?:=[^\s]+)?\s*)+$/.test(rest);
}
