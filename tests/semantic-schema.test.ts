import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { toolParameters } from "../tool-schema.ts";

const validText = { id: "confirm", description: "Confirm the visible ordinary prompt", input: "yes", submit: true, cooldownMs: 0, maxExecutions: 1 };
const validKeys = { id: "next", description: "Choose the next ordinary menu item", inputKeys: ["down", "enter"], cooldownMs: 1000, maxExecutions: 2 };
const params = (semantic: unknown) => ({ monitor: { strategy: "semantic", semantic } });
const actionParams = (item: unknown, extra: Record<string, unknown> = {}) => params({ actions: { enabled: true, maxActions: 2, items: [item], ...extra } });

describe("semantic tool schema bounds", () => {
	it("validates current text and key action shapes", () => {
		expect(Value.Check(toolParameters, actionParams(validText))).toBe(true);
		expect(Value.Check(toolParameters, actionParams(validKeys))).toBe(true);
		expect(Value.Check(toolParameters, params({ goal: "observe", minIntervalMs: 250, watches: [{ id: "build.ready", condition: "build is visibly ready", threshold: 0.8 }] }))).toBe(true);
	});

	it.each([
		["goal length", params({ goal: "x".repeat(1001) })],
		["watch id", params({ watches: [{ id: "bad id", condition: "visible" }] })],
		["blank condition", params({ watches: [{ id: "safe", condition: "   " }] })],
		["watch threshold", params({ watches: [{ id: "safe", condition: "visible", threshold: 1.01 }] })],
		["interval low", params({ minIntervalMs: 249 })], ["interval integer", params({ minIntervalMs: 250.5 })],
		["session budget", actionParams(validText, { maxActions: 11 })], ["session budget integer", actionParams(validText, { maxActions: 1.5 })],
		["action id", actionParams({ ...validText, id: "bad id" })], ["description blank", actionParams({ ...validText, description: "" })],
		["description whitespace", actionParams({ ...validText, description: "   " })],
		["description length", actionParams({ ...validText, description: "x".repeat(501) })], ["description control", actionParams({ ...validText, description: "bad\ntext" })],
		["text empty", actionParams({ ...validText, input: "" })], ["text length", actionParams({ ...validText, input: "x".repeat(2001) })],
		["text control", actionParams({ ...validText, input: "yes\n" })], ["text shell metachar", actionParams({ ...validText, input: "yes; exit" })],
		["keys empty", actionParams({ ...validKeys, inputKeys: [] })], ["key empty", actionParams({ ...validKeys, inputKeys: [""] })],
		["keys length", actionParams({ ...validKeys, inputKeys: Array(33).fill("down") })],
		["key newline", actionParams({ ...validKeys, inputKeys: ["down\n"] })], ["key control", actionParams({ ...validKeys, inputKeys: ["down\u007f"] })],
		["key item length", actionParams({ ...validKeys, inputKeys: ["x".repeat(65)] })],
		["unknown watch property", params({ watches: [{ id: "safe", condition: "visible", extra: true }] })],
		["unknown semantic property", params({ attention: true, extra: true })],
		["cooldown low", actionParams({ ...validText, cooldownMs: -1 })], ["cooldown high", actionParams({ ...validText, cooldownMs: 86400001 })],
		["cooldown integer", actionParams({ ...validText, cooldownMs: 1.5 })], ["execution budget", actionParams({ ...validText, maxExecutions: 11 })],
		["execution integer", actionParams({ ...validText, maxExecutions: 1.5 })],
		["mixed forms", actionParams({ ...validText, inputKeys: ["enter"] })],
		["missing form", actionParams({ id: "none", description: "No input form" })],
		["submit on keys", actionParams({ ...validKeys, submit: true })],
	] as const)("rejects %s before runtime", (_label, value) => {
		expect(Value.Check(toolParameters, value)).toBe(false);
	});

	it("emits exact mechanical constraints while leaving semantic deny checks to runtime", () => {
		const semantic = (toolParameters as any).properties.monitor.properties.semantic;
		expect(semantic.additionalProperties).toBe(false);
		expect(semantic.properties.watches.items.additionalProperties).toBe(false);
		expect(semantic.properties.goal.maxLength).toBe(1000);
		expect(semantic.properties.minIntervalMs).toMatchObject({ type: "integer", minimum: 250, maximum: 60000 });
		const actions = semantic.properties.actions;
		expect(actions.properties.maxActions).toMatchObject({ type: "integer", minimum: 1, maximum: 10 });
		expect(actions.properties.items).toMatchObject({ minItems: 1, maxItems: 10 });
		expect(actions.properties.items.items.anyOf).toHaveLength(2);
		expect(actions.properties.items.items.anyOf[1].properties.inputKeys.items).toMatchObject({ minLength: 1, maxLength: 64, pattern: expect.any(String) });
	});
});
