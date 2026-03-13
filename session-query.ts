import type { InteractiveShellConfig } from "./config.js";
import type { OutputOptions, OutputResult } from "./session-manager.js";
import type { InteractiveShellResult } from "./types.js";
import type { PtyTerminalSession } from "./pty-session.js";

/** Mutable query bookkeeping kept per active session. */
export interface SessionQueryState {
	lastQueryTime: number;
	incrementalReadPosition: number;
}

export const DEFAULT_STATUS_OUTPUT = 5 * 1024;
export const DEFAULT_STATUS_LINES = 20;
export const MAX_STATUS_OUTPUT = 50 * 1024;
export const MAX_STATUS_LINES = 200;

export function createSessionQueryState(): SessionQueryState {
	return {
		lastQueryTime: 0,
		incrementalReadPosition: 0,
	};
}

export function getSessionOutput(
	session: PtyTerminalSession,
	config: InteractiveShellConfig,
	state: SessionQueryState,
	options: OutputOptions | boolean = false,
	completionOutput?: InteractiveShellResult["completionOutput"],
): OutputResult {
	if (completionOutput) {
		return buildCompletionOutputResult(completionOutput);
	}

	const opts = typeof options === "boolean" ? { skipRateLimit: options } : options;
	const requestedLines = clampPositive(opts.lines ?? DEFAULT_STATUS_LINES, MAX_STATUS_LINES);
	const requestedMaxChars = clampPositive(opts.maxChars ?? DEFAULT_STATUS_OUTPUT, MAX_STATUS_OUTPUT);
	const rateLimited = maybeRateLimitQuery(config, state, opts.skipRateLimit ?? false);
	if (rateLimited) return rateLimited;

	if (opts.incremental) {
		return getIncrementalOutput(session, state, requestedLines, requestedMaxChars);
	}

	if (opts.drain) {
		return buildTruncatedOutput(session.getRawStream({ sinceLast: true, stripAnsi: true }), requestedMaxChars, true);
	}

	if (opts.offset !== undefined) {
		return getOffsetOutput(session, opts.offset, requestedLines, requestedMaxChars);
	}

	const tailResult = session.getTailLines({
		lines: requestedLines,
		ansi: false,
		maxChars: requestedMaxChars,
	});
	const output = tailResult.lines.join("\n");
	return {
		output,
		truncated: tailResult.lines.length < tailResult.totalLinesInBuffer || tailResult.truncatedByChars,
		totalBytes: output.length,
		totalLines: tailResult.totalLinesInBuffer,
	};
}

function maybeRateLimitQuery(
	config: InteractiveShellConfig,
	state: SessionQueryState,
	skipRateLimit: boolean,
): OutputResult | null {
	if (skipRateLimit) return null;
	const now = Date.now();
	const minIntervalMs = config.minQueryIntervalSeconds * 1000;
	const elapsed = now - state.lastQueryTime;
	if (state.lastQueryTime > 0 && elapsed < minIntervalMs) {
		return {
			output: "",
			truncated: false,
			totalBytes: 0,
			rateLimited: true,
			waitSeconds: Math.ceil((minIntervalMs - elapsed) / 1000),
		};
	}
	state.lastQueryTime = now;
	return null;
}

function getIncrementalOutput(
	session: PtyTerminalSession,
	state: SessionQueryState,
	requestedLines: number,
	requestedMaxChars: number,
): OutputResult {
	const result = session.getLogSlice({
		offset: state.incrementalReadPosition,
		limit: requestedLines,
		stripAnsi: true,
	});
	const output = truncateForMaxChars(result.slice, requestedMaxChars);
	state.incrementalReadPosition += result.sliceLineCount;
	return {
		output: output.value,
		truncated: output.truncated,
		totalBytes: output.value.length,
		totalLines: result.totalLines,
		hasMore: state.incrementalReadPosition < result.totalLines,
	};
}

function getOffsetOutput(
	session: PtyTerminalSession,
	offset: number,
	requestedLines: number,
	requestedMaxChars: number,
): OutputResult {
	const result = session.getLogSlice({
		offset,
		limit: requestedLines,
		stripAnsi: true,
	});
	const output = truncateForMaxChars(result.slice, requestedMaxChars);
	const hasMore = (offset + result.sliceLineCount) < result.totalLines;
	return {
		output: output.value,
		truncated: output.truncated || hasMore,
		totalBytes: output.value.length,
		totalLines: result.totalLines,
		hasMore,
	};
}

function buildCompletionOutputResult(completionOutput: NonNullable<InteractiveShellResult["completionOutput"]>): OutputResult {
	const output = completionOutput.lines.join("\n");
	return {
		output,
		truncated: completionOutput.truncated,
		totalBytes: output.length,
		totalLines: completionOutput.totalLines,
	};
}

function buildTruncatedOutput(output: string, requestedMaxChars: number, sliceFromEnd = false): OutputResult {
	const truncated = output.length > requestedMaxChars;
	let value = output;
	if (truncated) {
		value = sliceFromEnd
			? output.slice(-requestedMaxChars)
			: output.slice(0, requestedMaxChars);
	}
	return {
		output: value,
		truncated,
		totalBytes: value.length,
	};
}

function truncateForMaxChars(output: string, requestedMaxChars: number): { value: string; truncated: boolean } {
	if (output.length <= requestedMaxChars) {
		return { value: output, truncated: false };
	}
	return {
		value: output.slice(0, requestedMaxChars),
		truncated: true,
	};
}

function clampPositive(value: number, max: number): number {
	return Math.max(1, Math.min(max, value));
}
