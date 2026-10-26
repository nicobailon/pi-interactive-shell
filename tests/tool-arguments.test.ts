import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { LEAN_TOOL_DESCRIPTION, leanToolParameters, toolParameters, validateToolArguments } from "../tool-schema.ts";

type JsonSchema = { type?: string; const?: unknown; anyOf?: JsonSchema[]; required?: string[]; properties?: Record<string, JsonSchema>; items?: JsonSchema };

// Any other keyword (bounds, patterns, additionalProperties) could reject a value the full schema accepts.
const LEAN_KEYWORDS = new Set(["type", "description", "properties", "required", "items", "anyOf", "const"]);
const expectOnlyLeanKeywords = (node: JsonSchema, path: string) => expect(Object.keys(node).filter((key) => !LEAN_KEYWORDS.has(key)), path).toEqual([]);

// Every lean path must accept whatever the full schema accepts there, or Pi would reject valid advanced calls.
function expectAcceptsFullValues(lean: JsonSchema, full: JsonSchema | undefined, path: string): void {
	expect(full, path).toBeDefined();
	expectOnlyLeanKeywords(lean, path);
	for (const member of lean.anyOf ?? []) expectOnlyLeanKeywords(member, `${path}|`);
	expect(lean.type, path).toBe(full!.type);
	expect(lean.const, path).toEqual(full!.const);
	expect(lean.anyOf?.map((v) => String(v.const ?? v.type)).sort(), path).toEqual(full!.anyOf?.map((v) => String(v.const ?? v.type)).sort());
	for (const key of lean.required ?? []) expect(full!.required ?? [], `${path}.required`).toContain(key);
	for (const [key, child] of Object.entries(lean.properties ?? {})) expectAcceptsFullValues(child, full!.properties?.[key], `${path}.${key}`);
	if (lean.items) expectAcceptsFullValues(lean.items, full!.items, `${path}[]`);
}

// Field names the full schema has at paths the lean schema leaves out.
function unlistedFields(full: JsonSchema, lean: JsonSchema | undefined, out: Set<string>): Set<string> {
	for (const [key, child] of Object.entries(full.properties ?? {})) {
		if (!lean?.properties?.[key]) out.add(key);
		unlistedFields(child, lean?.properties?.[key], out);
	}
	if (full.items) unlistedFields(full.items, lean?.items, out);
	for (const member of full.anyOf ?? []) unlistedFields(member, undefined, out);
	return out;
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

	it("leaves out only fields the skill documents, as its description promises", () => {
		const dir = "skills/interactive-shell/references";
		const skill = ["skills/interactive-shell/SKILL.md", ...readdirSync(dir).map((file) => `${dir}/${file}`)].map((path) => readFileSync(path, "utf-8")).join("\n");
		const missing = [...unlistedFields(toolParameters as JsonSchema, leanToolParameters as JsonSchema, new Set())].filter((field) => !new RegExp(`\\b${field}\\b`).test(skill));
		expect(missing).toEqual([]);
	});
});
