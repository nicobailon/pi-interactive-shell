import type { InteractiveShellResult, HandsFreeUpdate, MonitorEventPayload, MonitorSessionState } from "./types.ts";
import type { HeadlessCompletionInfo } from "./headless-monitor.ts";
import { formatDurationMs } from "./types.ts";

const BRIEF_TAIL_LINES = 5;

export function buildDispatchNotification(sessionId: string, info: HeadlessCompletionInfo, duration: string): string {
	const parts = [buildDispatchStatusLine(sessionId, info, duration)];
	if (info.completionOutput && info.completionOutput.totalLines > 0) {
		parts.push(` ${info.completionOutput.totalLines} lines of output.`);
	}
	if (info.cancelled && info.completionOutput?.lines.length) parts.push("\n\nOutput captured at cancellation:");
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
		const outputLabel = result.cancelled ? "Output captured at cancellation" : "Output";
		parts.push(`\n${outputLabel} (${result.completionOutput.lines.length} lines${truncNote}):\n\n${result.completionOutput.lines.join("\n")}`);
	}
	return parts.join("");
}

export function buildMonitorEventNotification(event: MonitorEventPayload): string {
	if (event.semantic) {
		const detail = event.semantic.watchId
			? `Watch: ${event.semantic.watchId}`
			: event.semantic.attentionState
				? `Attention: ${event.semantic.attentionState}`
				: `Semantic kind: ${event.semantic.kind}`;
		const probability = event.semantic.probability !== undefined
			? `\nProbability: ${event.semantic.probability}${event.semantic.threshold !== undefined ? ` (threshold ${event.semantic.threshold})` : ""}`
			: "";
		return [
			`Monitor Event (${event.sessionId}) #${event.eventId}`,
			`Time: ${event.timestamp}`,
			"Strategy: semantic",
			`Trigger: ${event.triggerId}`,
			`Message: ${event.lineOrDiff}`,
			detail,
			`Decision: #${event.semantic.decisionId}, generation ${event.semantic.generation}, model ${event.semantic.model}${probability}`,
		].join("\n");
	}
	return [
		`Monitor Event (${event.sessionId}) #${event.eventId}`,
		`Time: ${event.timestamp}`,
		`Strategy: ${event.strategy}`,
		`Trigger: ${event.triggerId}`,
		`Matched: ${event.matchedText}`,
		`${event.strategy === "poll-diff" ? "Diff" : "Line"}: ${event.lineOrDiff}`,
	].join("\n");
}

export function buildMonitorLifecycleNotification(state: MonitorSessionState): string {
	const reason = state.terminalReason ?? "stopped";
	let headline: string;
	if (reason === "stream-ended") {
		headline = `Monitor ${state.sessionId} stream ended.`;
	} else if (reason === "timed-out") {
		headline = `Monitor ${state.sessionId} cancelled after timeout. Local supervision stopped; termination was attempted and subprocess exit is not confirmed.`;
	} else if (reason === "script-failed") {
		headline = `Monitor ${state.sessionId} script failed.`;
	} else {
		headline = `Monitor ${state.sessionId} stopped.`;
	}

	const details: string[] = [
		headline,
		`Strategy: ${state.strategy}`,
		`Events: ${state.eventCount}`,
		state.lastEventAt ? `Last event: #${state.lastEventId} at ${state.lastEventAt}` : "Last event: none",
	];

	if (state.exitCode !== undefined && state.exitCode !== null) {
		details.push(`Exit code: ${state.exitCode}`);
	}
	if (state.signal !== undefined) {
		details.push(`Signal: ${state.signal}`);
	}

	return details.join("\n");
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
			statusLine = `Session ${update.sessionId} cancelled (${formatDurationMs(update.runtime)}). Termination was attempted; subprocess exit is not confirmed.`;
			break;
		case "user-takeover":
			statusLine = `Session ${update.sessionId}: user took over (${formatDurationMs(update.runtime)})`;
			break;
		case "agent-resumed":
			statusLine = `Session ${update.sessionId}: agent resumed monitoring (${formatDurationMs(update.runtime)})`;
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
	const binaries = ["pi", "claude", "codex", "gemini", "agent"] as const;
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
	if (info.timedOut) return `Session ${sessionId} cancelled after timeout (${duration}). Local supervision stopped; termination was attempted and subprocess exit is not confirmed.`;
	if (info.completionReason === "auto-close-quiet") return `Session ${sessionId} auto-closed after quiet (${duration}). Local supervision stopped; termination was attempted and subprocess exit is not confirmed. This is not a terminal command verdict.`;
	if (info.cancelled) return `Session ${sessionId} cancelled (${duration}). Termination was attempted; subprocess exit is not confirmed.`;
	if (info.exitCode === 0) return `Session ${sessionId} completed successfully (${duration}).`;
	return `Session ${sessionId} exited with code ${info.exitCode} (${duration}).`;
}

function buildResultStatusLine(sessionId: string, result: InteractiveShellResult): string {
	if (result.timedOut) return `Session ${sessionId} cancelled after timeout. Local supervision stopped; termination was attempted and subprocess exit is not confirmed.`;
	if (result.completionReason === "auto-close-quiet") return `Session ${sessionId} auto-closed after quiet. Local supervision stopped; termination was attempted and subprocess exit is not confirmed. This is not a terminal command verdict.`;
	if (result.cancelled) return `Session ${sessionId} cancelled. Termination was attempted; subprocess exit is not confirmed.`;
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
	if (result.completionReason === "auto-close-quiet") return "Interactive session auto-closed after quiet; local supervision stopped, termination was attempted and subprocess exit is not confirmed. This is not a terminal command verdict";
	if (result.timedOut) return `Interactive session locally cancelled after timeout (${timeout ?? "?"}ms); termination was attempted and subprocess exit is not confirmed`;
	if (result.cancelled) return "Interactive session locally cancelled; termination was attempted and subprocess exit is not confirmed";
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
	return rest.length === 0 || /^(-{1,2}[A-Za-z0-9][A-Za-z0-9-]*(?:=[^\s]+|\s+[^\s-][^\s]*)?\s*)+$/.test(rest);
}
