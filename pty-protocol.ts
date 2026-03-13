// DSR (Device Status Report) - cursor position query: ESC[6n or ESC[?6n
const DSR_PATTERN = /\x1b\[\??6n/g;

/** Result of splitting PTY output around device-status-report cursor queries. */
export interface DsrSplit {
	segments: Array<{ text: string; dsrAfter: boolean }>;
	hasDsr: boolean;
}

export function splitAroundDsr(input: string): DsrSplit {
	const segments: Array<{ text: string; dsrAfter: boolean }> = [];
	let lastIndex = 0;
	let hasDsr = false;
	const regex = new RegExp(DSR_PATTERN.source, "g");
	let match: RegExpExecArray | null;
	while ((match = regex.exec(input)) !== null) {
		hasDsr = true;
		if (match.index > lastIndex) {
			segments.push({ text: input.slice(lastIndex, match.index), dsrAfter: true });
		} else {
			segments.push({ text: "", dsrAfter: true });
		}
		lastIndex = match.index + match[0].length;
	}
	if (lastIndex < input.length) {
		segments.push({ text: input.slice(lastIndex), dsrAfter: false });
	}
	return { segments, hasDsr };
}

export function buildCursorPositionResponse(row = 1, col = 1): string {
	return `\x1b[${row};${col}R`;
}
