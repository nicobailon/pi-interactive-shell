import { encodeSemanticActionKeys } from "./key-encoding.ts";
import { SEMANTIC_SAFE_ID } from "./semantic-policy.ts";

export const MAX_SEMANTIC_ACTIONS = 10;
const MAX_TEXT = 2_000;
const MAX_KEYS = 32;
const MAX_BYTES = 4_096;
const MAX_COOLDOWN_MS = 86_400_000;
const ACTION_KEYS = new Set(["enabled", "maxActions", "items"]);
const ITEM_KEYS = new Set(["id", "description", "input", "inputKeys", "submit", "cooldownMs", "maxExecutions"]);
const FORBIDDEN_INTENT = /\b(password|passphrase|credential|secret|token|api[ _-]?key|mfa|otp|pin|payment|credit card|kill|killall|pkill|signal|job[ _-]+control|exit|logout|shutdown|reboot|terminate|dispose|complete|background|transfer|disown|suspend|exec|trap|stty|fg|bg|shell command)\b/i;
const TOKEN_SHAPE = /\b(?:(?:sk|pk|ghp|github_pat)[_-][A-Za-z0-9_-]{12,})\b/;
const OPAQUE_TOKEN = /\b(?:[A-Fa-f0-9]{24,}|(?=[A-Za-z0-9_-]{24,}\b)(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]+)\b/;
const SHELL_METACHARACTERS = /[;&|`$<>]/;

export type CompiledSemanticAction = Readonly<{
	id: string;
	description: string;
	kind: "input" | "inputKeys";
	bytes: string;
	cooldownMs: number;
	maxExecutions: number;
}>;

export interface SemanticActionRegistry {
	readonly actions: readonly CompiledSemanticAction[];
	readonly maxActions: number;
	get(id: string): CompiledSemanticAction | undefined;
}

export function compileSemanticActions(config: unknown): SemanticActionRegistry | undefined {
	if (config === undefined) return undefined;
	if (!isPlainRecord(config) || config.enabled !== true) throw new Error("Semantic actions require explicit enabled: true");
	for (const key of Object.keys(config)) {
		if (!ACTION_KEYS.has(key)) throw new Error(`Unknown semantic actions option: ${key}`);
	}
	if (!Array.isArray(config.items) || config.items.length < 1 || config.items.length > MAX_SEMANTIC_ACTIONS) throw new Error("Semantic actions require 1-10 items");
	const maxActions = config.maxActions ?? 1;
	if (typeof maxActions !== "number" || !Number.isInteger(maxActions) || maxActions < 1 || maxActions > MAX_SEMANTIC_ACTIONS) throw new Error("Semantic maxActions must be an integer from 1 to 10");
	const ids = new Set<string>();
	const compiled: CompiledSemanticAction[] = config.items.map((raw) => {
		if (!isPlainRecord(raw)) throw new Error("Invalid semantic action item");
		for (const key of Object.keys(raw)) if (!ITEM_KEYS.has(key)) throw new Error(`Unknown semantic action option: ${key}`);
		const { id, description } = raw;
		if (typeof id !== "string" || !SEMANTIC_SAFE_ID.test(id) || ["observe_again", "notify_pi", "stop_automation"].includes(id)) throw new Error("Semantic action id is unsafe or reserved");
		if (ids.has(id)) throw new Error(`Duplicate semantic action id: ${id}`);
		ids.add(id);
		if (typeof description !== "string" || !description.trim() || description.length > 500 || hasControls(description)) throw new Error(`Invalid semantic action description: ${id}`);
		if (FORBIDDEN_INTENT.test(`${id} ${description}`)) throw new Error(`Forbidden semantic action intent: ${id}`);
		const input = raw.input;
		const inputKeys = raw.inputKeys;
		const hasInput = typeof input === "string";
		const hasKeys = Array.isArray(inputKeys);
		if (hasInput === hasKeys) throw new Error(`Semantic action ${id} must have exactly one input form`);
		if (raw.submit !== undefined && (!hasInput || typeof raw.submit !== "boolean")) throw new Error(`submit is valid only with text input: ${id}`);
		if (raw.cooldownMs !== undefined && (typeof raw.cooldownMs !== "number" || !Number.isInteger(raw.cooldownMs) || raw.cooldownMs < 0 || raw.cooldownMs > MAX_COOLDOWN_MS)) throw new Error(`Invalid semantic action cooldown: ${id}`);
		if (raw.maxExecutions !== undefined && (typeof raw.maxExecutions !== "number" || !Number.isInteger(raw.maxExecutions) || raw.maxExecutions < 1 || raw.maxExecutions > MAX_SEMANTIC_ACTIONS)) throw new Error(`Invalid semantic action budget: ${id}`);
		let bytes: string;
		let kind: "input" | "inputKeys";
		if (typeof input === "string") {
			if (!input || input.length > MAX_TEXT || hasControls(input) || FORBIDDEN_INTENT.test(input)
				|| TOKEN_SHAPE.test(input) || OPAQUE_TOKEN.test(input) || SHELL_METACHARACTERS.test(input)) throw new Error(`Invalid semantic action text: ${id}`);
			bytes = `${input}${raw.submit ? "\r" : ""}`; kind = "input";
		} else {
			if (!Array.isArray(inputKeys) || !inputKeys.length || inputKeys.length > MAX_KEYS || !inputKeys.every((key) => typeof key === "string")) throw new Error(`Invalid semantic action key count: ${id}`);
			bytes = encodeSemanticActionKeys(inputKeys); kind = "inputKeys";
		}
		if (!bytes || Buffer.byteLength(bytes) > MAX_BYTES) throw new Error(`Semantic action bytes are empty or oversized: ${id}`);
		return Object.freeze({ id, description, kind, bytes, cooldownMs: raw.cooldownMs ?? 0, maxExecutions: raw.maxExecutions ?? MAX_SEMANTIC_ACTIONS });
	});
	const byId = new Map(compiled.map((action) => [action.id, action]));
	return Object.freeze({ actions: Object.freeze([...compiled]), maxActions, get: (id: string) => byId.get(id) });
}

function hasControls(value: string): boolean { return /[\u0000-\u001f\u007f]/.test(value); }
function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
