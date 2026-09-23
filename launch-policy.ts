export type LaunchDecision = "allow" | "ask" | "deny";

export type LaunchPolicyRule = Readonly<{ command: string; decision: LaunchDecision }>;

export type LaunchPolicy = Readonly<{
	/** Unmatched commands return "ask". */
	evaluate(command: string): LaunchDecision;
}>;

const DECISION_RANK: Readonly<Record<LaunchDecision, number>> = Object.freeze({ allow: 1, ask: 2, deny: 3 });

/**
 * Validates and snapshots trusted user rules. Commands are opaque strings matched
 * exactly, with no shell parsing or normalization. If several rules match, deny
 * wins over ask, which wins over allow.
 */
export function compileLaunchPolicy(rules: unknown): LaunchPolicy {
	if (!Array.isArray(rules)) throw new TypeError("launchPolicy must be an array of rules");
	const decisions = new Map<string, LaunchDecision>();
	rules.forEach((rule: unknown, index) => {
		if (!isRuleShape(rule)) {
			throw new TypeError(`Invalid launchPolicy rule at index ${index}: expected only a non-empty command and a decision of allow, ask, or deny`);
		}
		const previous = decisions.get(rule.command);
		if (!previous || DECISION_RANK[rule.decision] > DECISION_RANK[previous]) decisions.set(rule.command, rule.decision);
	});
	return Object.freeze({ evaluate: (command: string) => decisions.get(command) ?? "ask" });
}

function isRuleShape(value: unknown): value is LaunchPolicyRule {
	if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
	const keys = Reflect.ownKeys(value);
	const rule = value as Record<string, unknown>;
	return keys.length === 2 && Object.hasOwn(rule, "command") && Object.hasOwn(rule, "decision")
		&& typeof rule.command === "string" && rule.command.length > 0
		&& (rule.decision === "allow" || rule.decision === "ask" || rule.decision === "deny");
}
