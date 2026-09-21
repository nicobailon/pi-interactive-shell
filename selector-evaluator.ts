import type { Questions } from "@typesafe-ai/sdk";
import type { JevClient, JevEvaluationRequest } from "./jev-client.ts";
import { createTerminalRedactor, sanitizeTerminalTextBuiltIn, type TerminalRedactor } from "./terminal-observation.ts";
import { SELECTOR_CORPUS, type SelectorCorpusFixture, type SelectorSplit } from "./selector-corpus.ts";

export const SELECTOR_SETTINGS = Object.freeze({
	model: "jev-1.13.0",
	visibleChars: 420,
	contextRadius: 1,
	threshold: 0.7,
	requestTimeoutMs: 10_000,
	maxRetries: 1,
	concurrency: 1,
	maxRequests: 8,
	maxTotalMs: 90_000,
	maxSerializedRequestChars: 12_000,
});

export type SelectorArm = "tail" | "protected-context" | "jev";
export interface SelectorRow {
	fixtureId: string;
	split: SelectorSplit;
	arm: SelectorArm;
	selectedIndices: number[];
	visibleChars: number;
	omittedLines: number;
	requiredRetained: number;
	requiredTotal: number;
	relevantRetained: number;
	relevantSelected: number;
	requiredRecall: number;
	relevantPrecision: number;
	relevantRecall: number;
	bypass?: string;
}
export interface OfflineSelectorReport { settings: typeof SELECTOR_SETTINGS; rows: SelectorRow[] }
export interface LiveRequestAudit { fixtureId: string; status: "ok" | "failed" | "bypassed"; latencyMs: number; requestChars: number; inputTokens?: number; outputTokens?: number }
export interface LiveSelectorReport {
	settings: typeof SELECTOR_SETTINGS;
	rows: SelectorRow[];
	requests: LiveRequestAudit[];
	usage: { inputTokens: number; outputTokens: number };
	cost: { currency: "USD"; amount: null; reason: string };
}

const PROTECTED = /\b(?:error|fail(?:ed|ure)?|warning|expected|received|tests?|build (?:failed|complete)|report|output|revision|url|next action|approved|consequence)\b/i;
const footer = (omitted: number) => omitted > 0 ? `[omitted:${omitted}; recovery:source]` : "";

function render(lines: readonly string[], selected: readonly number[], budget: number): { indices: number[]; text: string } {
	const accepted: number[] = [];
	for (const index of selected) {
		const candidate = [...accepted, index].sort((a, b) => a - b);
		const body = candidate.map((item) => lines[item]).join("\n");
		const metadata = footer(lines.length - candidate.length);
		const text = metadata ? `${body}\n${metadata}` : body;
		if (text.length <= budget) accepted.push(index);
	}
	accepted.sort((a, b) => a - b);
	const body = accepted.map((index) => lines[index]).join("\n");
	const metadata = footer(lines.length - accepted.length);
	return { indices: accepted, text: metadata ? `${body}\n${metadata}` : body };
}

function allIndices(fixture: SelectorCorpusFixture): number[] { return fixture.lines.map((_, index) => index); }
function bypassOr(fixture: SelectorCorpusFixture, candidates: number[]): number[] { return fixture.bypass ? allIndices(fixture) : candidates; }

export function selectTail(fixture: SelectorCorpusFixture): number[] {
	if (fixture.bypass) return allIndices(fixture);
	const lines = fixture.lines.map(({ text }) => text);
	const candidates = allIndices(fixture).reverse().slice(0, 20);
	return render(lines, candidates, SELECTOR_SETTINGS.visibleChars).indices;
}

export function selectProtectedContext(fixture: SelectorCorpusFixture): number[] {
	if (fixture.bypass) return allIndices(fixture);
	const selected = protectedContextCore(fixture);
	for (let index = fixture.lines.length - 1; index >= 0; index--) selected.add(index);
	return render(fixture.lines.map(({ text }) => text), [...selected], SELECTOR_SETTINGS.visibleChars).indices;
}

function protectedContextCore(fixture: SelectorCorpusFixture): Set<number> {
	const selected = new Set<number>();
	fixture.lines.forEach(({ text }, index) => {
		if (!PROTECTED.test(sanitizeTerminalTextBuiltIn(text))) return;
		for (let offset = -SELECTOR_SETTINGS.contextRadius; offset <= SELECTOR_SETTINGS.contextRadius; offset++) {
			if (index + offset >= 0 && index + offset < fixture.lines.length) selected.add(index + offset);
		}
	});
	return selected;
}

function row(fixture: SelectorCorpusFixture, arm: SelectorArm, proposed: number[]): SelectorRow {
	const lines = fixture.lines.map(({ text }) => text);
	const rendered = render(lines, bypassOr(fixture, proposed), SELECTOR_SETTINGS.visibleChars);
	const selected = new Set(rendered.indices);
	const required = fixture.lines.flatMap((item, index) => item.required ? [index] : []);
	const relevant = fixture.lines.flatMap((item, index) => item.relevant ? [index] : []);
	const requiredRetained = required.filter((index) => selected.has(index)).length;
	const relevantRetained = relevant.filter((index) => selected.has(index)).length;
	const relevantSelected = rendered.indices.filter((index) => fixture.lines[index]?.relevant).length;
	return {
		fixtureId: fixture.id, split: fixture.split, arm, selectedIndices: rendered.indices,
		visibleChars: rendered.text.length, omittedLines: fixture.lines.length - rendered.indices.length,
		requiredRetained, requiredTotal: required.length, relevantRetained, relevantSelected,
		requiredRecall: required.length ? requiredRetained / required.length : 1,
		relevantPrecision: rendered.indices.length ? relevantSelected / rendered.indices.length : 1,
		relevantRecall: relevant.length ? relevantRetained / relevant.length : 1,
		...(fixture.bypass ? { bypass: fixture.bypass } : {}),
	};
}

export function evaluateOfflineBaselines(fixtures: readonly SelectorCorpusFixture[] = SELECTOR_CORPUS): OfflineSelectorReport {
	return { settings: SELECTOR_SETTINGS, rows: fixtures.flatMap((fixture) => [
		row(fixture, "tail", selectTail(fixture)), row(fixture, "protected-context", selectProtectedContext(fixture)),
	]) };
}

function buildRequest(fixture: SelectorCorpusFixture, redact: TerminalRedactor): { request: JevEvaluationRequest; candidates: number[]; chars: number } {
	const protectedIndices = protectedContextCore(fixture);
	const candidates = allIndices(fixture).filter((index) => !protectedIndices.has(index));
	const state = { goal: redact(fixture.goal), lines: candidates.map((index) => ({ index, text: redact(fixture.lines[index]!.text) })) };
	const questions: Questions = Object.fromEntries(candidates.map((index) => [`line_${index}`, {
		type: "noul", instructions: `Must lines[${index}] be retained to preserve status, result, failure, decision, command, path, number, or next action?`,
		criteria: { true: "required or useful evidence", false: "disposable routine progress" },
	}]));
	const request = { state, questions, model: SELECTOR_SETTINGS.model };
	return { request, candidates, chars: JSON.stringify(request).length };
}

function parseSelection(raw: unknown, candidates: readonly number[]): { selected: number[]; inputTokens: number; outputTokens: number } {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid response");
	const value = raw as Record<string, unknown>;
	if (Object.keys(value).sort().join(",") !== "answers,model,usage" || value.model !== SELECTOR_SETTINGS.model) throw new Error("invalid response");
	const answers = value.answers as Record<string, unknown> | undefined;
	const usage = value.usage as Record<string, unknown> | undefined;
	if (!answers || !usage || Object.keys(answers).length !== candidates.length) throw new Error("invalid response");
	if (!Number.isFinite(usage.input_tokens) || !Number.isFinite(usage.output_tokens)) throw new Error("invalid response");
	const selected: number[] = [];
	for (const index of candidates) {
		const answer = answers[`line_${index}`] as Record<string, unknown> | undefined;
		if (!answer || Object.keys(answer).sort().join(",") !== "noul,type" || answer.type !== "noul" || typeof answer.noul !== "number" || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) throw new Error("invalid response");
		if (answer.noul >= SELECTOR_SETTINGS.threshold) selected.push(index);
	}
	return { selected, inputTokens: usage.input_tokens as number, outputTokens: usage.output_tokens as number };
}

export async function evaluateLiveSelector(options: { client: JevClient; redactionPatterns: readonly string[]; fixtures?: readonly SelectorCorpusFixture[] }): Promise<LiveSelectorReport> {
	const fixtures = options.fixtures ?? SELECTOR_CORPUS;
	const redact = createTerminalRedactor(options.redactionPatterns);
	const requests: LiveRequestAudit[] = [];
	const rows: SelectorRow[] = [];
	let inputTokens = 0, outputTokens = 0, calls = 0;
	const deadline = AbortSignal.timeout(SELECTOR_SETTINGS.maxTotalMs);
	for (const fixture of fixtures) {
		if (fixture.bypass) { rows.push(row(fixture, "jev", allIndices(fixture))); requests.push({ fixtureId: fixture.id, status: "bypassed", latencyMs: 0, requestChars: 0 }); continue; }
		const built = buildRequest(fixture, redact);
		const protectedIndices = [...protectedContextCore(fixture)];
		const tailFill = allIndices(fixture).reverse();
		if (++calls > SELECTOR_SETTINGS.maxRequests || built.chars > SELECTOR_SETTINGS.maxSerializedRequestChars) {
			rows.push(row(fixture, "jev", selectProtectedContext(fixture))); requests.push({ fixtureId: fixture.id, status: "failed", latencyMs: 0, requestChars: built.chars }); continue;
		}
		const started = Date.now();
		try {
			const raw = await options.client.evaluate(built.request, { signal: deadline, timeoutMs: SELECTOR_SETTINGS.requestTimeoutMs });
			const parsed = parseSelection(raw, built.candidates);
			inputTokens += parsed.inputTokens; outputTokens += parsed.outputTokens;
			rows.push(row(fixture, "jev", [...new Set([...protectedIndices, ...parsed.selected, ...tailFill])]));
			requests.push({ fixtureId: fixture.id, status: "ok", latencyMs: Date.now() - started, requestChars: built.chars, inputTokens: parsed.inputTokens, outputTokens: parsed.outputTokens });
		} catch {
			// Fail open to the deterministic arm: provider failure cannot authorize additional omission.
			rows.push(row(fixture, "jev", selectProtectedContext(fixture)));
			requests.push({ fixtureId: fixture.id, status: "failed", latencyMs: Date.now() - started, requestChars: built.chars });
		}
	}
	return { settings: SELECTOR_SETTINGS, rows, requests, usage: { inputTokens, outputTokens }, cost: { currency: "USD", amount: null, reason: "SDK response exposes tokens but no authoritative price" } };
}
