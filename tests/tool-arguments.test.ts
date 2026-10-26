import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { LEAN_TOOL_DESCRIPTION, leanToolParameters, toolParameters, validateToolArguments } from "../tool-schema.ts";

type JsonSchema = { type?: string; const?: unknown; anyOf?: JsonSchema[]; required?: string[]; properties?: Record<string, JsonSchema>; items?: JsonSchema; additionalProperties?: unknown };

// Every lean path must accept whatever the full schema accepts there, or Pi would reject valid advanced calls.
function expectAcceptsFullValues(lean: JsonSchema, full: JsonSchema | undefined, path: string): void {
	expect(full, path).toBeDefined();
	expect(lean.additionalProperties, path).toBeUndefined();
	expect(lean.type, path).toBe(full!.type);
	expect(lean.anyOf?.map((v) => String(v.const ?? v.type)).sort(), path).toEqual(full!.anyOf?.map((v) => String(v.const ?? v.type)).sort());
	for (const key of lean.required ?? []) expect(full!.required ?? [], `${path}.required`).toContain(key);
	for (const [key, child] of Object.entries(lean.properties ?? {})) expectAcceptsFullValues(child, full!.properties?.[key], `${path}.${key}`);
	if (lean.items) expectAcceptsFullValues(lean.items, full!.items, `${path}[]`);
}

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

describe("lean tool schema", () => {
	it("accepts every value the full schema accepts on each listed path", () => {
		expectAcceptsFullValues(leanToolParameters as JsonSchema, toolParameters as JsonSchema, "root");
	});

	it("lets advanced fields it does not list through to full validation", () => {
		const args = {
			command: "npm test",
			mode: "monitor",
			monitor: { strategy: "semantic", triggers: [{ id: "n", regex: "(\\d+) failed", threshold: { captureGroup: 1, op: "gt", value: 0 } }], semantic: { attention: true } },
			outputView: "raw",
			handoffPreview: { enabled: true },
		};
		expect(Value.Check(leanToolParameters, args)).toBe(true);
		expect(Value.Check(toolParameters, args)).toBe(true);
	});

	it("stays under 6,000 characters and portable", () => {
		const json = JSON.stringify(leanToolParameters);
		expect(json.length + LEAN_TOOL_DESCRIPTION.length).toBeLessThanOrEqual(6000);
		expect(json).not.toContain('"pattern"');
	});
});
