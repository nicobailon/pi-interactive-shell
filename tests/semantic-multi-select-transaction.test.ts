import { describe, expect, it } from "vitest";
import {
	advanceMultiSelectTransaction,
	beginMultiSelectTransaction,
	type MultiSelectTransaction,
	type MultiSelectTransactionResult,
	type MultiSelectWrite,
	type SemanticMultiSelectSnapshot,
} from "../semantic-multi-select-transaction.ts";

const rows = [
	{ id: "alpha", text: "Alpha", checked: true },
	{ id: "beta", text: "Beta", checked: false },
	{ id: "gamma", text: "Gamma", checked: true },
] as const;

function snapshot(cursorIndex = 0, items: readonly { id: string; text: string; checked: boolean }[] = rows): SemanticMultiSelectSnapshot {
	return {
		before: ["Choose features", "workspace: demo"],
		prompt: { id: "feature-prompt", text: "Features", cursorIndex, items },
		after: ["Space toggles · Enter submits"],
	};
}

function renderedAfter(state: SemanticMultiSelectSnapshot, write: MultiSelectWrite): SemanticMultiSelectSnapshot {
	if (write === "Enter") return { before: ["Saved"], prompt: null, after: [] };
	const prompt = state.prompt!;
	const cursorIndex = write === "ArrowUp" ? prompt.cursorIndex - 1
		: write === "ArrowDown" ? prompt.cursorIndex + 1
		: prompt.cursorIndex;
	const items = prompt.items.map((item, index) => ({
		...item,
		checked: write === "Space" && index === prompt.cursorIndex ? !item.checked : item.checked,
	}));
	return { ...state, prompt: { ...prompt, cursorIndex, items } };
}

function execute(initial: SemanticMultiSelectSnapshot, desired: readonly string[]) {
	const writes: MultiSelectWrite[] = [];
	let state = initial;
	let result = beginMultiSelectTransaction(initial, desired);
	while (result.kind === "next-write") {
		writes.push(result.write);
		state = renderedAfter(state, result.write);
		result = advanceMultiSelectTransaction(result.transaction, state);
	}
	return { writes, result };
}

function expectNext(result: MultiSelectTransactionResult): Extract<MultiSelectTransactionResult, { kind: "next-write" }> {
	expect(result.kind).toBe("next-write");
	return result as Extract<MultiSelectTransactionResult, { kind: "next-write" }>;
}

describe("bounded semantic multi-select transaction", () => {
	it.each([
		["nonempty initial to only Beta", snapshot(2), ["beta"], ["ArrowUp", "ArrowUp", "Space", "ArrowDown", "Space", "ArrowDown", "Space", "Enter"]],
		["empty target", snapshot(1), [], ["ArrowUp", "Space", "ArrowDown", "ArrowDown", "Space", "Enter"]],
		["already-correct target", snapshot(1), ["alpha", "gamma"], ["Enter"]],
	] as const)("plans %s", (_name, initial, desired, expected) => {
		const { writes, result } = execute(initial, desired);
		expect(writes).toEqual(expected);
		expect(result).toMatchObject({ kind: "complete", steps: expected.length });
		expect(writes.length).toBeLessThanOrEqual(3 * rows.length + 1);
	});

	it.each([
		["up", snapshot(2), ["beta", "gamma"], "ArrowUp"],
		["down", snapshot(0), ["alpha", "beta", "gamma"], "ArrowDown"],
	] as const)("uses adjacent non-wrapping navigation %s", (_name, initial, desired, expected) => {
		expect(expectNext(beginMultiSelectTransaction(initial, desired)).write).toBe(expected);
	});

	it("toggles only the item at the cursor, then submits and requires disappearance", () => {
		const first = expectNext(beginMultiSelectTransaction(snapshot(1), ["alpha", "beta", "gamma"]));
		expect(first.write).toBe("Space");
		const toggled = renderedAfter(first.transaction.snapshot, "Space");
		expect(toggled.prompt!.items.map((item) => item.checked)).toEqual([true, true, true]);
		const submit = expectNext(advanceMultiSelectTransaction(first.transaction, toggled));
		expect(submit.write).toBe("Enter");
		expect(advanceMultiSelectTransaction(submit.transaction, toggled)).toEqual({
			kind: "blocked", reason: "prompt-still-present", steps: 2,
		});
		const gone = { before: ["Saved"], prompt: null, after: [] };
		expect(advanceMultiSelectTransaction(submit.transaction, gone)).toMatchObject({ kind: "complete", steps: 2 });
	});

	it.each([
		["unchanged redraw", (state: SemanticMultiSelectSnapshot) => state],
		["wrong cursor", (state: SemanticMultiSelectSnapshot) => ({ ...state, prompt: { ...state.prompt!, cursorIndex: 0 } })],
		["wrong checked row", (state: SemanticMultiSelectSnapshot) => ({ ...state, prompt: { ...state.prompt!, items: state.prompt!.items.map((item, index) => ({ ...item, checked: index === 2 ? false : item.checked })) } })],
		["changed option text", (state: SemanticMultiSelectSnapshot) => ({ ...state, prompt: { ...state.prompt!, items: state.prompt!.items.map((item, index) => index === 2 ? { ...item, text: "Changed" } : item) } })],
		["context change", (state: SemanticMultiSelectSnapshot) => ({ ...state, before: ["Different task"] })],
	] as const)("blocks %s", (_name, change) => {
		const initial = snapshot(1);
		const next = expectNext(beginMultiSelectTransaction(initial, ["alpha", "beta", "gamma"]));
		expect(next.write).toBe("Space");
		expect(advanceMultiSelectTransaction(next.transaction, change(initial))).toEqual({
			kind: "blocked", reason: "transition-mismatch", steps: 1,
		});
	});

	it.each([
		["missing prompt", { before: [], prompt: null, after: [] }, [], "malformed-state"],
		["empty items", { before: [], prompt: { id: "p", text: "P", cursorIndex: 0, items: [] }, after: [] }, [], "malformed-state"],
		["out-of-range cursor", { ...snapshot(), prompt: { ...snapshot().prompt!, cursorIndex: 3 } }, [], "malformed-state"],
		["duplicate state IDs", snapshot(0, [{ id: "alpha", text: "A", checked: false }, { id: "alpha", text: "A2", checked: true }]), [], "ambiguous-state"],
		["non-array target", snapshot(), "beta", "malformed-target"],
		["empty target ID", snapshot(), [""], "malformed-target"],
		["duplicate target ID", snapshot(), ["beta", "beta"], "duplicate-target-id"],
		["unknown target ID", snapshot(), ["delta"], "unknown-target-id"],
	] as const)("blocks malformed/ambiguous input: %s", (_name, initial, desired, reason) => {
		expect(beginMultiSelectTransaction(initial, desired)).toEqual({ kind: "blocked", reason, steps: 0 });
	});

	it("copies and freezes the plan state instead of retaining mutable inputs", () => {
		const source = snapshot(1);
		const result = expectNext(beginMultiSelectTransaction(source, ["beta"]));
		expect(Object.isFrozen(result.transaction)).toBe(true);
		expect(Object.isFrozen(result.transaction.snapshot)).toBe(true);
		expect(Object.isFrozen(result.transaction.snapshot.prompt!.items)).toBe(true);
		expect(result.transaction.snapshot).not.toBe(source);
	});

	it("enforces the 3*N+1 step ceiling", () => {
		const first = expectNext(beginMultiSelectTransaction(snapshot(1), ["alpha", "beta", "gamma"]));
		const atLimit: MultiSelectTransaction = { ...first.transaction, steps: first.transaction.maxSteps };
		const exactToggle = renderedAfter(first.transaction.snapshot, first.write);
		expect(advanceMultiSelectTransaction(atLimit, exactToggle)).toEqual({
			kind: "blocked", reason: "step-overflow", steps: 10,
		});
		expect(first.transaction.maxSteps).toBe(3 * rows.length + 1);
	});
});
