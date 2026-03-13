import { stripVTControlCharacters } from "node:util";

export const MAX_RAW_OUTPUT_SIZE = 1024 * 1024;

export function trimRawOutput(rawOutput: string, lastStreamPosition: number): { rawOutput: string; lastStreamPosition: number } {
	if (rawOutput.length <= MAX_RAW_OUTPUT_SIZE) {
		return { rawOutput, lastStreamPosition };
	}
	const keepSize = Math.floor(MAX_RAW_OUTPUT_SIZE / 2);
	const trimAmount = rawOutput.length - keepSize;
	return {
		rawOutput: rawOutput.substring(trimAmount),
		lastStreamPosition: Math.max(0, lastStreamPosition - trimAmount),
	};
}

export function sliceLogOutput(text: string, options: { offset?: number; limit?: number; stripAnsi?: boolean } = {}): {
	slice: string;
	totalLines: number;
	totalChars: number;
	sliceLineCount: number;
} {
	let source = text;
	if (options.stripAnsi !== false && source) {
		source = stripVTControlCharacters(source);
	}
	if (!source) {
		return { slice: "", totalLines: 0, totalChars: 0, sliceLineCount: 0 };
	}

	const normalized = source.replace(/\r\n/g, "\n");
	const lines = normalized.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") {
		lines.pop();
	}

	const totalLines = lines.length;
	const totalChars = source.length;
	let start: number;
	if (typeof options.offset === "number" && Number.isFinite(options.offset)) {
		start = Math.max(0, Math.floor(options.offset));
	} else if (options.limit !== undefined) {
		const tailCount = Math.max(0, Math.floor(options.limit));
		start = Math.max(totalLines - tailCount, 0);
	} else {
		start = 0;
	}

	const end = typeof options.limit === "number" && Number.isFinite(options.limit)
		? start + Math.max(0, Math.floor(options.limit))
		: undefined;
	const selectedLines = lines.slice(start, end);
	return {
		slice: selectedLines.join("\n"),
		totalLines,
		totalChars,
		sliceLineCount: selectedLines.length,
	};
}
