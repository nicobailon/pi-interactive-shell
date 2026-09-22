import { describe, expect, it } from "vitest";
import {
	MAX_SEMANTIC_REPLY_CHARACTERS,
	validateSemanticReply,
	type SemanticReplyBinding,
	type SemanticReplySnapshot,
} from "../semantic-reply.ts";

const binding: SemanticReplyBinding = {
	sessionId: "session-1",
	decisionId: 12,
	observationHash: "09cab1186be861f53dcf8c1b",
	generation: 7,
};

const snapshot: SemanticReplySnapshot = {
	...binding,
	active: true,
	owned: true,
	secretPrompt: false,
};

const validate = (response: unknown, current: SemanticReplySnapshot = snapshot, handoff: SemanticReplyBinding = binding) =>
	validateSemanticReply({ binding: handoff, snapshot: current, response });

describe("state-bound semantic reply validation", () => {
	it("returns an exact ordinary single-line response without writing or modifying it", () => {
		const response = "  Use the staging environment  ";
		const result = validate(response);

		expect(result).toEqual({ ok: true, text: response });
		expect(Object.isFrozen(result)).toBe(true);
		expect(response).toBe("  Use the staging environment  ");
	});

	it.each([
		["session", { sessionId: "session-2" }, "session-mismatch"],
		["decision", { decisionId: 13 }, "decision-mismatch"],
		["observation", { observationHash: "different-observation" }, "observation-mismatch"],
		["generation", { generation: 8 }, "generation-mismatch"],
	] as const)("rejects a %s binding mismatch", (_label, changed, reason) => {
		expect(validate("staging", { ...snapshot, ...changed })).toEqual({ ok: false, reason });
	});

	it("rejects stale, inactive, unowned, and secret-prompt snapshots", () => {
		expect(validate("staging", { ...snapshot, generation: snapshot.generation - 1 })).toEqual({ ok: false, reason: "generation-mismatch" });
		expect(validate("staging", { ...snapshot, active: false })).toEqual({ ok: false, reason: "inactive" });
		expect(validate("staging", { ...snapshot, owned: false })).toEqual({ ok: false, reason: "ownership" });
		expect(validate("staging", { ...snapshot, secretPrompt: true })).toEqual({ ok: false, reason: "secret-prompt" });
	});

	it("fails closed for malformed bindings, snapshots, and ordinary input values", () => {
		expect(validateSemanticReply({ binding: { ...binding, decisionId: -1 }, snapshot, response: "staging" })).toEqual({ ok: false, reason: "invalid-binding" });
		expect(validateSemanticReply({ binding, snapshot: { ...snapshot, active: "yes" }, response: "staging" } as never)).toEqual({ ok: false, reason: "invalid-snapshot" });
		expect(validate(undefined)).toEqual({ ok: false, reason: "invalid-response" });
		expect(validate("")).toEqual({ ok: false, reason: "empty-response" });
	});

	it.each([
		["embedded newline", "first\nsecond", "control-character"],
		["carriage return", "yes\r", "control-character"],
		["Unicode line separator", "first\u2028second", "control-character"],
		["API token", "ghp_abcdefghijklmnop", "secret-like-response"],
		["opaque token", "abcdef0123456789abcdef0123456789", "secret-like-response"],
		["secret assignment", "password=hunter2", "secret-like-response"],
		["secret request", "use my recovery code", "secret-like-response"],
		["shell pipe", "alpha | beta", "shell-metacharacter"],
		["shell substitution", "$(whoami)", "shell-metacharacter"],
		["destructive intent", "delete the database", "forbidden-intent"],
		["lifecycle intent", "kill the process", "forbidden-intent"],
	] as const)("rejects %s", (_label, response, reason) => {
		expect(validate(response)).toEqual({ ok: false, reason });
	});

	it("rejects character and UTF-8 byte oversize without truncating", () => {
		expect(validate("a".repeat(MAX_SEMANTIC_REPLY_CHARACTERS + 1))).toEqual({ ok: false, reason: "oversized-response" });
		expect(validate("é".repeat(MAX_SEMANTIC_REPLY_CHARACTERS))).toEqual({ ok: true, text: "é".repeat(MAX_SEMANTIC_REPLY_CHARACTERS) });
		expect(validate("🙂".repeat(MAX_SEMANTIC_REPLY_CHARACTERS))).toEqual({ ok: false, reason: "oversized-response" });
	});
});
