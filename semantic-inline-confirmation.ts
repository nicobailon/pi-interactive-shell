import { MAX_SEMANTIC_OPTION_LABEL, MAX_SEMANTIC_OPTION_LINES } from "./semantic-options.ts";

const MAX_LINE_LENGTH = 240;
const MAX_VIEWPORT_LENGTH = 4_096;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\p{Cf}]/u;

export type InlineConfirmationSelection = "y" | "n";

/** An exact, immutable snapshot taken before a single inline confirmation key is sent. */
export type InlineConfirmationPlan = Readonly<{
	initialViewport: readonly string[];
	prompt: string;
	selection: InlineConfirmationSelection;
	promptLine: number;
}>;

export type InlineConfirmationBlockedReason =
	| "invalid-plan"
	| "invalid-viewport"
	| "ambiguous-prompt"
	| "unchanged-prompt"
	| "wrong-echo"
	| "extra-edit"
	| "unrelated-redraw";

export type InlineConfirmationTransition =
	| Readonly<{ kind: "submit" }>
	| Readonly<{ kind: "complete" }>
	| Readonly<{ kind: "blocked"; reason: InlineConfirmationBlockedReason }>;

const SUBMIT: InlineConfirmationTransition = Object.freeze({ kind: "submit" });
const COMPLETE: InlineConfirmationTransition = Object.freeze({ kind: "complete" });
const blocked = (reason: InlineConfirmationBlockedReason): InlineConfirmationTransition => Object.freeze({ kind: "blocked", reason });

/**
 * Captures the exact viewport and prompt for one y/n transaction. Invalid,
 * ambiguous, controlled, or oversized input cannot produce a plan.
 */
export function createInlineConfirmationPlan(
	initialViewport: unknown,
	prompt: unknown,
	selection: unknown,
): InlineConfirmationPlan | undefined {
	const viewport = validateViewport(initialViewport);
	if (!viewport || typeof prompt !== "string" || !prompt || prompt.length > MAX_SEMANTIC_OPTION_LABEL
		|| CONTROL.test(prompt) || (selection !== "y" && selection !== "n")) return undefined;
	const promptLines = matchingPromptLines(viewport, prompt);
	if (promptLines.length !== 1 || viewport[promptLines[0]!] !== prompt) return undefined;
	return Object.freeze({
		initialViewport: Object.freeze([...viewport]),
		prompt,
		selection,
		promptLine: promptLines[0]!,
	});
}

/**
 * Purely verifies the first trusted render after the selected character. It
 * never performs terminal I/O: callers may submit Enter only for `submit`.
 */
export function verifyInlineConfirmationTransition(
	plan: InlineConfirmationPlan,
	nextViewport: unknown,
): InlineConfirmationTransition {
	if (!validPlan(plan)) return blocked("invalid-plan");
	const next = validateViewport(nextViewport);
	if (!next) return blocked("invalid-viewport");

	const promptLines = matchingPromptLines(next, plan.prompt);
	if (promptLines.length > 1) return blocked("ambiguous-prompt");
	if (promptLines.length === 0) return COMPLETE;

	const promptLine = promptLines[0]!;
	const renderedPrompt = next[promptLine]!;
	if (sameViewport(next, plan.initialViewport)) return blocked("unchanged-prompt");
	if (promptLine !== plan.promptLine || next.length !== plan.initialViewport.length) return blocked("unrelated-redraw");

	const expectedEcho = `${plan.prompt}${plan.selection}`;
	if (renderedPrompt !== expectedEcho) {
		if (renderedPrompt === plan.prompt || renderedPrompt.length === expectedEcho.length) return blocked("wrong-echo");
		return blocked("extra-edit");
	}
	for (let index = 0; index < next.length; index++) {
		if (index !== promptLine && next[index] !== plan.initialViewport[index]) return blocked("unrelated-redraw");
	}
	return SUBMIT;
}

function validateViewport(value: unknown): readonly string[] | undefined {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SEMANTIC_OPTION_LINES) return undefined;
	if (!value.every((line) => typeof line === "string" && line.length <= MAX_LINE_LENGTH && !CONTROL.test(line))) return undefined;
	const viewport = value as string[];
	return viewport.join("\n").length <= MAX_VIEWPORT_LENGTH ? viewport : undefined;
}

function matchingPromptLines(viewport: readonly string[], prompt: string): number[] {
	const matches: number[] = [];
	for (let index = 0; index < viewport.length; index++) {
		if (viewport[index]!.startsWith(prompt)) matches.push(index);
	}
	return matches;
}

function sameViewport(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((line, index) => line === right[index]);
}

function validPlan(value: unknown): value is InlineConfirmationPlan {
	if (typeof value !== "object" || value === null) return false;
	const plan = value as Partial<InlineConfirmationPlan>;
	const viewport = validateViewport(plan.initialViewport);
	if (!viewport || typeof plan.prompt !== "string" || !plan.prompt || plan.prompt.length > MAX_SEMANTIC_OPTION_LABEL
		|| CONTROL.test(plan.prompt) || (plan.selection !== "y" && plan.selection !== "n")
		|| !Number.isSafeInteger(plan.promptLine) || plan.promptLine! < 0 || plan.promptLine! >= viewport.length) return false;
	const promptLines = matchingPromptLines(viewport, plan.prompt);
	return promptLines.length === 1 && promptLines[0] === plan.promptLine && viewport[plan.promptLine] === plan.prompt;
}
