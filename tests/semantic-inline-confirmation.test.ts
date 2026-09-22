import { describe, expect, it } from "vitest";
import {
	createInlineConfirmationPlan,
	verifyInlineConfirmationTransition,
	type InlineConfirmationTransition,
} from "../semantic-inline-confirmation.ts";

const initial = ["Deploy preview", "Continue? (y/n) ", "Status: waiting"];
const prompt = initial[1]!;

function plan(selection: "y" | "n" = "y") {
	return createInlineConfirmationPlan(initial, prompt, selection)!;
}

function result(next: unknown, selection: "y" | "n" = "y"): InlineConfirmationTransition {
	return verifyInlineConfirmationTransition(plan(selection), next);
}

describe("inline confirmation transition verifier", () => {
	it("creates a bounded immutable plan from the exact prompt snapshot", () => {
		const source = [...initial];
		const transaction = createInlineConfirmationPlan(source, prompt, "n");
		expect(transaction).toEqual({ initialViewport: initial, prompt, selection: "n", promptLine: 1 });
		expect(Object.isFrozen(transaction)).toBe(true);
		expect(Object.isFrozen(transaction!.initialViewport)).toBe(true);
		source[0] = "mutated after capture";
		expect(transaction!.initialViewport[0]).toBe("Deploy preview");
	});

	it.each([
		["immediate-key removal", ["Deploy preview", "Status: accepted"], { kind: "complete" }, "y"],
		["immediate-key replacement", ["Deploy preview", "Continuing...", "Status: accepted"], { kind: "complete" }, "y"],
		["exact yes echo", ["Deploy preview", "Continue? (y/n) y", "Status: waiting"], { kind: "submit" }, "y"],
		["exact no echo", ["Deploy preview", "Continue? (y/n) n", "Status: waiting"], { kind: "submit" }, "n"],
		["unchanged prompt", initial, { kind: "blocked", reason: "unchanged-prompt" }, "y"],
		["wrong character", ["Deploy preview", "Continue? (y/n) n", "Status: waiting"], { kind: "blocked", reason: "wrong-echo" }, "y"],
		["extra prompt edit", ["Deploy preview", "Continue? (y/n) yes", "Status: waiting"], { kind: "blocked", reason: "extra-edit" }, "y"],
		["context edit", ["Different task", "Continue? (y/n) y", "Status: waiting"], { kind: "blocked", reason: "unrelated-redraw" }, "y"],
		["spinner-only unrelated change", ["Deploy preview", "Continue? (y/n) y", "Status: waiting ⠋"], { kind: "blocked", reason: "unrelated-redraw" }, "y"],
		["duplicated prompt", ["Continue? (y/n) ", "Continue? (y/n) y", "Status: waiting"], { kind: "blocked", reason: "ambiguous-prompt" }, "y"],
	] as const)("classifies %s", (_name, next, expected, selection) => {
		expect(result(next, selection)).toEqual(expected);
	});

	it.each([
		["control in initial state", ["Deploy\u0000 preview", prompt], prompt, "y"],
		["control in prompt", ["Deploy preview", "Continue?\u001b (y/n) "], "Continue?\u001b (y/n) ", "y"],
		["unsupported selection", initial, prompt, "Y"],
		["too many lines", Array.from({ length: 41 }, (_, index) => index === 20 ? prompt : `line ${index}`), prompt, "y"],
		["oversized line", ["x".repeat(241), prompt], prompt, "y"],
		["oversized prompt", ["p".repeat(161)], "p".repeat(161), "n"],
		["ambiguous initial prompt", [prompt, prompt], prompt, "n"],
	] as const)("rejects %s without creating a transaction", (_name, viewport, exactPrompt, selection) => {
		expect(createInlineConfirmationPlan(viewport, exactPrompt, selection)).toBeUndefined();
	});

	it.each([
		["control-bearing next state", ["Deploy preview", "Continue? (y/n) y", "Status:\u001b waiting"]],
		["too many next lines", Array.from({ length: 41 }, (_, index) => `line ${index}`)],
		["oversized next line", ["x".repeat(241)]],
		["oversized aggregate state", Array.from({ length: 20 }, () => "x".repeat(220))],
	] as const)("blocks %s", (_name, next) => {
		expect(result(next)).toEqual({ kind: "blocked", reason: "invalid-viewport" });
	});

	it("fails closed for forged or mutated plans", () => {
		const forged = { ...plan(), promptLine: 0 };
		expect(verifyInlineConfirmationTransition(forged, ["Deploy preview", "Continue? (y/n) y", "Status: waiting"]))
			.toEqual({ kind: "blocked", reason: "invalid-plan" });
	});
});
