import { stripVTControlCharacters } from "node:util";
import { OUTPUT_SELECTOR_POLICY, selectOutput, type OutputBlock, type OutputKind, type OutputSelectionInput, type OutputSelectionResult } from "./output-selector.ts";
import type { JevClient } from "./jev-client.ts";
import { createTerminalRedactor, sanitizeTerminalTextBuiltIn } from "./terminal-observation.ts";
import type { SelectorClock } from "./output-selector.ts";

export interface OutputSelectionMetadata {
	goal: string;
	command: string;
	status?: string;
}

/** Safe selector-only terminal text: ANSI/control transport is removed and CR overwrites cells on the current physical line. */
export function normalizeSelectorVisibleText(raw: string): string {
	const transport = stripVTControlCharacters(raw);
	const output: string[] = [];
	let cells: string[] = [];
	let cursor = 0;
	for (const character of transport) {
		if (character === "\n") {
			output.push(cells.join(""), "\n");
			cells = [];
			cursor = 0;
			continue;
		}
		if (character === "\r") { cursor = 0; continue; }
		if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(character)) continue;
		if (cursor < cells.length) cells[cursor] = character;
		else cells.push(character);
		cursor += 1;
	}
	output.push(cells.join(""));
	return output.join("");
}

const RAW_SECRET = /(?:(?:api[\s_-]*key|password|passphrase|secret|token|authorization|recovery[\s_-]*code)\s*[:=]|(?:enter|provide|paste)\s+(?:your\s+)?(?:password|token|api[\s_-]*key|credential)|\b(?:(?:sk|pk|ghp|github_pat)[_-][A-Za-z0-9_-]{12,}))/i;

function classify(raw: string): OutputKind {
	const transport = stripVTControlCharacters(raw);
	const controls = transport.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g)?.length ?? 0;
	const visible = normalizeSelectorVisibleText(raw);
	if (controls > Math.max(8, visible.length / 20)) return "binary";
	const trimmed = visible.trim();
	if (/^(?:diff --git|---\s.+\n\+\+\+\s|@@\s)/m.test(trimmed)) return "diff";
	if (/^[{[]/.test(trimmed)) { try { JSON.parse(trimmed); return "json"; } catch { /* text */ } }
	if (/^<\?xml\b|^<[A-Za-z][^>]*>[\s\S]*<\/[A-Za-z]/.test(trimmed)) return "xml";
	if (/^(?:---\s*\n)?(?:[\w.-]+:\s.*\n){2,}/m.test(trimmed)) return "yaml";
	if (/(?:password|passphrase|token|authentication|login)\s*[:?]\s*$/im.test(trimmed)) return "interactive";
	return "text";
}

/** Builds ordered exact raw ranges while keeping provider/display text safely normalized. */
export function buildOutputSelectionInput(sourceId: string, raw: string, metadata: OutputSelectionMetadata, redactionPatterns: readonly string[]): { input: OutputSelectionInput; redact: ReturnType<typeof createTerminalRedactor> } {
	const baseRedact = createTerminalRedactor(redactionPatterns);
	const redact = (value: string) => baseRedact(normalizeSelectorVisibleText(value));
	const blocks: OutputBlock[] = [];
	let start = 0;
	for (let index = 0; index < raw.length; index++) {
		if (raw[index] !== "\n") continue;
		const end = index + 1;
		const text = raw.slice(start, end);
		blocks.push({ range: { start, end }, text, modelText: normalizeSelectorVisibleText(text), kind: /(?:error|fail|warn|diagnostic)/i.test(text) ? "diagnostic" : /(?:result|summary|total|completed)/i.test(text) ? "result" : "output" });
		start = end;
	}
	if (start < raw.length) {
		const text = raw.slice(start);
		blocks.push({ range: { start, end: raw.length }, text, modelText: normalizeSelectorVisibleText(text), kind: /(?:error|fail|warn|diagnostic)/i.test(text) ? "diagnostic" : /(?:result|summary|total|completed)/i.test(text) ? "result" : "output" });
	}
	const normalized = normalizeSelectorVisibleText(raw);
	const conservative = stripVTControlCharacters(raw);
	const customOrBuiltInRedaction = baseRedact(raw) !== sanitizeTerminalTextBuiltIn(raw);
	const goal = metadata.goal.trim();
	return {
		redact,
		input: {
			source: {
				identity: { scheme: "interactive-shell-output-source", id: sourceId, version: "normalized-merged-pty-text-v1" },
				text: raw,
				complete: true,
				kind: classify(raw),
				visibleLength: normalized.length,
				sensitive: RAW_SECRET.test(conservative) || customOrBuiltInRedaction,
			},
			goal,
			command: metadata.command,
			status: metadata.status,
			exact: /\b(?:exact|verbatim|full output|all output)\b/i.test(goal),
			exhaustive: /\b(?:exhaustive|everything|complete transcript)\b/i.test(goal),
			blocks,
		},
	};
}

export async function runOutputSelection(options: {
	sourceId: string;
	raw: string;
	metadata: OutputSelectionMetadata;
	redactionPatterns: readonly string[];
	client: JevClient;
	signal?: AbortSignal;
	clock?: SelectorClock;
}): Promise<OutputSelectionResult> {
	const built = buildOutputSelectionInput(options.sourceId, options.raw, options.metadata, options.redactionPatterns);
	const clock = options.clock ?? { now: Date.now, setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms), clearTimeout: (handle: unknown) => clearTimeout(handle as NodeJS.Timeout) };
	return selectOutput(built.input, { client: options.client, redact: built.redact, signal: options.signal, clock });
}

export { OUTPUT_SELECTOR_POLICY };
