export type MultiSelectWrite = "ArrowUp" | "ArrowDown" | "Space" | "Enter";

/**
 * A normalized semantic snapshot of the entire viewport. Adapters retain every
 * non-option line in `before`/`after` and every rendered option field in
 * `items`, so unrelated redraws remain observable without coupling this pure
 * component to a terminal renderer.
 */
export interface SemanticMultiSelectSnapshot {
	readonly before: readonly string[];
	readonly prompt: SemanticMultiSelectPromptSnapshot | null;
	readonly after: readonly string[];
}

export interface SemanticMultiSelectPromptSnapshot {
	readonly id: string;
	readonly text: string;
	readonly cursorIndex: number;
	readonly items: readonly SemanticMultiSelectItemSnapshot[];
}

export interface SemanticMultiSelectItemSnapshot {
	readonly id: string;
	readonly text: string;
	readonly checked: boolean;
}

export interface MultiSelectTransaction {
	readonly snapshot: SemanticMultiSelectSnapshot;
	readonly desiredIds: readonly string[];
	readonly steps: number;
	readonly maxSteps: number;
	readonly pending: MultiSelectWrite;
}

export type MultiSelectBlockedReason =
	| "malformed-state"
	| "ambiguous-state"
	| "malformed-target"
	| "duplicate-target-id"
	| "unknown-target-id"
	| "invalid-transaction"
	| "transition-mismatch"
	| "prompt-still-present"
	| "step-overflow";

export type MultiSelectTransactionResult =
	| Readonly<{ kind: "next-write"; write: MultiSelectWrite; transaction: MultiSelectTransaction }>
	| Readonly<{ kind: "complete"; steps: number; snapshot: SemanticMultiSelectSnapshot }>
	| Readonly<{ kind: "blocked"; reason: MultiSelectBlockedReason; steps: number }>;

/** Validates an exact initial render and returns the first (unperformed) write. */
export function beginMultiSelectTransaction(
	initial: unknown,
	desiredIds: unknown,
): MultiSelectTransactionResult {
	const stateProblem = snapshotProblem(initial, true);
	if (stateProblem) return blocked(stateProblem, 0);
	const snapshot = cloneSnapshot(initial as SemanticMultiSelectSnapshot);
	const targetProblem = desiredProblem(desiredIds, snapshot.prompt!.items);
	if (targetProblem) return blocked(targetProblem, 0);
	return schedule(snapshot, Object.freeze([...(desiredIds as string[])]), 0, 3 * snapshot.prompt!.items.length + 1);
}

/**
 * Verifies exactly one render following the previously returned write, then
 * either supplies the next write, completes, or fails closed.
 */
export function advanceMultiSelectTransaction(
	transaction: unknown,
	observed: unknown,
): MultiSelectTransactionResult {
	if (!validTransaction(transaction)) return blocked("invalid-transaction", transactionSteps(transaction));
	const current = transaction as MultiSelectTransaction;

	if (current.pending === "Enter") {
		const problem = snapshotProblem(observed, false);
		if (problem) return blocked(problem, current.steps);
		const next = observed as SemanticMultiSelectSnapshot;
		if (next.prompt !== null) return blocked("prompt-still-present", current.steps);
		return Object.freeze({ kind: "complete", steps: current.steps, snapshot: cloneSnapshot(next) });
	}

	const problem = snapshotProblem(observed, true);
	if (problem) return blocked(problem, current.steps);
	const next = observed as SemanticMultiSelectSnapshot;
	if (!matchesExpectedTransition(current.snapshot, next, current.pending)) {
		return blocked("transition-mismatch", current.steps);
	}
	return schedule(cloneSnapshot(next), current.desiredIds, current.steps, current.maxSteps);
}

function schedule(
	snapshot: SemanticMultiSelectSnapshot,
	desiredIds: readonly string[],
	steps: number,
	maxSteps: number,
): MultiSelectTransactionResult {
	const write = nextWrite(snapshot.prompt!, new Set(desiredIds));
	if (steps >= maxSteps) return blocked("step-overflow", steps);
	const transaction: MultiSelectTransaction = Object.freeze({
		snapshot,
		desiredIds,
		steps: steps + 1,
		maxSteps,
		pending: write,
	});
	return Object.freeze({ kind: "next-write", write, transaction });
}

function nextWrite(prompt: SemanticMultiSelectPromptSnapshot, desired: ReadonlySet<string>): MultiSelectWrite {
	const mismatch = prompt.items.findIndex((item) => item.checked !== desired.has(item.id));
	if (mismatch < 0) return "Enter";
	if (prompt.cursorIndex > mismatch) return "ArrowUp";
	if (prompt.cursorIndex < mismatch) return "ArrowDown";
	return "Space";
}

function matchesExpectedTransition(
	previous: SemanticMultiSelectSnapshot,
	next: SemanticMultiSelectSnapshot,
	write: Exclude<MultiSelectWrite, "Enter">,
): boolean {
	const oldPrompt = previous.prompt!;
	const expectedCursor = write === "ArrowUp" ? oldPrompt.cursorIndex - 1
		: write === "ArrowDown" ? oldPrompt.cursorIndex + 1
		: oldPrompt.cursorIndex;
	if (expectedCursor < 0 || expectedCursor >= oldPrompt.items.length) return false;
	if (!sameStrings(previous.before, next.before) || !sameStrings(previous.after, next.after)) return false;
	const prompt = next.prompt!;
	if (prompt.id !== oldPrompt.id || prompt.text !== oldPrompt.text || prompt.cursorIndex !== expectedCursor
		|| prompt.items.length !== oldPrompt.items.length) return false;
	return prompt.items.every((item, index) => {
		const prior = oldPrompt.items[index]!;
		return item.id === prior.id && item.text === prior.text
			&& item.checked === (write === "Space" && index === oldPrompt.cursorIndex ? !prior.checked : prior.checked);
	});
}

function snapshotProblem(value: unknown, requirePrompt: boolean): "malformed-state" | "ambiguous-state" | undefined {
	if (!isRecord(value) || !stringArray(value.before) || !stringArray(value.after)) return "malformed-state";
	if (value.prompt === null) return requirePrompt ? "malformed-state" : undefined;
	if (!isRecord(value.prompt) || !nonemptyString(value.prompt.id) || !nonemptyString(value.prompt.text)
		|| !Number.isSafeInteger(value.prompt.cursorIndex) || !Array.isArray(value.prompt.items)
		|| value.prompt.items.length === 0 || value.prompt.cursorIndex as number < 0
		|| value.prompt.cursorIndex as number >= value.prompt.items.length) return "malformed-state";
	const ids = new Set<string>();
	for (const item of value.prompt.items) {
		if (!isRecord(item) || !nonemptyString(item.id) || typeof item.text !== "string" || typeof item.checked !== "boolean") {
			return "malformed-state";
		}
		if (ids.has(item.id)) return "ambiguous-state";
		ids.add(item.id);
	}
	return undefined;
}

function desiredProblem(
	value: unknown,
	items: readonly SemanticMultiSelectItemSnapshot[],
): "malformed-target" | "duplicate-target-id" | "unknown-target-id" | undefined {
	if (!Array.isArray(value)) return "malformed-target";
	const known = new Set(items.map((item) => item.id));
	const seen = new Set<string>();
	for (const id of value) {
		if (!nonemptyString(id)) return "malformed-target";
		if (seen.has(id)) return "duplicate-target-id";
		if (!known.has(id)) return "unknown-target-id";
		seen.add(id);
	}
	return undefined;
}

function validTransaction(value: unknown): value is MultiSelectTransaction {
	if (!isRecord(value) || snapshotProblem(value.snapshot, true) || !Array.isArray(value.desiredIds)
		|| desiredProblem(value.desiredIds, (value.snapshot as SemanticMultiSelectSnapshot).prompt!.items)
		|| !Number.isSafeInteger(value.steps) || !Number.isSafeInteger(value.maxSteps)) return false;
	const transaction = value as unknown as MultiSelectTransaction;
	if (transaction.steps < 1 || transaction.maxSteps !== 3 * transaction.snapshot.prompt!.items.length + 1
		|| transaction.steps > transaction.maxSteps || !isWrite(transaction.pending)) return false;
	return nextWrite(transaction.snapshot.prompt!, new Set(transaction.desiredIds)) === transaction.pending;
}

function cloneSnapshot(value: SemanticMultiSelectSnapshot): SemanticMultiSelectSnapshot {
	const prompt = value.prompt === null ? null : Object.freeze({
		id: value.prompt.id,
		text: value.prompt.text,
		cursorIndex: value.prompt.cursorIndex,
		items: Object.freeze(value.prompt.items.map((item) => Object.freeze({ ...item }))),
	});
	return Object.freeze({
		before: Object.freeze([...value.before]),
		prompt,
		after: Object.freeze([...value.after]),
	});
}

function blocked(reason: MultiSelectBlockedReason, steps: number): MultiSelectTransactionResult {
	return Object.freeze({ kind: "blocked", reason, steps });
}

function transactionSteps(value: unknown): number {
	return isRecord(value) && Number.isSafeInteger(value.steps) && (value.steps as number) >= 0 ? value.steps as number : 0;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((line, index) => line === right[index]);
}

function stringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function nonemptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isWrite(value: unknown): value is MultiSelectWrite {
	return value === "ArrowUp" || value === "ArrowDown" || value === "Space" || value === "Enter";
}
