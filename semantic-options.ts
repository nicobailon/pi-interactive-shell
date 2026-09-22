/** A small, fail-closed extractor for options which are explicitly visible in a terminal viewport. */

import type { SemanticPermissionOperation } from "./semantic-permissions.ts";

export const MAX_SEMANTIC_OPTIONS = 10;
export const MAX_SEMANTIC_OPTION_LINES = 40;
export const MAX_SEMANTIC_OPTION_LABEL = 160;

export type SemanticOptionInput =
	| Readonly<{ kind: "text"; text: string; submit: true; bytes: string }>
	| Readonly<{ kind: "keys"; keys: readonly ("up" | "down" | "enter")[]; bytes: string }>
	| Readonly<{
		kind: "inline-confirmation";
		response: "y" | "n";
		bytes: "y" | "n";
		prompt: string;
		promptIndex: number;
		viewport: readonly string[];
	}>;

export type SemanticOption = Readonly<{
	id: string;
	label: string;
	input: SemanticOptionInput;
	operation: Extract<SemanticPermissionOperation, { kind: "dynamic-terminal-choice" | "dynamic-terminal-confirmation" }>;
}>;

const EMPTY_OPTIONS: readonly SemanticOption[] = Object.freeze([]);
const MAX_LINE_LENGTH = 240;
const MAX_VIEWPORT_LENGTH = 4_096;
const MAX_MENU_HEADER_LINES = 4;
const FORBIDDEN_TEXT = /\b(?:password|passphrase|credential|secret|token|api[ _-]?key|mfa|2fa|otp|one[- ]time|recovery code|pin|payment|credit card|shell|command|exec(?:ute)?|kill|signal|exit|quit|logout|shutdown|reboot|terminate|dispose|background|transfer|disown|suspend|job[ _-]?control|process control|abort|cancel)\b/i;
const FREE_FORM_PROMPT = /(?:\b(?:enter|type|provide|input|paste|write)\b[^\n]*[:?]\s*$|\b(?:name|email|message|value|text|response)\s*[:?]\s*$)/im;
const UNSUPPORTED_OPTION = /(?:\b(?:enter|type|provide|write)\b[^\n]*\b(?:something|own|custom|response|answer|text|message)\b|\b(?:chat|discuss|custom input)\b)/i;
const SHELL_SYNTAX = /(?:&&|\|\||[;`$<>]|\$\(|\b(?:sudo|sh|bash|zsh|fish|powershell|cmd\.exe)\b)/i;
const INLINE_DESTRUCTIVE_OPERATION = /\b(?:delete|remove|overwrite|drop|reset|erase|destroy|format|purge|abort|cancel|exit|kill|shutdown|start|stop|pause|resume|restart|reload)\b/i;
const INLINE_HINT = /\(\s*[yY]\s*\/\s*[nN]\s*\)/;
const INLINE_PROMPT = /^\s*(\S(?:[^?]*\S)?)\?\s*\(([Yy])\/([Nn])\)\s*$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\p{Cf}]/u;
const CANCEL_HELP = /\besc(?:ape)?(?:\s+key)?\s+(?:to\s+)?cancel\b/i;
const CANCEL_HELP_LINE = /^\s*esc(?:ape)?(?:\s+key)?\s+(?:to\s+)?cancel\s*$/i;
const VISUAL_SEPARATOR = /^\s*[\u2500-\u257f]{3,}\s*$/u;
const CHOICE_OPERATION = Object.freeze({ kind: "dynamic-terminal-choice" as const });
const CONFIRMATION_OPERATION = Object.freeze({ kind: "dynamic-terminal-confirmation" as const });

type ParsedOption = { selector: string; label: string };
type ExtractedSemanticOption = Omit<SemanticOption, "operation">;

/**
 * Extracts only conventional, directly evidenced menus. Any ambiguity or unsafe
 * terminal content returns an immutable empty list rather than a partial result.
 */
export function extractSemanticOptions(viewport: unknown): readonly SemanticOption[] {
	if (!Array.isArray(viewport) || viewport.length === 0 || viewport.length > MAX_SEMANTIC_OPTION_LINES) return EMPTY_OPTIONS;
	if (!viewport.every((line) => typeof line === "string" && line.length <= MAX_LINE_LENGTH && !CONTROL.test(line))) return EMPTY_OPTIONS;
	const lines = viewport as string[];
	const screen = lines.join("\n");
	if (screen.length > MAX_VIEWPORT_LENGTH) return EMPTY_OPTIONS;

	return extractInlineConfirmation(lines) ?? extractSelected(lines) ?? extractEnumerated(lines) ?? EMPTY_OPTIONS;
}

function extractInlineConfirmation(lines: readonly string[]): readonly SemanticOption[] | undefined {
	const hinted = lines.flatMap((line, index) => INLINE_HINT.test(line) ? [{ line, index }] : []);
	if (hinted.length === 0) return undefined;
	if (hinted.length !== 1) return EMPTY_OPTIONS;
	const candidate = hinted[0]!;
	const match = candidate.line.match(INLINE_PROMPT);
	if (!match || (match[2] === match[2]!.toLowerCase()) === (match[3] === match[3]!.toLowerCase())) return EMPTY_OPTIONS;
	if (lines.filter((line) => line.includes("?")).length !== 1) return EMPTY_OPTIONS;
	if (lines.slice(candidate.index + 1).some((line) => line.trim())) return EMPTY_OPTIONS;

	const snapshot = Object.freeze([...lines]);
	const promptIndex = candidate.index;
	const prompt = candidate.line;
	const safetyScreen = lines.join("\n");
	if (FORBIDDEN_TEXT.test(safetyScreen) || FREE_FORM_PROMPT.test(safetyScreen) || SHELL_SYNTAX.test(safetyScreen) || /[|&]/.test(safetyScreen)
		|| INLINE_DESTRUCTIVE_OPERATION.test(safetyScreen)) return EMPTY_OPTIONS;

	const makeInput = (response: "y" | "n") => Object.freeze({
		kind: "inline-confirmation" as const,
		response,
		bytes: response,
		prompt,
		promptIndex,
		viewport: snapshot,
	});
	return finish([
		Object.freeze({ id: "inline_yes", label: "Yes", input: makeInput("y") }),
		Object.freeze({ id: "inline_no", label: "No", input: makeInput("n") }),
	]);
}

function extractEnumerated(lines: readonly string[]): readonly SemanticOption[] | undefined {
	const screen = lines.join("\n");
	if (FORBIDDEN_TEXT.test(screen) || FREE_FORM_PROMPT.test(screen) || SHELL_SYNTAX.test(screen)) return EMPTY_OPTIONS;
	const matches: Array<ParsedOption & { kind: "number" | "letter"; style: string }> = [];
	let first = -1;
	let last = -1;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		const number = line.match(/^\s*(?:(\d{1,2})([.)])|\[(\d{1,2})\])\s+(.+?)\s*$/);
		const letter = line.match(/^\s*(?:([A-Za-z])([.)])|\[([A-Za-z])\])\s+(.+?)\s*$/);
		if (!number && !letter) continue;
		if (first < 0) first = index;
		last = index;
		if (number) {
			const bracketed = number[3] !== undefined;
			matches.push({ kind: "number", selector: (number[1] ?? number[3])!, style: bracketed ? "[]" : number[2]!, label: number[4]! });
		} else {
			const bracketed = letter![3] !== undefined;
			matches.push({ kind: "letter", selector: (letter![1] ?? letter![3])!, style: bracketed ? "[]" : letter![2]!, label: letter![4]! });
		}
	}
	if (matches.length === 0) return undefined;
	if (!validCount(matches.length) || last - first + 1 !== matches.length) return EMPTY_OPTIONS;
	const kind = matches[0]!.kind;
	const style = matches[0]!.style;
	if (matches.some((item) => item.kind !== kind || item.style !== style)) return EMPTY_OPTIONS;
	for (let index = 0; index < matches.length; index++) {
		const selector = matches[index]!.selector;
		if (kind === "number") {
			if (selector !== String(index + 1)) return EMPTY_OPTIONS;
		} else if (selector.toLowerCase() !== String.fromCharCode(97 + index)) return EMPTY_OPTIONS;
	}
	return finish(matches.map((item) => ({
		id: `${kind}_${item.selector.toLowerCase()}`,
		label: item.label,
		input: Object.freeze({ kind: "text" as const, text: item.selector, submit: true as const, bytes: `${item.selector}\r` }),
	})));
}

function extractSelected(lines: readonly string[]): readonly SemanticOption[] | undefined {
	const navigationIndexes = lines.flatMap((line, index) => isNavigationFooter(line) ? [index] : []);
	if (navigationIndexes.length === 0) return undefined;
	if (navigationIndexes.length !== 1) return EMPTY_OPTIONS;
	const navigationIndex = navigationIndexes[0]!;
	const numberedSelected = lines.flatMap((line, index) => {
		const match = line.match(/^(\s*)[>❯▶]\s+(\d{1,2})[.)]\s+(.+?)\s*$/);
		return match && index < navigationIndex ? [{ index, indent: match[1]!.length }] : [];
	});
	if (numberedSelected.length) {
		const current = numberedSelected.at(-1)!;
		return extractNumberedSelected(lines, current.index, current.indent, navigationIndex);
	}
	const selected = lines.flatMap((line, index) => {
		const match = line.match(/^(\s*)[>❯▶]\s+(.+?)\s*$/);
		return match ? [{ index, indent: match[1]!.length, label: match[2]! }] : [];
	});
	if (selected.length === 0) return undefined;
	if (selected.length !== 1) return EMPTY_OPTIONS;
	const navigationLine = lines[navigationIndex]!;
	const safeScreen = lines.map((line) => {
		if (line === navigationLine) return line.replace(CANCEL_HELP, "");
		return CANCEL_HELP_LINE.test(line) ? "" : line;
	}).join("\n");
	if (FORBIDDEN_TEXT.test(safeScreen) || SHELL_SYNTAX.test(safeScreen)) return EMPTY_OPTIONS;
	const current = selected[0]!;
	if (FREE_FORM_PROMPT.test(safeScreen)) return EMPTY_OPTIONS;
	const optionAt = (index: number): string | undefined => {
		if (index === current.index) return current.label;
		const match = lines[index]!.match(/^(\s+)(\S.*?)\s*$/);
		return match?.[1]?.length === current.indent + 2 ? match[2] : undefined;
	};
	let start = current.index;
	let end = current.index;
	while (start > 0 && optionAt(start - 1) !== undefined) start--;
	while (end + 1 < lines.length && optionAt(end + 1) !== undefined) end++;
	const count = end - start + 1;
	if (!validCount(count)) return EMPTY_OPTIONS;
	const options: ExtractedSemanticOption[] = [];
	for (let index = start; index <= end; index++) {
		const label = optionAt(index);
		if (label === undefined) return EMPTY_OPTIONS;
		const distance = index - current.index;
		const direction = distance < 0 ? "up" : "down";
		const keys = Object.freeze([
			...Array<"up" | "down">(Math.abs(distance)).fill(direction),
			"enter" as const,
		]);
		const bytes = `${distance < 0 ? "\x1b[A".repeat(-distance) : "\x1b[B".repeat(distance)}\r`;
		options.push(Object.freeze({ id: `menu_${index - start + 1}`, label, input: Object.freeze({ kind: "keys" as const, keys, bytes }) }));
	}
	return finish(options);
}

function extractNumberedSelected(lines: readonly string[], selectedIndex: number, markerIndent: number, navigationIndex: number): readonly SemanticOption[] {
	type MenuRow = { line: number; position: number; label: string; selected: boolean };
	const candidates: MenuRow[] = [];
	for (let index = 0; index < navigationIndex; index++) {
		const selected = lines[index]!.match(/^(\s*)[>❯▶]\s+(\d{1,2})[.)]\s+(.+?)\s*$/);
		const plain = lines[index]!.match(/^(\s+)(\d{1,2})[.)]\s+(.+?)\s*$/);
		if (selected) {
			if (selected[1]!.length !== markerIndent) return EMPTY_OPTIONS;
			candidates.push({ line: index, position: Number(selected[2]), label: selected[3]!, selected: true });
		} else if (plain && plain[1]!.length === markerIndent + 2) {
			candidates.push({ line: index, position: Number(plain[2]), label: plain[3]!, selected: false });
		}
	}
	if (candidates.filter((row) => row.position === 1).length !== 1 || candidates.filter((row) => row.selected).length !== 1) return EMPTY_OPTIONS;
	const firstRow = candidates.findIndex((row) => row.position === 1 && row.line <= selectedIndex);
	if (firstRow < 0) return EMPTY_OPTIONS;
	const rows = candidates.slice(firstRow);
	if (rows.filter((row) => row.selected).length !== 1 || rows.find((row) => row.selected)?.line !== selectedIndex || !validCount(rows.length)) return EMPTY_OPTIONS;
	for (let index = 0; index < rows.length; index++) if (rows[index]!.position !== index + 1) return EMPTY_OPTIONS;

	const precedingBoundary = lines.findLastIndex((line, index) => index < rows[0]!.line && !line.trim());
	const regionStart = precedingBoundary >= 0 ? precedingBoundary + 1 : Math.max(0, rows[0]!.line - MAX_MENU_HEADER_LINES);
	const regionEnd = navigationIndex + (CANCEL_HELP.test(lines[navigationIndex + 1] ?? "") ? 2 : 1);
	const safetyLines = lines.slice(regionStart, regionEnd).map((line, index) => {
		const absoluteIndex = regionStart + index;
		if (absoluteIndex === navigationIndex) return line.replace(CANCEL_HELP, "");
		return CANCEL_HELP_LINE.test(line) ? "" : line;
	});
	const safetyScreen = safetyLines.join("\n");
	if (FORBIDDEN_TEXT.test(safetyScreen) || SHELL_SYNTAX.test(safetyScreen)) return EMPTY_OPTIONS;

	const selectedPosition = rows.findIndex((row) => row.selected);
	const options: ExtractedSemanticOption[] = [];
	const freeFormLines = [...safetyLines];
	for (let index = 0; index < rows.length; index++) {
		const row = rows[index]!;
		const end = index + 1 < rows.length ? rows[index + 1]!.line : navigationIndex;
		if (end <= row.line) return EMPTY_OPTIONS;
		const descriptions: string[] = [];
		let separatorSeen = false;
		for (let line = row.line + 1; line < end; line++) {
			if (!lines[line]!.trim()) continue;
			if (VISUAL_SEPARATOR.test(lines[line]!)) {
				const next = rows[index + 1];
				if (separatorSeen || !UNSUPPORTED_OPTION.test(row.label) || !next || !UNSUPPORTED_OPTION.test(next.label)
					|| lines.slice(line + 1, end).some((item) => item.trim())) return EMPTY_OPTIONS;
				separatorSeen = true;
				continue;
			}
			const description = lines[line]!.match(/^(\s+)(\S.*?)\s*$/);
			if (!description || description[1]!.length <= markerIndent + 2) return EMPTY_OPTIONS;
			descriptions.push(description[2]!);
		}
		const label = [row.label, ...descriptions].join(" ");
		if (UNSUPPORTED_OPTION.test(label)) {
			freeFormLines.fill("", row.line - regionStart, end - regionStart);
			continue;
		}
		const distance = index - selectedPosition;
		const direction = distance < 0 ? "up" : "down";
		const keys = Object.freeze([...Array<"up" | "down">(Math.abs(distance)).fill(direction), "enter" as const]);
		const bytes = `${distance < 0 ? "\x1b[A".repeat(-distance) : "\x1b[B".repeat(distance)}\r`;
		options.push(Object.freeze({ id: `menu_${row.position}`, label, input: Object.freeze({ kind: "keys" as const, keys, bytes }) }));
	}
	if (FREE_FORM_PROMPT.test(freeFormLines.join("\n"))) return EMPTY_OPTIONS;
	if (!validCount(options.length)) return EMPTY_OPTIONS;
	return finish(options);
}

function finish(options: readonly ExtractedSemanticOption[]): readonly SemanticOption[] {
	const labels = new Set<string>();
	const inputs = new Set<string>();
	for (const option of options) {
		const label = option.label.trim();
		const normalized = label.toLocaleLowerCase("en-US");
		if (!label || label.length > MAX_SEMANTIC_OPTION_LABEL || CONTROL.test(label) || FORBIDDEN_TEXT.test(label) || SHELL_SYNTAX.test(label)
			|| labels.has(normalized) || inputs.has(option.input.bytes) || Buffer.byteLength(option.input.bytes) > 64) return EMPTY_OPTIONS;
		labels.add(normalized);
		inputs.add(option.input.bytes);
	}
	const confirmationLabels = [...labels];
	const confirmation = confirmationLabels.length === 2
		&& confirmationLabels.some((label) => /^yes(?:,\s+\S.*)?$/.test(label))
		&& confirmationLabels.some((label) => /^no(?:,\s+\S.*)?$/.test(label));
	if (!confirmation && confirmationLabels.some((label) => /^(?:yes|no)\b/.test(label))) return EMPTY_OPTIONS;
	const operation = confirmation
		? CONFIRMATION_OPERATION
		: CHOICE_OPERATION;
	return Object.freeze(options.map((option) => Object.freeze({ ...option, operation })));
}

function validCount(count: number): boolean {
	return count >= 2 && count <= MAX_SEMANTIC_OPTIONS;
}

function isNavigationFooter(line: string): boolean {
	return /(?:↑|\bup\b)/i.test(line) && /(?:↓|\bdown\b)/i.test(line)
		&& /\b(?:enter|return)\b/i.test(line) && /\b(?:select|choose|confirm)\b/i.test(line);
}
