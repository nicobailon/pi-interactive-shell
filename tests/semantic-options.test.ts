import { describe, expect, it } from "vitest";
import { extractSemanticOptions } from "../semantic-options.ts";

describe("semantic option extraction", () => {
	it("binds sequential numbered and lettered choices to their exact visible selector", () => {
		const numbered = extractSemanticOptions(["Choose a color:", "1. Red", "2. Blue"]);
		expect(numbered).toEqual([
			{ id: "number_1", label: "Red", input: { kind: "text", text: "1", submit: true, bytes: "1\r" }, operation: { kind: "dynamic-terminal-choice" } },
			{ id: "number_2", label: "Blue", input: { kind: "text", text: "2", submit: true, bytes: "2\r" }, operation: { kind: "dynamic-terminal-choice" } },
		]);
		const letters = extractSemanticOptions(["[A] Alpha", "[B] Beta"]);
		expect(letters.map(({ id, input }) => ({ id, input }))).toEqual([
			{ id: "letter_a", input: { kind: "text", text: "A", submit: true, bytes: "A\r" } },
			{ id: "letter_b", input: { kind: "text", text: "B", submit: true, bytes: "B\r" } },
		]);
	});

	it("maps a single visibly selected menu to bounded navigation keys and bytes", () => {
		const options = extractSemanticOptions(["Choose:", "    First", "  ❯ Second", "    Third", "↑/↓ move • enter to select"]);
		expect(options).toEqual([
			{ id: "menu_1", label: "First", input: { kind: "keys", keys: ["up", "enter"], bytes: "\x1b[A\r" }, operation: { kind: "dynamic-terminal-choice" } },
			{ id: "menu_2", label: "Second", input: { kind: "keys", keys: ["enter"], bytes: "\r" }, operation: { kind: "dynamic-terminal-choice" } },
			{ id: "menu_3", label: "Third", input: { kind: "keys", keys: ["down", "enter"], bytes: "\x1b[B\r" }, operation: { kind: "dynamic-terminal-choice" } },
		]);
		expect(Object.isFrozen(options)).toBe(true);
		expect(Object.isFrozen(options[0])).toBe(true);
		expect(Object.isFrozen(options[0]!.input)).toBe(true);
		expect(Object.isFrozen(options[0]!.input.kind === "keys" ? options[0]!.input.keys : [])).toBe(true);
	});

	it("classifies a visible Yes/No menu as a confirmation without changing selector bindings", () => {
		expect(extractSemanticOptions(["Delete production database?", "1. Yes", "2. No"])).toEqual([
			{ id: "number_1", label: "Yes", input: { kind: "text", text: "1", submit: true, bytes: "1\r" }, operation: { kind: "dynamic-terminal-confirmation" } },
			{ id: "number_2", label: "No", input: { kind: "text", text: "2", submit: true, bytes: "2\r" }, operation: { kind: "dynamic-terminal-confirmation" } },
		]);
	});

	it.each([
		["duplicate labels", ["1. Same", "2. same"]],
		["non-sequential selectors", ["1. One", "3. Three"]],
		["mixed selector styles", ["1. One", "2) Two"]],
		["duplicate selected markers", ["> One", "> Two"]],
		["unmapped selected menu", ["  One", "❯ Two", "  Three"]],
		["only one option", ["1. Lonely"]],
		["free-form prompt", ["Enter a value:", "1. One", "2. Two"]],
		["secret choice", ["1. Use password", "2. Skip"]],
		["lifecycle choice", ["a) Continue", "b) Exit process"]],
		["shell syntax", ["1. Build", "2. sudo deploy"]],
		["terminal controls", ["1. Safe", "2. Bad\u001b[31m"]],
		["invisible formatting", ["1. Safe", "2. Con\u202etinue"]],
		["oversized option count", Array.from({ length: 11 }, (_, index) => `${index + 1}. Item ${index + 1}`)],
	] as Array<[string, string[]]>)("fails closed for %s", (_name, viewport) => {
		const result = extractSemanticOptions(viewport);
		expect(result).toEqual([]);
		expect(Object.isFrozen(result)).toBe(true);
	});

	it("does not infer options from ordinary or unsupported terminal text", () => {
		expect(extractSemanticOptions(["Build completed", "What should happen next?"])).toEqual([]);
		expect(extractSemanticOptions(["[ ] First", "[x] Second"])).toEqual([]);
		expect(extractSemanticOptions({ viewport: ["1. One", "2. Two"] })).toEqual([]);
	});
});
