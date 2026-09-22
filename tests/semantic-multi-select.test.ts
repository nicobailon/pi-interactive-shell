import { describe, expect, it } from "vitest";
import {
	extractSemanticMultiSelect,
	MAX_SEMANTIC_MULTI_SELECT_ITEMS,
} from "../semantic-multi-select.ts";

const FOOTER = "↑↓ navigate • space select • ⏎ submit";

function bracketViewport(rows: readonly string[] = ["❯ [x] Alpha", "  [ ] Beta", "  [x] Gamma"]): string[] {
	return ["Choose release channels:", ...rows, FOOTER];
}

describe("semantic multi-select extraction", () => {
	it("extracts one complete bracket list with stable IDs and code-owned bindings", () => {
		expect(extractSemanticMultiSelect(bracketViewport())).toEqual({
			viewport: ["Choose release channels:", "❯ [x] Alpha", "  [ ] Beta", "  [x] Gamma", FOOTER],
			prompt: "Choose release channels:",
			promptIndex: 0,
			items: [
				{ id: "multi_1", label: "Alpha", checked: true },
				{ id: "multi_2", label: "Beta", checked: false },
				{ id: "multi_3", label: "Gamma", checked: true },
			],
			cursorIndex: 0,
			markerFamily: "bracket",
			bindings: { up: "ArrowUp", down: "ArrowDown", toggle: "Space", submit: "Enter" },
		});
	});

	it("supports the current Inquirer circle markers when every marker is exact", () => {
		const result = extractSemanticMultiSelect([
			"Select packages", " ◉ Core", "❯◯ Extras", " ◉ Docs", "↑ ↓ navigate · space select · ⏎ submit",
		]);
		expect(result?.markerFamily).toBe("circle");
		expect(result?.cursorIndex).toBe(1);
		expect(result?.items).toEqual([
			{ id: "multi_1", label: "Core", checked: true },
			{ id: "multi_2", label: "Extras", checked: false },
			{ id: "multi_3", label: "Docs", checked: true },
		]);
	});

	it("returns a deeply immutable contract including the exact bounded viewport", () => {
		const source = ["", ...bracketViewport(), ""];
		const result = extractSemanticMultiSelect(source)!;
		expect(result.viewport).toEqual(source);
		expect(result.promptIndex).toBe(1);
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.viewport)).toBe(true);
		expect(Object.isFrozen(result.items)).toBe(true);
		expect(result.items.every(Object.isFrozen)).toBe(true);
		expect(Object.isFrozen(result.bindings)).toBe(true);
		source[1] = "changed";
		expect(result.viewport[1]).toBe("Choose release channels:");
	});

	it.each([
		["missing footer", ["Pick:", "❯ [x] Alpha", "  [ ] Beta"]],
		["checkboxes without footer", ["Pick:", "❯ [x] Alpha", "  [ ] Beta", "Done"]],
		["navigation synonym", ["Pick:", "❯ [x] Alpha", "  [ ] Beta", "↑↓ move • space select • ⏎ submit"]],
		["toggle synonym", ["Pick:", "❯ [x] Alpha", "  [ ] Beta", "↑↓ navigate • space toggle • ⏎ submit"]],
		["submit synonym", ["Pick:", "❯ [x] Alpha", "  [ ] Beta", "↑↓ navigate • space select • enter submit"]],
		["extra advertised binding", ["Pick:", "❯ [x] Alpha", "  [ ] Beta", `${FOOTER} • a select all`]],
		["unknown shortcut", ["Pick (a all):", "❯ [x] Alpha", "  [ ] Beta", FOOTER]],
		["multiple footers", ["Pick:", "❯ [x] Alpha", FOOTER, "  [ ] Beta", FOOTER]],
		["nonblank tail", [...bracketViewport(), "Ready"]],
	])("rejects %s", (_name, viewport) => {
		expect(extractSemanticMultiSelect(viewport)).toBeUndefined();
	});

	it.each([
		["only one item", ["Pick:", "❯ [x] Alpha", FOOTER]],
		["duplicate labels", bracketViewport(["❯ [x] Alpha", "  [ ] alpha"])],
		["no cursor", bracketViewport(["  [x] Alpha", "  [ ] Beta"])],
		["multiple cursors", bracketViewport(["❯ [x] Alpha", "> [ ] Beta"])],
		["mixed families", bracketViewport(["❯ [x] Alpha", "  ◯ Beta"])],
		["uppercase bracket marker", bracketViewport(["❯ [X] Alpha", "  [ ] Beta"])],
		["partial row", bracketViewport(["❯ [x] Alpha", "  [ Beta"])],
		["description", ["Pick:", "❯ [x] Alpha", "    primary package", "  [ ] Beta", FOOTER]],
		["blank inside list", ["Pick:", "❯ [x] Alpha", "", "  [ ] Beta", FOOTER]],
		["separator", ["Pick:", "❯ [x] Alpha", "────", "  [ ] Beta", FOOTER]],
		["second header", ["Pick:", "Required packages", "❯ [x] Alpha", "  [ ] Beta", FOOTER]],
	])("rejects ambiguous or incomplete structure: %s", (_name, viewport) => {
		expect(extractSemanticMultiSelect(viewport)).toBeUndefined();
	});

	it.each([
		["pagination", bracketViewport(["❯ [x] Alpha", "  [ ] Beta ... more choices"])],
		["filtering", ["Filter packages", "❯ [x] Alpha", "  [ ] Beta", FOOTER]],
		["disabled choice", bracketViewport(["❯ [x] Alpha", "  [ ] Beta (disabled)"])],
		["secret", ["Choose token storage:", "❯ [x] Alpha", "  [ ] Beta", FOOTER]],
		["authentication", ["Choose auth method:", "❯ [x] Alpha", "  [ ] Beta", FOOTER]],
		["payment", bracketViewport(["❯ [x] Free", "  [ ] Payment plan"])],
		["shell syntax", bracketViewport(["❯ [x] Build", "  [ ] sudo deploy"])],
		["destructive", bracketViewport(["❯ [x] Keep", "  [ ] Delete data"])],
		["lifecycle", bracketViewport(["❯ [x] Keep", "  [ ] Restart worker"])],
		["process control", ["Choose process control:", "❯ [x] Alpha", "  [ ] Beta", FOOTER]],
		["terminal controls", bracketViewport(["❯ [x] Alpha", "  [ ] Be\u001b[31mta"])],
		["invisible controls", bracketViewport(["❯ [x] Alpha", "  [ ] Be\u202eta"])],
	])("rejects unsupported or unsafe context: %s", (_name, viewport) => {
		expect(extractSemanticMultiSelect(viewport)).toBeUndefined();
	});

	it("enforces item and viewport bounds", () => {
		const rows = Array.from({ length: MAX_SEMANTIC_MULTI_SELECT_ITEMS + 1 }, (_, index) =>
			`${index === 0 ? "❯" : " "} [ ] Item ${index + 1}`,
		);
		expect(extractSemanticMultiSelect(bracketViewport(rows))).toBeUndefined();
		expect(extractSemanticMultiSelect(["P".repeat(241), "❯ [ ] A", "  [ ] B", FOOTER])).toBeUndefined();
		expect(extractSemanticMultiSelect(Array.from({ length: 41 }, () => ""))).toBeUndefined();
		expect(extractSemanticMultiSelect({ viewport: bracketViewport() })).toBeUndefined();
	});
});
