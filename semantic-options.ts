/** A small, fail-closed extractor for options which are explicitly visible in a terminal viewport. */

import type { SemanticPermissionOperation } from "./semantic-permissions.ts";

export const MAX_SEMANTIC_OPTIONS = 10;
export const MAX_SEMANTIC_OPTION_LINES = 40;
export const MAX_SEMANTIC_OPTION_LABEL = 160;

export type SemanticOptionInput =
	| Readonly<{ kind: "text"; text: string; submit: true; bytes: string }>
	| Readonly<{ kind: "keys"; keys: readonly ("up" | "down" | "enter")[]; bytes: string }>;

export type SemanticOption = Readonly<{
	id: string;
	label: string;
	input: SemanticOptionInput;
	operation: Extract<SemanticPermissionOperation, { kind: "dynamic-terminal-choice" | "dynamic-terminal-confirmation" }>;
}>;

const EMPTY_OPTIONS: readonly SemanticOption[] = Object.freeze([]);
const MAX_LINE_LENGTH = 240;
const MAX_VIEWPORT_LENGTH = 4_096;
const FORBIDDEN_TEXT = /\b(?:password|passphrase|credential|secret|token|api[ _-]?key|mfa|2fa|otp|one[- ]time|recovery code|pin|payment|credit card|shell|command|exec(?:ute)?|kill|signal|exit|quit|logout|shutdown|reboot|terminate|dispose|background|transfer|disown|suspend|job[ _-]?control|process control|abort|cancel)\b/i;
const FREE_FORM_PROMPT = /(?:\b(?:enter|type|provide|input|paste|write)\b[^\n]*[:?]\s*$|\b(?:name|email|message|value|text|response)\s*[:?]\s*$)/im;
const SHELL_SYNTAX = /(?:&&|\|\||[;`$<>]|\$\(|\b(?:sudo|sh|bash|zsh|fish|powershell|cmd\.exe)\b)/i;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\p{Cf}]/u;
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
	if (screen.length > MAX_VIEWPORT_LENGTH || FORBIDDEN_TEXT.test(screen) || FREE_FORM_PROMPT.test(screen) || SHELL_SYNTAX.test(screen)) return EMPTY_OPTIONS;

	return extractEnumerated(lines) ?? extractSelected(lines) ?? EMPTY_OPTIONS;
}

function extractEnumerated(lines: readonly string[]): readonly SemanticOption[] | undefined {
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
	const selected = lines.flatMap((line, index) => {
		const match = line.match(/^(\s*)[>❯▶]\s+(.+?)\s*$/);
		return match ? [{ index, indent: match[1]!.length, label: match[2]! }] : [];
	});
	if (selected.length === 0) return undefined;
	if (selected.length !== 1) return EMPTY_OPTIONS;
	const navigationEvidence = lines.some((line) => /(?:↑|\bup\b)/i.test(line) && /(?:↓|\bdown\b)/i.test(line)
		&& /\b(?:enter|return)\b/i.test(line) && /\b(?:select|choose|confirm)\b/i.test(line));
	if (!navigationEvidence) return EMPTY_OPTIONS;
	const current = selected[0]!;
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
	const operation = labels.size === 2 && labels.has("yes") && labels.has("no")
		? CONFIRMATION_OPERATION
		: CHOICE_OPERATION;
	return Object.freeze(options.map((option) => Object.freeze({ ...option, operation })));
}

function validCount(count: number): boolean {
	return count >= 2 && count <= MAX_SEMANTIC_OPTIONS;
}
