/** A fail-closed structural extractor for one fully visible multi-select prompt. */

export const MIN_SEMANTIC_MULTI_SELECT_ITEMS = 2;
export const MAX_SEMANTIC_MULTI_SELECT_ITEMS = 8;
export const MAX_SEMANTIC_MULTI_SELECT_LINES = 40;
export const MAX_SEMANTIC_MULTI_SELECT_LINE_LENGTH = 240;
export const MAX_SEMANTIC_MULTI_SELECT_VIEWPORT_LENGTH = 4_096;
export const MAX_SEMANTIC_MULTI_SELECT_LABEL_LENGTH = 160;

export type SemanticMultiSelectMarkerFamily = "bracket" | "circle";
export type SemanticMultiSelectId =
	| "multi_1" | "multi_2" | "multi_3" | "multi_4"
	| "multi_5" | "multi_6" | "multi_7" | "multi_8";

export type SemanticMultiSelectItem = Readonly<{
	id: SemanticMultiSelectId;
	label: string;
	checked: boolean;
}>;

/** Bindings are evidence-derived by the extractor but remain owned by code. */
export type SemanticMultiSelectBindings = Readonly<{
	up: "ArrowUp";
	down: "ArrowDown";
	toggle: "Space";
	submit: "Enter";
}>;

/** Exact sanitized screen evidence for a single bounded multi-select prompt. */
export type SemanticMultiSelectPrompt = Readonly<{
	viewport: readonly string[];
	prompt: string;
	promptIndex: number;
	items: readonly SemanticMultiSelectItem[];
	cursorIndex: number;
	markerFamily: SemanticMultiSelectMarkerFamily;
	bindings: SemanticMultiSelectBindings;
}>;

const BINDINGS: SemanticMultiSelectBindings = Object.freeze({
	up: "ArrowUp",
	down: "ArrowDown",
	toggle: "Space",
	submit: "Enter",
});

const CONTROL = /[\u0000-\u001f\u007f-\u009f\p{Cf}]/u;
const ROW = /^(\s*)(?:(❯|>)\s*)?(\[x\]|\[ \]|◉|◯)\s+(.+?)\s*$/u;
const FOOTER = /^\s*(\d{1,2})\s+choices\s+total\s*[•·⋅]\s*↑\s*↓\s+navigate\s*[•·⋅]\s*space\s+select\s*[•·⋅]\s*⏎\s+submit\s*$/iu;
const FORBIDDEN_TEXT = /\b(?:password|passphrase|credential|secret|token|api[ _-]?key|auth(?:entication)?|mfa|2fa|otp|one[- ]time|recovery code|pin|payment|credit card|shell|command|exec(?:ute)?|sudo|kill|signal|exit|quit|logout|shutdown|reboot|terminate|dispose|background|transfer|disown|suspend|job[ _-]?control|process control|abort|cancel|delete|remove|overwrite|drop|reset|erase|destroy|format|purge|start|stop|pause|resume|restart|reload|disabled?|unavailable|separator|search|filter)\b/i;
const SHELL_SYNTAX = /(?:&&|\|\||[;`$<>]|\$\(|\b(?:sh|bash|zsh|fish|powershell|cmd\.exe)\b)/i;
const PAGINATION = /(?:\.{3}|…|⋯|\b(?:page\s+\d+|\d+\s+(?:of|\/)\s+\d+|(?:load|show|scroll for) more|more (?:choices|items|options))\b)/i;
const UNKNOWN_BINDING = /(?:\besc(?:ape)?\b|\btab\b|\b(?:toggle all|select all|invert(?: selection)?)\b|\b[a-z]\s+(?:all|invert)\b)/i;
const VISUAL_SEPARATOR = /^\s*[\-─━═_]{3,}\s*$/u;

type ParsedRow = Readonly<{
	label: string;
	checked: boolean;
	cursor: boolean;
	family: SemanticMultiSelectMarkerFamily;
}>;

/**
 * Extracts one complete menu only when a visible exact total proves completeness
 * and the footer proves the ArrowUp/ArrowDown, Space, and Enter bindings.
 * Unsupported input is undefined.
 */
export function extractSemanticMultiSelect(viewport: unknown): SemanticMultiSelectPrompt | undefined {
	const lines = validateViewport(viewport);
	if (!lines) return undefined;

	const nonblank = lines.flatMap((line, index) => line.trim() ? [{ line, index }] : []);
	if (nonblank.length < MIN_SEMANTIC_MULTI_SELECT_ITEMS + 2) return undefined;

	const footerCandidates = nonblank.filter(({ line }) => FOOTER.test(line));
	if (footerCandidates.length !== 1) return undefined;
	const footer = footerCandidates[0]!;
	if (footer !== nonblank.at(-1)) return undefined;

	const parsedRows: Array<ParsedRow & { index: number }> = [];
	let firstRow = -1;
	let lastRow = -1;
	for (let index = 0; index < footer.index; index++) {
		const parsed = parseRow(lines[index]!);
		if (!parsed) continue;
		if (firstRow < 0) firstRow = index;
		lastRow = index;
		parsedRows.push({ ...parsed, index });
	}
	if (parsedRows.length < MIN_SEMANTIC_MULTI_SELECT_ITEMS || parsedRows.length > MAX_SEMANTIC_MULTI_SELECT_ITEMS) return undefined;
	const advertisedCount = Number(footer.line.match(FOOTER)?.[1]);
	if (advertisedCount !== parsedRows.length) return undefined;
	if (lastRow - firstRow + 1 !== parsedRows.length) return undefined;

	const headerLines = nonblank.filter(({ index }) => index < firstRow);
	if (headerLines.length !== 1) return undefined;
	const header = headerLines[0]!;
	if (nonblank.some(({ index }) => index > lastRow && index < footer.index)) return undefined;
	if (parsedRows.some((row, position) => row.index !== firstRow + position)) return undefined;

	const family = parsedRows[0]!.family;
	if (parsedRows.some((row) => row.family !== family)) return undefined;
	const cursors = parsedRows.flatMap((row, index) => row.cursor ? [index] : []);
	if (cursors.length !== 1) return undefined;

	const safetyText = nonblank.map(({ line }) => line).join("\n");
	if (FORBIDDEN_TEXT.test(safetyText) || SHELL_SYNTAX.test(safetyText) || PAGINATION.test(safetyText) || UNKNOWN_BINDING.test(safetyText)) return undefined;
	if (VISUAL_SEPARATOR.test(header.line) || parsedRows.some((row) => VISUAL_SEPARATOR.test(row.label))) return undefined;

	const labels = new Set<string>();
	const items: SemanticMultiSelectItem[] = [];
	for (let index = 0; index < parsedRows.length; index++) {
		const row = parsedRows[index]!;
		const label = row.label.trim();
		const normalized = label.toLocaleLowerCase("en-US");
		if (!label || label.length > MAX_SEMANTIC_MULTI_SELECT_LABEL_LENGTH || CONTROL.test(label)
			|| labels.has(normalized) || ROW.test(label) || FOOTER.test(label)) return undefined;
		labels.add(normalized);
		items.push(Object.freeze({ id: `multi_${index + 1}` as SemanticMultiSelectId, label, checked: row.checked }));
	}

	return Object.freeze({
		viewport: Object.freeze([...lines]),
		prompt: header.line,
		promptIndex: header.index,
		items: Object.freeze(items),
		cursorIndex: cursors[0]!,
		markerFamily: family,
		bindings: BINDINGS,
	});
}

function validateViewport(value: unknown): readonly string[] | undefined {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SEMANTIC_MULTI_SELECT_LINES) return undefined;
	if (!value.every((line) => typeof line === "string" && line.length <= MAX_SEMANTIC_MULTI_SELECT_LINE_LENGTH && !CONTROL.test(line))) return undefined;
	const lines = value as string[];
	return lines.join("\n").length <= MAX_SEMANTIC_MULTI_SELECT_VIEWPORT_LENGTH ? lines : undefined;
}

function parseRow(line: string): ParsedRow | undefined {
	const match = line.match(ROW);
	if (!match) return undefined;
	const marker = match[3]!;
	return {
		label: match[4]!,
		checked: marker === "[x]" || marker === "◉",
		cursor: match[2] !== undefined,
		family: marker.startsWith("[") ? "bracket" : "circle",
	};
}
