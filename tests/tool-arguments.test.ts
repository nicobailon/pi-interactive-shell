import { describe, expect, it } from "vitest";
import { validateToolArguments } from "../tool-schema.ts";

describe("tool argument validation", () => {
	it("rejects values the full schema forbids, naming the path", () => {
		expect(() => validateToolArguments({ semanticIncident: { kind: "invented" } })).toThrow(/Validation failed for tool "interactive_shell":\n {2}- semanticIncident\.kind: /);
	});

	it("converts string numbers like Pi does", () => {
		expect(validateToolArguments({ command: "x", timeout: "5000" })).toEqual({ command: "x", timeout: 5000 });
	});

	it("treats null optional fields as absent", () => {
		expect(validateToolArguments({ spawn: null, command: "ls" })).toEqual({ command: "ls" });
	});

	it("passes a valid semantic monitor call through unchanged", () => {
		const args = {
			command: "npm test",
			mode: "monitor",
			monitor: { strategy: "semantic", semantic: { goal: "watch tests", watches: [{ id: "done", condition: "tests finished", threshold: 0.8 }] } },
		};
		expect(validateToolArguments(args)).toEqual(args);
	});
});
