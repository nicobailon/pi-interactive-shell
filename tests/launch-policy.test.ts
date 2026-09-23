import { describe, expect, it } from "vitest";
import { compileLaunchPolicy, type LaunchDecision } from "../launch-policy.ts";

const rule = (decision: LaunchDecision, command: string) => ({ command, decision });

describe("launch policy", () => {
	it("matches opaque launch commands exactly without parsing or normalization", () => {
		const policy = compileLaunchPolicy([rule("allow", "npm test"), rule("deny", "rm -rf build")]);

		expect(policy.evaluate("npm test")).toBe("allow");
		expect(policy.evaluate(" npm test")).toBe("ask");
		expect(policy.evaluate("npm  test")).toBe("ask");
		expect(policy.evaluate("rm -rf build")).toBe("deny");
		expect(policy.evaluate("unknown")).toBe("ask");
	});

	it("applies deterministic deny then ask then allow precedence", () => {
		expect(compileLaunchPolicy([rule("allow", "git status"), rule("ask", "git status")]).evaluate("git status")).toBe("ask");
		expect(compileLaunchPolicy([rule("deny", "git status"), rule("allow", "git status"), rule("ask", "git status")]).evaluate("git status")).toBe("deny");
		expect(compileLaunchPolicy([rule("ask", "git status"), rule("allow", "git status"), rule("deny", "git status")]).evaluate("git status")).toBe("deny");
	});

	it.each([
		["non-array rules", {}],
		["non-object rule", [null]],
		["unknown decision", [{ command: "npm test", decision: "permit" }]],
		["missing command", [{ decision: "allow" }]],
		["empty command", [{ command: "", decision: "allow" }]],
		["extra rule data", [{ command: "npm test", decision: "allow", projectAllows: true }]],
		["pre-rename operation shape", [{ decision: "allow", operation: { kind: "launch-command", command: "npm test" } }]],
	] as const)("rejects malformed trusted configuration: %s", (_label, rules) => {
		expect(() => compileLaunchPolicy(rules)).toThrow(TypeError);
	});

	it("snapshots user rules so later external mutation cannot weaken policy", () => {
		const source = { command: "deploy", decision: "deny" };
		const policy = compileLaunchPolicy([source]);

		source.decision = "allow";
		source.command = "something-else";
		expect(policy.evaluate("deploy")).toBe("deny");
		expect(Object.isFrozen(policy)).toBe(true);
	});
});
