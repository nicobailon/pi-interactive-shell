import { createHash } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { RE2JS } from "re2js";

export interface TerminalObservationSession {
	readonly exited: boolean;
	getViewportLines(options?: { ansi?: boolean }): string[];
}

export interface TerminalObservation {
	task?: string;
	semanticWatch?: string;
	session: {
		mode: "hands-free" | "dispatch" | "monitor";
		lifecycle: "running" | "exited" | "cancelled";
		elapsedMsBucket: string;
		quietMsBucket: string;
	};
	terminal: { viewport: string[]; recentOutput: string; changed: boolean };
	actions: Array<{ id: string; description: string }>;
	recentActionIds: string[];
}

export interface ObservationBounds {
	maxViewportLines: number;
	maxRecentChars: number;
	redactionPatterns: readonly string[];
	redactor?: TerminalRedactor;
}

const SECRET_ASSIGNMENT = /(password|passphrase|api[ _-]?key|secret|token|recovery code)\s*[:=]\s*\S+/gi;
const TOKEN_SHAPE = /\b(?:(?:sk|pk|ghp|github_pat)_[A-Za-z0-9_-]{12,}|(?:sk|pk|ghp|github_pat)-[A-Za-z0-9_-]{16,})\b/g;
export const MAX_REDACTION_PATTERN_LENGTH = 512;
const REDACTION_REPLACEMENT = "[REDACTED]";
export const MAX_HANDOFF_EXCERPT_CHARS = 1_200;
const MAX_HANDOFF_EXCERPT_LINES = 8;
export type TerminalRedactor = (value: string) => string;

interface RedactorCacheEntry {
	sources: readonly string[];
	redactor: TerminalRedactor;
}
const redactorCache = new WeakMap<readonly string[], RedactorCacheEntry>();
const excerptByObservationHash = new Map<string, string>();
const MAX_CACHED_HANDOFFS = 128;

/** Resolves the redacted excerpt of a recently-built observation; no unredacted text is retained. */
export function getTerminalHandoffExcerpt(observationHash: string): string | undefined {
	return excerptByObservationHash.get(observationHash);
}

function hasNestedRepetition(source: string): boolean {
	const groups: Array<{ repeated: boolean }> = [];
	let escaped = false;
	let inClass = false;
	let closedRepeated = false;
	for (let index = 0; index < source.length; index++) {
		const char = source[index]!;
		if (escaped) { escaped = false; closedRepeated = false; continue; }
		if (char === "\\") { escaped = true; closedRepeated = false; continue; }
		if (char === "[" && !inClass) { inClass = true; closedRepeated = false; continue; }
		if (char === "]" && inClass) { inClass = false; closedRepeated = false; continue; }
		if (inClass) continue;
		if (char === "(") { groups.push({ repeated: false }); closedRepeated = false; continue; }
		if (char === ")") {
			closedRepeated = groups.pop()?.repeated ?? false;
			if (closedRepeated && groups.length > 0) groups[groups.length - 1]!.repeated = true;
			continue;
		}
		const isBraceQuantifier = char === "{" && /^\{\d+(?:,\d*)?\}/.test(source.slice(index));
		const isGroupPrefix = char === "?" && source[index - 1] === "(";
		const isQuantifier = char === "*" || char === "+" || (char === "?" && !isGroupPrefix) || isBraceQuantifier;
		if (isQuantifier) {
			if (closedRepeated) return true;
			if (groups.length > 0) groups[groups.length - 1]!.repeated = true;
		}
		closedRepeated = false;
	}
	return false;
}

function compilePattern(source: string): RE2JS {
	if (source.length === 0 || source.length > MAX_REDACTION_PATTERN_LENGTH || hasNestedRepetition(source)) throw new Error("invalid");
	return RE2JS.compile(source, RE2JS.CASE_INSENSITIVE);
}

function sourcesMatch(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((source, index) => source === right[index]);
}

function buildRedactor(patterns: readonly RE2JS[]): TerminalRedactor {
	return Object.freeze((value: string): string => {
		let result = sanitizeTerminalTextBuiltIn(value);
		for (const pattern of patterns) result = pattern.matcher(result).replaceAll(() => REDACTION_REPLACEMENT);
		return result;
	});
}

function normalizeTerminalText(value: string): string {
	return stripVTControlCharacters(value)
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
		.replace(/\r\n?/g, "\n");
}

/** Code-owned synchronous treatment safe for retained terminal fragments. */
export function sanitizeTerminalTextBuiltIn(value: string): string {
	return normalizeTerminalText(value)
		.replace(SECRET_ASSIGNMENT, "$1: [REDACTED]")
		.replace(TOKEN_SHAPE, REDACTION_REPLACEMENT);
}

/** Returns only trusted flags; caller-provided terminal text is never retained here. */
export function classifyTerminalSecretPrompt(viewport: readonly string[], recentOutput: string): { secretPrompt: boolean } {
	const text = `${viewport.join("\n")}\n${recentOutput}`;
	return { secretPrompt: containsSecretPromptText(text) };
}

export function validateRedactionPatterns(sources: readonly string[]): number | undefined {
	const cached = redactorCache.get(sources);
	if (cached && sourcesMatch(cached.sources, sources)) return undefined;
	const sourceSnapshot = Object.freeze([...sources]);
	const patterns: RE2JS[] = [];
	for (let index = 0; index < sourceSnapshot.length; index++) {
		try { patterns.push(compilePattern(sourceSnapshot[index]!)); }
		catch { return index; }
	}
	try {
		redactorCache.set(sources, { sources: sourceSnapshot, redactor: buildRedactor(patterns) });
		return undefined;
	} catch {
		return 0;
	}
}

export function createTerminalRedactor(sources: readonly string[]): TerminalRedactor {
	const cached = redactorCache.get(sources);
	if (cached && sourcesMatch(cached.sources, sources)) return cached.redactor;
	const sourceSnapshot = Object.freeze([...sources]);
	try {
		const redactor = buildRedactor(sourceSnapshot.map(compilePattern));
		redactorCache.set(sources, { sources: sourceSnapshot, redactor });
		return redactor;
	} catch {
		throw new Error("Semantic redaction configuration invalid.");
	}
}

export function sanitizeTerminalText(value: string, customPatterns: readonly string[]): string {
	return createTerminalRedactor(customPatterns)(value);
}

function timeBucket(ms: number): string {
	if (ms < 1_000) return "<1s";
	if (ms < 10_000) return "1-10s";
	if (ms < 60_000) return "10-60s";
	if (ms < 300_000) return "1-5m";
	return ">5m";
}

/** Derives source-grounded evidence only from the already-redacted observation. */
function buildHandoffExcerpt(observation: TerminalObservation, secretPrompt: boolean): string {
	if (secretPrompt) return "[SECRET PROMPT REDACTED]";
	const sourceLines = [...observation.terminal.recentOutput.split("\n"), ...observation.terminal.viewport]
		.map((line) => line.trimEnd())
		.filter((line) => line.trim().length > 0);
	const unique: string[] = [];
	for (const line of sourceLines) {
		if (unique[unique.length - 1] !== line) unique.push(line);
	}
	const excerpt = unique.slice(-MAX_HANDOFF_EXCERPT_LINES).join("\n").slice(-MAX_HANDOFF_EXCERPT_CHARS);
	return excerpt || "[no terminal excerpt]";
}

export function buildTerminalObservation(options: {
	session: TerminalObservationSession;
	mode: TerminalObservation["session"]["mode"];
	task?: string;
	semanticWatch?: string;
	recentOutput: string;
	changed: boolean;
	startedAt: number;
	lastOutputAt: number;
	actions: Array<{ id: string; description: string }>;
	recentActionIds: string[];
	bounds: ObservationBounds;
}): { observation: TerminalObservation; hash: string; secretPrompt: boolean } {
	const redact = options.bounds.redactor ?? createTerminalRedactor(options.bounds.redactionPatterns);
	const normalizedViewport = options.session.getViewportLines({ ansi: false })
		.slice(-options.bounds.maxViewportLines)
		.map((line) => normalizeTerminalText(line).slice(0, 500));
	const normalizedRecentOutput = normalizeTerminalText(options.recentOutput).slice(-options.bounds.maxRecentChars);
	const secretPrompt = classifyTerminalSecretPrompt(normalizedViewport, normalizedRecentOutput).secretPrompt;
	const viewport = normalizedViewport.map((line) => redact(line).slice(0, 500));
	const recentOutput = redact(normalizedRecentOutput).slice(-options.bounds.maxRecentChars);
	const observation: TerminalObservation = {
		...(options.task === undefined ? {} : { task: options.task.slice(0, 1_000) }),
		...(options.semanticWatch === undefined ? {} : { semanticWatch: options.semanticWatch.slice(0, 1_000) }),
		session: {
			mode: options.mode,
			lifecycle: options.session.exited ? "exited" : "running",
			elapsedMsBucket: timeBucket(Date.now() - options.startedAt),
			quietMsBucket: timeBucket(Date.now() - options.lastOutputAt),
		},
		terminal: { viewport, recentOutput, changed: options.changed },
		actions: options.actions.map((action) => ({ id: action.id, description: action.description.slice(0, 500) })),
		recentActionIds: options.recentActionIds.slice(-10),
	};
	// Time buckets and scheduler bookkeeping are excluded so an unchanged screen keeps one hash.
	const identity = {
		...observation,
		session: { mode: observation.session.mode, lifecycle: observation.session.lifecycle },
		terminal: { viewport: observation.terminal.viewport, recentOutput: observation.terminal.recentOutput },
	};
	const hash = createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 24);
	excerptByObservationHash.delete(hash);
	excerptByObservationHash.set(hash, buildHandoffExcerpt(observation, secretPrompt));
	while (excerptByObservationHash.size > MAX_CACHED_HANDOFFS) {
		const oldest = excerptByObservationHash.keys().next().value as string | undefined;
		if (oldest === undefined) break;
		excerptByObservationHash.delete(oldest);
	}
	return { observation, hash, secretPrompt };
}

export function containsSecretPrompt(observation: TerminalObservation): boolean {
	const text = `${observation.terminal.viewport.join("\n")}\n${observation.terminal.recentOutput}`;
	return containsSecretPromptText(text);
}

function containsSecretPromptText(text: string): boolean {
	if (/\b(password|passphrase|api[ _-]?key|secret|token|mfa|2fa|one[- ]time|otp|recovery code|credit card|payment)\b/i.test(text)) return true;
	return text.split("\n").some((line) => {
		const visible = line.trim();
		return /\b(?:enter|type|provide|input|submit)\s+(?:your\s+)?(?:(?:verification|authentication|auth|security)\s+code|passcode|pin(?:\s+(?:code|number))?)\b/i.test(visible)
			|| /\b(?:verification|authentication|auth(?:entication)?|security)\s+code\s*[:?]\s*$/i.test(visible)
			|| /\bpasscode\s*[:?]\s*$/i.test(visible)
			|| /\bpin(?:\s+(?:code|number))?\s*[:?]\s*$/i.test(visible);
	});
}
