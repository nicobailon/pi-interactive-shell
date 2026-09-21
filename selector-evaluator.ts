import type { Questions } from "@typesafe-ai/sdk";
import type { JevClient, JevEvaluationRequest } from "./jev-client.ts";
import { createTerminalRedactor, sanitizeTerminalTextBuiltIn, type TerminalRedactor } from "./terminal-observation.ts";
import { SELECTOR_CORPUS, type SelectorCorpusFixture, type SelectorSplit } from "./selector-corpus.ts";

export const SELECTOR_SETTINGS = Object.freeze({
	model: "jev-1.13.0",
	ordinaryQueryLines: 20,
	ordinaryQueryMaxChars: 5 * 1024,
	completionCaptureLines: 50,
	completionCaptureMaxChars: 5_000,
	selectorVisibleChars: 5 * 1024,
	contextRadius: 1,
	threshold: 0.7,
	requestTimeoutMs: 10_000,
	maxRetries: 1,
	concurrency: 1,
	maxRequests: 8,
	maxTotalMs: 90_000,
	maxSerializedRequestChars: 25_000,
});

export type SelectorArm = "tail" | "protected-context" | "jev";
export type SelectionOutcome = SelectedOutcome | PaginationRequiredOutcome;
export interface SelectedOutcome {
	status: "selected";
	selectedIndices: number[];
	text: string;
	omittedLines: number;
	markerChars: number;
	matchedBudget: true;
}
export interface PaginationRequiredOutcome {
	status: "pagination-required";
	reason: "protected-overflow" | "bypass-overflow" | "unscored-overflow";
	selectedIndices: number[];
	recoveryIndices: number[];
	recoveryRanges: Array<{ startLine: number; endLine: number }>;
	text: string;
	omittedLines: 0;
	markerChars: 0;
	matchedBudget: false;
}
export interface ProductionTailResult {
	indices: number[];
	text: string;
	truncated: boolean;
	budgetOvershootChars: number;
}
export interface SelectorRow {
	fixtureId: string;
	split: SelectorSplit;
	arm: SelectorArm;
	outcomeStatus: SelectionOutcome["status"] | "production-tail";
	selectedIndices: number[];
	recoveryIndices: number[];
	recoveryRanges: Array<{ startLine: number; endLine: number }>;
	visibleChars: number;
	markerChars: number;
	matchedBudget: boolean;
	budgetOvershootChars: number;
	omittedLines: number;
	requiredRetained: number;
	requiredTotal: number;
	relevantRetained: number;
	relevantSelected: number;
	requiredRecall: number;
	relevantPrecision: number;
	relevantRecall: number;
	bypass?: string;
	overflowReason?: PaginationRequiredOutcome["reason"];
}
export interface OfflineSelectorReport { settings: typeof SELECTOR_SETTINGS; rows: SelectorRow[] }
export interface LiveRequestAudit { fixtureId: string; status: "ok" | "failed" | "bypassed"; reason?: "request-cap" | "request-size" | "provider-or-response" | "aborted"; latencyMs: number; requestChars: number; inputTokens?: number; outputTokens?: number }
export interface LiveSelectorReport {
	settings: typeof SELECTOR_SETTINGS;
	rows: SelectorRow[];
	requests: LiveRequestAudit[];
	usage: { inputTokens: number; outputTokens: number };
	cost: { currency: "USD"; amount: null; reason: string };
}

const PROTECTED = /\b(?:error|fail(?:ed|ure)?|warning|expected|received|tests?|build (?:failed|complete)|report|output|revision|url|next action|approved|consequence)\b/i;
const omissionMarker = (omitted: number) => `[omitted:${omitted}; recovery:source]`;
const allIndices = (fixture: SelectorCorpusFixture): number[] => fixture.lines.map((_, index) => index);
const unique = (indices: readonly number[]): number[] => [...new Set(indices)];

/** Pure equivalent of PtyTerminalSession.getTailLines for non-ANSI line text. Newline joins are not charged by production. */
export function selectProductionTail(lines: readonly string[], options: { lineLimit?: number; maxChars?: number } = {}): ProductionTailResult {
	const lineLimit = Math.max(0, Math.trunc(options.lineLimit ?? SELECTOR_SETTINGS.ordinaryQueryLines));
	const maxChars = Math.max(0, Math.trunc(options.maxChars ?? SELECTOR_SETTINGS.ordinaryQueryMaxChars));
	const start = Math.max(0, lines.length - lineLimit);
	const indices: number[] = [];
	let remaining = maxChars;
	let truncatedByChars = false;
	for (let index = start; index < lines.length; index++) {
		if (remaining <= 0) { truncatedByChars = true; break; }
		remaining -= lines[index]!.length;
		indices.push(index);
	}
	const text = indices.map((index) => lines[index]).join("\n");
	return {
		indices, text,
		truncated: start > 0 || truncatedByChars,
		budgetOvershootChars: Math.max(0, text.length - maxChars),
	};
}

function renderIndices(lines: readonly string[], indices: readonly number[]): string {
	return [...indices].sort((a, b) => a - b).map((index) => lines[index]).join("\n");
}

function renderedWithMarker(lines: readonly string[], indices: readonly number[]): { text: string; markerChars: number } {
	const sorted = [...indices].sort((a, b) => a - b);
	const body = renderIndices(lines, sorted);
	const omitted = lines.length - sorted.length;
	if (omitted === 0) return { text: body, markerChars: 0 };
	const marker = omissionMarker(omitted);
	return { text: body ? `${body}\n${marker}` : marker, markerChars: marker.length + (body ? 1 : 0) };
}

function packSelection(
	lines: readonly string[],
	mandatory: readonly number[],
	optional: readonly number[],
	budget: number,
	overflowReason: PaginationRequiredOutcome["reason"],
): SelectionOutcome {
	const mustKeep = unique(mandatory).sort((a, b) => a - b);
	const mandatoryRendered = renderedWithMarker(lines, mustKeep);
	if (mandatoryRendered.text.length > budget) {
		return {
			status: "pagination-required", reason: overflowReason, selectedIndices: mustKeep,
			recoveryIndices: lines.map((_, index) => index), text: renderIndices(lines, mustKeep),
			recoveryRanges: lines.length ? [{ startLine: 0, endLine: lines.length }] : [],
			omittedLines: 0, markerChars: 0, matchedBudget: false,
		};
	}
	const accepted = [...mustKeep];
	for (const index of unique(optional)) {
		if (accepted.includes(index)) continue;
		const candidate = [...accepted, index].sort((a, b) => a - b);
		if (renderedWithMarker(lines, candidate).text.length > budget) break;
		accepted.push(index);
	}
	accepted.sort((a, b) => a - b);
	const rendered = renderedWithMarker(lines, accepted);
	return { status: "selected", selectedIndices: accepted, text: rendered.text, omittedLines: lines.length - accepted.length, markerChars: rendered.markerChars, matchedBudget: true };
}

function protectedContextCore(fixture: SelectorCorpusFixture): number[] {
	const selected = new Set<number>();
	fixture.lines.forEach(({ text }, index) => {
		if (!PROTECTED.test(sanitizeTerminalTextBuiltIn(text))) return;
		for (let offset = -SELECTOR_SETTINGS.contextRadius; offset <= SELECTOR_SETTINGS.contextRadius; offset++) {
			if (index + offset >= 0 && index + offset < fixture.lines.length) selected.add(index + offset);
		}
	});
	return [...selected].sort((a, b) => a - b);
}

export function selectProtectedContext(fixture: SelectorCorpusFixture): SelectionOutcome {
	const lines = fixture.lines.map(({ text }) => text);
	if (fixture.bypass) return packSelection(lines, allIndices(fixture), [], SELECTOR_SETTINGS.selectorVisibleChars, "bypass-overflow");
	const protectedIndices = protectedContextCore(fixture);
	return packSelection(lines, protectedIndices, allIndices(fixture).reverse(), SELECTOR_SETTINGS.selectorVisibleChars, "protected-overflow");
}

function rowFromSelection(fixture: SelectorCorpusFixture, arm: Exclude<SelectorArm, "tail">, outcome: SelectionOutcome): SelectorRow {
	return metricRow(fixture, arm, outcome.selectedIndices, {
		outcomeStatus: outcome.status, recoveryIndices: outcome.status === "pagination-required" ? outcome.recoveryIndices : [],
		recoveryRanges: outcome.status === "pagination-required" ? outcome.recoveryRanges : [],
		visibleChars: outcome.text.length, markerChars: outcome.markerChars, matchedBudget: outcome.matchedBudget,
		budgetOvershootChars: outcome.matchedBudget ? 0 : Math.max(0, outcome.text.length - SELECTOR_SETTINGS.selectorVisibleChars),
		omittedLines: outcome.omittedLines, ...(outcome.status === "pagination-required" ? { overflowReason: outcome.reason } : {}),
	});
}

function metricRow(fixture: SelectorCorpusFixture, arm: SelectorArm, selectedIndices: number[], base: Omit<SelectorRow, "fixtureId" | "split" | "arm" | "selectedIndices" | "requiredRetained" | "requiredTotal" | "relevantRetained" | "relevantSelected" | "requiredRecall" | "relevantPrecision" | "relevantRecall" | "bypass">): SelectorRow {
	const selected = new Set(selectedIndices);
	const required = fixture.lines.flatMap((item, index) => item.required ? [index] : []);
	const relevant = fixture.lines.flatMap((item, index) => item.relevant ? [index] : []);
	const requiredRetained = required.filter((index) => selected.has(index)).length;
	const relevantRetained = relevant.filter((index) => selected.has(index)).length;
	const relevantSelected = selectedIndices.filter((index) => fixture.lines[index]?.relevant).length;
	return {
		fixtureId: fixture.id, split: fixture.split, arm, selectedIndices, ...base,
		requiredRetained, requiredTotal: required.length, relevantRetained, relevantSelected,
		requiredRecall: required.length ? requiredRetained / required.length : 1,
		relevantPrecision: selectedIndices.length ? relevantSelected / selectedIndices.length : 1,
		relevantRecall: relevant.length ? relevantRetained / relevant.length : 1,
		...(fixture.bypass ? { bypass: fixture.bypass } : {}),
	};
}

function tailRow(fixture: SelectorCorpusFixture): SelectorRow {
	const tail = selectProductionTail(fixture.lines.map(({ text }) => text));
	return metricRow(fixture, "tail", tail.indices, {
		outcomeStatus: "production-tail", recoveryIndices: [], recoveryRanges: [], visibleChars: tail.text.length, markerChars: 0,
		matchedBudget: tail.budgetOvershootChars === 0, budgetOvershootChars: tail.budgetOvershootChars,
		omittedLines: fixture.lines.length - tail.indices.length,
	});
}

export function evaluateOfflineBaselines(fixtures: readonly SelectorCorpusFixture[] = SELECTOR_CORPUS): OfflineSelectorReport {
	return { settings: SELECTOR_SETTINGS, rows: fixtures.flatMap((fixture) => [tailRow(fixture), rowFromSelection(fixture, "protected-context", selectProtectedContext(fixture))]) };
}

function buildRequest(fixture: SelectorCorpusFixture, redact: TerminalRedactor): { request: JevEvaluationRequest; candidates: number[]; chars: number } {
	const protectedIndices = new Set(protectedContextCore(fixture));
	const candidates = allIndices(fixture).filter((index) => !protectedIndices.has(index));
	const stateLines = candidates.map((index) => ({ index, text: redact(fixture.lines[index]!.text) }));
	const state = { goal: redact(fixture.goal), lines: stateLines };
	const questions: Questions = Object.fromEntries(candidates.map((index, position) => [`line_${index}`, {
		type: "noul",
		instructions: `Judge state.lines[${position}], whose index field is original source index ${index}. Must that entry be retained to preserve status, result, failure, decision, command, path, number, or next action?`,
		criteria: { true: "required or useful evidence", false: "disposable routine progress" },
	}]));
	const request = { state, questions, model: SELECTOR_SETTINGS.model };
	return { request, candidates, chars: JSON.stringify(request).length };
}

function isExactUsage(value: unknown): value is { input_tokens: number; output_tokens: number } {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const usage = value as Record<string, unknown>;
	return Object.keys(usage).sort().join(",") === "input_tokens,output_tokens"
		&& Number.isInteger(usage.input_tokens) && (usage.input_tokens as number) >= 0
		&& Number.isInteger(usage.output_tokens) && (usage.output_tokens as number) >= 0;
}

function parseSelection(raw: unknown, candidates: readonly number[]): { selected: number[]; inputTokens: number; outputTokens: number } {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid response");
	const value = raw as Record<string, unknown>;
	if (Object.keys(value).sort().join(",") !== "answers,model,usage" || value.model !== SELECTOR_SETTINGS.model) throw new Error("invalid response");
	if (!value.answers || typeof value.answers !== "object" || Array.isArray(value.answers) || !isExactUsage(value.usage)) throw new Error("invalid response");
	const answers = value.answers as Record<string, unknown>;
	if (Object.keys(answers).sort().join(",") !== candidates.map((index) => `line_${index}`).sort().join(",")) throw new Error("invalid response");
	const selected: number[] = [];
	for (const index of candidates) {
		const answer = answers[`line_${index}`] as Record<string, unknown> | undefined;
		if (!answer || Object.keys(answer).sort().join(",") !== "noul,type" || answer.type !== "noul" || typeof answer.noul !== "number" || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) throw new Error("invalid response");
		if (answer.noul >= SELECTOR_SETTINGS.threshold) selected.push(index);
	}
	return { selected, inputTokens: value.usage.input_tokens, outputTokens: value.usage.output_tokens };
}

function retainUnscored(fixture: SelectorCorpusFixture): SelectionOutcome {
	const lines = fixture.lines.map(({ text }) => text);
	return packSelection(lines, allIndices(fixture), [], SELECTOR_SETTINGS.selectorVisibleChars, "unscored-overflow");
}

export async function evaluateLiveSelector(options: {
	client: JevClient;
	redactionPatterns: readonly string[];
	fixtures?: readonly SelectorCorpusFixture[];
	signal?: AbortSignal;
	limits?: { maxRequests?: number; maxSerializedRequestChars?: number };
}): Promise<LiveSelectorReport> {
	const fixtures = options.fixtures ?? SELECTOR_CORPUS;
	const redact = createTerminalRedactor(options.redactionPatterns);
	const requests: LiveRequestAudit[] = [];
	const rows: SelectorRow[] = [];
	let inputTokens = 0, outputTokens = 0, calls = 0;
	const deadline = AbortSignal.timeout(SELECTOR_SETTINGS.maxTotalMs);
	const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
	const maxRequests = options.limits?.maxRequests ?? SELECTOR_SETTINGS.maxRequests;
	const maxRequestChars = options.limits?.maxSerializedRequestChars ?? SELECTOR_SETTINGS.maxSerializedRequestChars;
	for (const fixture of fixtures) {
		if (fixture.bypass) {
			rows.push(rowFromSelection(fixture, "jev", selectProtectedContext(fixture)));
			requests.push({ fixtureId: fixture.id, status: "bypassed", latencyMs: 0, requestChars: 0 });
			continue;
		}
		const built = buildRequest(fixture, redact);
		if (calls >= maxRequests) {
			rows.push(rowFromSelection(fixture, "jev", retainUnscored(fixture)));
			requests.push({ fixtureId: fixture.id, status: "failed", reason: "request-cap", latencyMs: 0, requestChars: built.chars });
			continue;
		}
		if (built.chars > maxRequestChars) {
			rows.push(rowFromSelection(fixture, "jev", retainUnscored(fixture)));
			requests.push({ fixtureId: fixture.id, status: "failed", reason: "request-size", latencyMs: 0, requestChars: built.chars });
			continue;
		}
		if (signal.aborted) {
			rows.push(rowFromSelection(fixture, "jev", retainUnscored(fixture)));
			requests.push({ fixtureId: fixture.id, status: "failed", reason: "aborted", latencyMs: 0, requestChars: built.chars });
			continue;
		}
		calls += 1;
		const started = Date.now();
		try {
			const raw = await options.client.evaluate(built.request, { signal, timeoutMs: SELECTOR_SETTINGS.requestTimeoutMs });
			if (signal.aborted) throw new Error("selection aborted");
			const parsed = parseSelection(raw, built.candidates);
			inputTokens += parsed.inputTokens; outputTokens += parsed.outputTokens;
			const lines = fixture.lines.map(({ text }) => text);
			const mandatory = [...protectedContextCore(fixture), ...parsed.selected];
			const outcome = packSelection(lines, mandatory, allIndices(fixture).reverse(), SELECTOR_SETTINGS.selectorVisibleChars, "protected-overflow");
			rows.push(rowFromSelection(fixture, "jev", outcome));
			requests.push({ fixtureId: fixture.id, status: "ok", latencyMs: Date.now() - started, requestChars: built.chars, inputTokens: parsed.inputTokens, outputTokens: parsed.outputTokens });
		} catch {
			rows.push(rowFromSelection(fixture, "jev", retainUnscored(fixture)));
			requests.push({ fixtureId: fixture.id, status: "failed", reason: signal.aborted ? "aborted" : "provider-or-response", latencyMs: Date.now() - started, requestChars: built.chars });
		}
	}
	return { settings: SELECTOR_SETTINGS, rows, requests, usage: { inputTokens, outputTokens }, cost: { currency: "USD", amount: null, reason: "SDK response exposes tokens but no authoritative price" } };
}
