export const MAX_SEMANTIC_REPLY_CHARACTERS = 2_000;
export const MAX_SEMANTIC_REPLY_BYTES = 4_096;

/** Identity copied from the handoff that requested an ordinary text response. */
export interface SemanticReplyBinding {
	readonly sessionId: string;
	readonly decisionId: number;
	readonly observationHash: string;
	readonly generation: number;
}

/** Trusted state captured again immediately before the caller attempts a write. */
export interface SemanticReplySnapshot extends SemanticReplyBinding {
	readonly active: boolean;
	readonly owned: boolean;
	readonly secretPrompt: boolean;
}

export type SemanticReplyFailureReason =
	| "invalid-binding"
	| "invalid-snapshot"
	| "session-mismatch"
	| "decision-mismatch"
	| "observation-mismatch"
	| "generation-mismatch"
	| "inactive"
	| "ownership"
	| "secret-prompt"
	| "invalid-response"
	| "empty-response"
	| "oversized-response"
	| "control-character"
	| "secret-like-response"
	| "shell-metacharacter"
	| "forbidden-intent";

export type SemanticReplyValidation =
	| Readonly<{ ok: true; text: string }>
	| Readonly<{ ok: false; reason: SemanticReplyFailureReason }>;

export interface SemanticReplyValidationInput {
	readonly binding: SemanticReplyBinding;
	readonly snapshot: SemanticReplySnapshot;
	readonly response: unknown;
}

const CONTROL_OR_NEWLINE = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/;
const SECRET_ASSIGNMENT = /\b(?:password|passphrase|credential|secret|token|api[ _-]?key|authorization|recovery[ _-]?code)\s*[:=]\s*\S+/i;
const TOKEN_SHAPE = /\b(?:(?:sk|pk|ghp|github_pat)[_-][A-Za-z0-9_-]{12,})\b/;
const OPAQUE_TOKEN = /\b(?:[A-Fa-f0-9]{24,}|(?=[A-Za-z0-9_-]{24,}\b)(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]+)\b/;
const SECRET_INTENT = /\b(?:password|passphrase|credential|secret|token|api[ _-]?key|mfa|2fa|otp|pin|payment|credit card|authorization|recovery[ _-]?code)\b/i;
const SHELL_METACHARACTERS = /[;&|`$<>]/;
const FORBIDDEN_INTENT = /\b(?:kill|killall|pkill|signal|job[ _-]+control|exit|logout|shutdown|reboot|terminate|dispose|background|transfer|disown|suspend|exec|trap|stty|fg|bg|shell command|delete|remove|erase|wipe|destroy|format|drop)\b/i;

/**
 * Pure, fail-closed validation for a reply to one semantic handoff.
 * The successful text is the caller's exact string; this function neither
 * appends submission bytes nor grants permission or performs a write.
 */
export function validateSemanticReply(input: SemanticReplyValidationInput): SemanticReplyValidation {
	if (!isBinding(input?.binding)) return failure("invalid-binding");
	if (!isSnapshot(input?.snapshot)) return failure("invalid-snapshot");

	const { binding, snapshot, response } = input;
	if (snapshot.sessionId !== binding.sessionId) return failure("session-mismatch");
	if (snapshot.decisionId !== binding.decisionId) return failure("decision-mismatch");
	if (snapshot.observationHash !== binding.observationHash) return failure("observation-mismatch");
	if (snapshot.generation !== binding.generation) return failure("generation-mismatch");
	if (!snapshot.active) return failure("inactive");
	if (!snapshot.owned) return failure("ownership");
	if (snapshot.secretPrompt) return failure("secret-prompt");

	if (typeof response !== "string") return failure("invalid-response");
	if (response.length === 0) return failure("empty-response");
	if (response.length > MAX_SEMANTIC_REPLY_CHARACTERS || Buffer.byteLength(response) > MAX_SEMANTIC_REPLY_BYTES) {
		return failure("oversized-response");
	}
	if (CONTROL_OR_NEWLINE.test(response)) return failure("control-character");
	if (SECRET_ASSIGNMENT.test(response) || TOKEN_SHAPE.test(response) || OPAQUE_TOKEN.test(response) || SECRET_INTENT.test(response)) {
		return failure("secret-like-response");
	}
	if (SHELL_METACHARACTERS.test(response)) return failure("shell-metacharacter");
	if (FORBIDDEN_INTENT.test(response)) return failure("forbidden-intent");

	return Object.freeze({ ok: true, text: response });
}

function isBinding(value: unknown): value is SemanticReplyBinding {
	if (!isRecord(value)) return false;
	return typeof value.sessionId === "string" && value.sessionId.length > 0
		&& Number.isSafeInteger(value.decisionId) && (value.decisionId as number) >= 0
		&& typeof value.observationHash === "string" && value.observationHash.length > 0
		&& Number.isSafeInteger(value.generation) && (value.generation as number) >= 0;
}

function isSnapshot(value: unknown): value is SemanticReplySnapshot {
	if (!isRecord(value)) return false;
	return isBinding(value)
		&& typeof value.active === "boolean"
		&& typeof value.owned === "boolean"
		&& typeof value.secretPrompt === "boolean";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(reason: SemanticReplyFailureReason): SemanticReplyValidation {
	return Object.freeze({ ok: false, reason });
}
