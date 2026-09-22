import { describe, expect, it } from "vitest";
import { compileSemanticPermissions, type SemanticPermissionRule } from "../semantic-permissions.ts";

const launch = (command: string) => ({ kind: "launch-command" as const, command });
const choice = { kind: "dynamic-terminal-choice" as const };
const confirmation = { kind: "dynamic-terminal-confirmation" as const };
const reply = { kind: "semantic-reply" as const };

const rule = (decision: "allow" | "ask" | "deny", operation: SemanticPermissionRule["operation"]): SemanticPermissionRule => ({ decision, operation });

describe("semantic permission policy", () => {
	it("uses ask by default and deny wins for state-bound replies", () => {
		expect(compileSemanticPermissions([]).evaluate(reply)).toBe("ask");
		expect(compileSemanticPermissions([rule("allow", reply), rule("deny", reply)]).evaluate(reply)).toBe("deny");
	});
	it("matches opaque launch commands exactly without parsing or normalization", () => {
		const policy = compileSemanticPermissions([
			rule("allow", launch("npm test")),
			rule("deny", launch("rm -rf build")),
		]);

		expect(policy.evaluate(launch("npm test"))).toBe("allow");
		expect(policy.evaluate(launch(" npm test"))).toBe("ask");
		expect(policy.evaluate(launch("npm  test"))).toBe("ask");
		expect(policy.evaluate(launch("rm -rf build"))).toBe("deny");
	});

	it("uses code-owned identities for dynamic choices and confirmations", () => {
		const policy = compileSemanticPermissions([
			rule("allow", choice),
			rule("deny", confirmation),
		]);

		expect(policy.evaluate(choice)).toBe("allow");
		expect(policy.evaluate(confirmation)).toBe("deny");
	});

	it("applies deterministic deny then ask then allow precedence", () => {
		const operation = launch("git status");
		expect(compileSemanticPermissions([
			rule("allow", operation),
			rule("ask", operation),
		]).evaluate(operation)).toBe("ask");
		expect(compileSemanticPermissions([
			rule("deny", operation),
			rule("allow", operation),
			rule("ask", operation),
		]).evaluate(operation)).toBe("deny");
		expect(compileSemanticPermissions([
			rule("ask", operation),
			rule("allow", operation),
			rule("deny", operation),
		]).evaluate(operation)).toBe("deny");
	});

	it.each([
		["unmatched", launch("unknown")],
		["unknown kind", { kind: "other" }],
		["empty command", launch("")],
		["missing command", { kind: "launch-command" }],
		["ambiguous extra launch data", { kind: "launch-command", command: "npm test", projectAllows: true }],
		["model-provided choice identity", { kind: "dynamic-terminal-choice", choiceId: "safe" }],
		["terminal content", { kind: "dynamic-terminal-confirmation", terminal: "approved" }],
		["symbol metadata", Object.assign(launch("npm test"), { [Symbol("model-data")]: true })],
		["hostile accessor", Object.defineProperty({}, "kind", { enumerable: true, get: () => { throw new Error("untrusted getter"); } })],
		["non-object", "launch-command"],
	] as const)("fails closed to ask for %s operations", (_label, operation) => {
		const policy = compileSemanticPermissions([rule("allow", launch("npm test")), rule("allow", choice), rule("allow", confirmation)]);
		expect(policy.evaluate(operation)).toBe("ask");
	});

	it.each([
		["non-array rules", {}],
		["non-object rule", [null]],
		["unknown decision", [{ decision: "permit", operation: choice }]],
		["missing operation", [{ decision: "allow" }]],
		["extra rule data", [{ decision: "allow", operation: choice, toolOverride: true }]],
		["unknown operation", [{ decision: "allow", operation: { kind: "other" } }]],
		["extra operation data", [{ decision: "allow", operation: { ...choice, answer: "yes" } }]],
	] as const)("rejects malformed trusted configuration: %s", (_label, rules) => {
		expect(() => compileSemanticPermissions(rules)).toThrow(TypeError);
	});

	it("snapshots user rules so later external mutation cannot weaken policy", () => {
		const source = { decision: "deny", operation: launch("deploy") };
		const policy = compileSemanticPermissions([source]);

		source.decision = "allow";
		source.operation.command = "something-else";
		expect(policy.evaluate(launch("deploy"))).toBe("deny");
		expect(Object.isFrozen(policy)).toBe(true);
	});
});
