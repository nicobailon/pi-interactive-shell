export type SemanticPermissionDecision = "allow" | "ask" | "deny";

/**
 * Stable, code-owned operation identities. Launch commands are opaque strings:
 * matching is exact and performs no shell parsing or normalization.
 */
export type SemanticPermissionOperation =
	| Readonly<{ kind: "launch-command"; command: string }>
	| Readonly<{ kind: "dynamic-terminal-choice" }>
	| Readonly<{ kind: "dynamic-terminal-confirmation" }>;

export type SemanticPermissionRule = Readonly<{
	decision: SemanticPermissionDecision;
	operation: SemanticPermissionOperation;
}>;

export type CompiledSemanticPermissions = Readonly<{
	/** Malformed or unmatched operations return "ask". */
	evaluate(operation: unknown): SemanticPermissionDecision;
}>;

type OwnedOperation =
	| { kind: "launch-command"; command: string }
	| { kind: "dynamic-terminal-choice" }
	| { kind: "dynamic-terminal-confirmation" };

const DECISION_RANK: Readonly<Record<SemanticPermissionDecision, number>> = Object.freeze({
	allow: 1,
	ask: 2,
	deny: 3,
});

const hasExactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
	const keys = Reflect.ownKeys(value);
	return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object"
	&& value !== null
	&& !Array.isArray(value)
	&& (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const readOperation = (value: unknown): OwnedOperation | undefined => {
	if (!isRecord(value) || typeof value.kind !== "string") return undefined;

	switch (value.kind) {
		case "launch-command":
			if (!hasExactKeys(value, ["kind", "command"]) || typeof value.command !== "string" || value.command.length === 0) return undefined;
			return { kind: value.kind, command: value.command };
		case "dynamic-terminal-choice":
		case "dynamic-terminal-confirmation":
			if (!hasExactKeys(value, ["kind"])) return undefined;
			return { kind: value.kind };
		default:
			return undefined;
	}
};

const sameOperation = (left: OwnedOperation, right: OwnedOperation): boolean =>
	left.kind === right.kind
	&& (left.kind !== "launch-command"
		|| (right.kind === "launch-command" && left.command === right.command));

/**
 * Validates and snapshots trusted user rules. Matching is by exact operation
 * identity. If several rules match, deny wins over ask, which wins over allow.
 */
export const compileSemanticPermissions = (rules: unknown): CompiledSemanticPermissions => {
	if (!Array.isArray(rules)) throw new TypeError("Semantic permission rules must be an array");

	const compiled: Array<{ decision: SemanticPermissionDecision; operation: OwnedOperation }> = rules.map((candidate, index) => {
		if (!isRecord(candidate) || !hasExactKeys(candidate, ["decision", "operation"])) {
			throw new TypeError(`Invalid semantic permission rule at index ${index}: expected only decision and operation`);
		}
		if (candidate.decision !== "allow" && candidate.decision !== "ask" && candidate.decision !== "deny") {
			throw new TypeError(`Invalid semantic permission rule at index ${index}: decision must be allow, ask, or deny`);
		}
		const operation = readOperation(candidate.operation);
		if (!operation) throw new TypeError(`Invalid semantic permission rule at index ${index}: malformed operation identity`);
		return { decision: candidate.decision, operation };
	});

	return Object.freeze({
		evaluate(operation: unknown): SemanticPermissionDecision {
			let ownedOperation: OwnedOperation | undefined;
			try {
				ownedOperation = readOperation(operation);
			} catch {
				return "ask";
			}
			if (!ownedOperation) return "ask";

			let decision: SemanticPermissionDecision = "ask";
			let matched = false;
			for (const rule of compiled) {
				if (!sameOperation(rule.operation, ownedOperation)) continue;
				if (!matched || DECISION_RANK[rule.decision] > DECISION_RANK[decision]) decision = rule.decision;
				matched = true;
			}
			return decision;
		},
	});
};
