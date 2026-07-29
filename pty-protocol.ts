// PTY control queries emitted by terminal applications.
// Cursor position DSR: ESC[6n or ESC[?6n. Primary DA: ESC[c or ESC[0c.
const DEVICE_QUERY_PATTERN = /\x1b\[(\??6n|0?c)/g;

export type DeviceQuery = "cursor-position" | "primary-device-attributes";

/** Result of splitting PTY output around terminal queries that require a response. */
export interface DeviceQuerySplit {
	segments: Array<{ text: string; queryAfter: DeviceQuery }>;
	trailingText: string;
	hasQuery: boolean;
}

export function splitAroundDeviceQueries(input: string): DeviceQuerySplit {
	const segments: Array<{ text: string; queryAfter: DeviceQuery }> = [];
	let lastIndex = 0;
	const regex = new RegExp(DEVICE_QUERY_PATTERN.source, "g");
	let match: RegExpExecArray | null;
	while ((match = regex.exec(input)) !== null) {
		segments.push({
			text: input.slice(lastIndex, match.index),
			queryAfter: match[1].endsWith("c") ? "primary-device-attributes" : "cursor-position",
		});
		lastIndex = match.index + match[0].length;
	}
	return { segments, trailingText: input.slice(lastIndex), hasQuery: segments.length > 0 };
}

export function buildCursorPositionResponse(row = 1, col = 1): string {
	return `\x1b[${row};${col}R`;
}

export function buildPrimaryDeviceAttributesResponse(): string {
	return "\x1b[?1;2c";
}
