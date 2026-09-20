import { appendFileSync, chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { JevDiagnosticsConfig } from "./config.ts";
import type { SemanticAttentionState, SemanticDecision } from "./types.ts";
import { DEFAULT_JEV_MODEL } from "./semantic-policy.ts";

export const SEMANTIC_DIAGNOSTICS_SCHEMA_VERSION = 1;
export const SEMANTIC_CONTRACT_VERSION = 2;

export const SEMANTIC_INCIDENT_KINDS = [
	"missed-notification", "unnecessary-notification", "wrong-notification-type",
	"duplicate-notification", "premature-result", "stale-notification",
] as const;
export type SemanticIncidentKind = typeof SEMANTIC_INCIDENT_KINDS[number];

export const SEMANTIC_EVENT_TYPES = [
	"input-required", "approval-required", "result-ready", "intervention-required", "uncertain", "watch", "evaluator-error", "action-control",
] as const;
export type SemanticDiagnosticEventType = typeof SEMANTIC_EVENT_TYPES[number];
export type SemanticDeliveryOutcome = "delivered" | "suppressed-unchanged" | "suppressed-monitor";
type SemanticActionOutcome = NonNullable<SemanticDecision["action"]>["outcome"];

interface DiagnosticBase {
	schemaVersion: typeof SEMANTIC_DIAGNOSTICS_SCHEMA_VERSION;
	contractVersion: typeof SEMANTIC_CONTRACT_VERSION;
	timestamp: string;
	runId: string;
}

interface DecisionRecord extends DiagnosticBase {
	type: "decision";
	decisionId: number;
	kind: SemanticDecision["kind"];
	route: SemanticDecision["route"];
	mode: "hands-free" | "dispatch" | "monitor";
	model: string;
	latencyMs: number;
	inputTokens?: number;
	attention?: SemanticAttentionState;
	actionOutcome?: NonNullable<SemanticDecision["action"]>["outcome"];
}

interface DeliveryRecord extends DiagnosticBase {
	type: "delivery";
	decisionId: number;
	eventType: SemanticDiagnosticEventType;
	outcome: SemanticDeliveryOutcome;
}

interface RequestRecord extends DiagnosticBase {
	type: "request";
	outcome: "stale-response" | "cancelled-response";
}

export interface IncidentRecord extends DiagnosticBase {
	type: "incident";
	incidentId: string;
	kind: SemanticIncidentKind;
	decisionId?: number;
	expectedEvent?: SemanticDiagnosticEventType;
	observedEvent?: SemanticDiagnosticEventType;
}

type DiagnosticRecord = DecisionRecord | DeliveryRecord | RequestRecord | IncidentRecord;

export interface SemanticDeliveryDiagnostic {
	eventType: SemanticDiagnosticEventType;
	outcome: SemanticDeliveryOutcome;
}

export interface SemanticDiagnosticsSummary {
	days: number;
	files: number;
	malformedLines: number;
	totals: {
		decisions: number;
		deliveries: number;
		incidents: number;
		evaluatorErrors: number;
		secretSkips: number;
		staleResponses: number;
		cancelledResponses: number;
	};
	deliveryOutcomes: Record<SemanticDeliveryOutcome, number>;
	actionOutcomes: Partial<Record<SemanticActionOutcome, number>>;
	incidentsByKind: Partial<Record<SemanticIncidentKind, number>>;
	recurring: Array<{ kind: SemanticIncidentKind; count: number; runs: number }>;
	latestIncidents: IncidentRecord[];
}

const RUNS_KEY = "__piInteractiveShellSemanticDiagnosticRunsV1" as const;
const PROCESS_FILE_ID_KEY = "__piInteractiveShellSemanticDiagnosticFileIdV1" as const;
const runtimeGlobal = globalThis as typeof globalThis & { [RUNS_KEY]?: Map<string, string>; [PROCESS_FILE_ID_KEY]?: string };
const PROCESS_FILE_ID = runtimeGlobal[PROCESS_FILE_ID_KEY] ??= `${process.pid}-${randomUUID()}`;
const sessionRuns = runtimeGlobal[RUNS_KEY] ?? new Map<string, string>();
runtimeGlobal[RUNS_KEY] = sessionRuns;
let warnedStorageFailure = false;

export function semanticDiagnosticsDirectory(): string {
	return join(getAgentDir(), "interactive-shell-diagnostics", "jev");
}

export function getSemanticDiagnosticRunId(sessionId: string): string | undefined {
	return sessionRuns.get(sessionId);
}

export function createSemanticDiagnosticsSession(options: {
	config: JevDiagnosticsConfig;
	sessionId: string;
	mode: "hands-free" | "dispatch" | "monitor";
	model: string;
	directory?: string;
}): SemanticDiagnosticsSession | undefined {
	if (!options.config.enabled) return undefined;
	const runId = randomUUID();
	sessionRuns.set(options.sessionId, runId);
	if (sessionRuns.size > 500) sessionRuns.delete(sessionRuns.keys().next().value!);
	return new SemanticDiagnosticsSession(options.config, options.directory ?? semanticDiagnosticsDirectory(), runId, options.mode, safeModel(options.model));
}

export class SemanticDiagnosticsSession {
	constructor(
		private readonly config: JevDiagnosticsConfig,
		private readonly directory: string,
		readonly runId: string,
		readonly mode: "hands-free" | "dispatch" | "monitor",
		readonly model: string,
	) {}

	recordDecision(decision: SemanticDecision, deliveries: readonly SemanticDeliveryDiagnostic[]): void {
		const record: DecisionRecord = {
			...base(this.runId), type: "decision", decisionId: decision.decisionId, kind: decision.kind,
			route: decision.route, mode: this.mode, model: this.model, latencyMs: decision.latencyMs,
			...(decision.inputTokens === undefined ? {} : { inputTokens: decision.inputTokens }),
			...(decision.kind === "observation" ? { attention: decision.answers.attention.value } : {}),
			...(decision.action ? { actionOutcome: decision.action.outcome } : {}),
		};
		appendRecords(this.directory, this.config, [record, ...deliveries.map((delivery): DeliveryRecord => ({
			...base(this.runId), type: "delivery", decisionId: decision.decisionId, ...delivery,
		}))]);
	}

	recordRequest(outcome: RequestRecord["outcome"]): void {
		appendRecord(this.directory, this.config, { ...base(this.runId), type: "request", outcome });
	}
}

export function recordSemanticIncident(options: {
	config: JevDiagnosticsConfig;
	runId: string;
	kind: SemanticIncidentKind;
	decisionId?: number;
	expectedEvent?: SemanticDiagnosticEventType;
	observedEvent?: SemanticDiagnosticEventType;
	directory?: string;
}): IncidentRecord {
	const record: IncidentRecord = {
		...base(options.runId), type: "incident", incidentId: randomUUID(), kind: options.kind,
		...(options.decisionId === undefined ? {} : { decisionId: options.decisionId }),
		...(options.expectedEvent === undefined ? {} : { expectedEvent: options.expectedEvent }),
		...(options.observedEvent === undefined ? {} : { observedEvent: options.observedEvent }),
	};
	if (!appendRecord(options.directory ?? semanticDiagnosticsDirectory(), options.config, record)) {
		throw new Error("Jev diagnostic incident was not written to local storage.");
	}
	return record;
}

export function summarizeSemanticDiagnostics(options: {
	config: JevDiagnosticsConfig;
	days?: number;
	incidentLimit?: number;
	directory?: string;
}): SemanticDiagnosticsSummary {
	const days = clampInt(options.days, 7, 1, options.config.retentionDays);
	const incidentLimit = clampInt(options.incidentLimit, 20, 1, 100);
	const directory = options.directory ?? semanticDiagnosticsDirectory();
	const cutoff = Date.now() - days * 86_400_000;
	const records: DiagnosticRecord[] = [];
	let malformedLines = 0;
	let files = 0;
	let bytesRead = 0;
	const journals = diagnosticFiles(directory).flatMap((path) => {
		try { const stat = statSync(path); return [{ path, size: stat.size, mtimeMs: stat.mtimeMs }]; }
		catch { return []; }
	}).sort((a, b) => b.mtimeMs - a.mtimeMs);
	for (const journal of journals) {
		try {
			if (journal.size > options.config.maxBytes || bytesRead + journal.size > options.config.maxBytes) continue;
			bytesRead += journal.size;
			files += 1;
			for (const line of readFileSync(journal.path, "utf8").split("\n")) {
				if (!line) continue;
				const record = parseRecord(line);
				if (record && Date.parse(record.timestamp) >= cutoff) records.push(record); else if (!record) malformedLines += 1;
			}
		} catch { malformedLines += 1; }
	}
	const incidents = records.filter((record): record is IncidentRecord => record.type === "incident");
	const incidentsByKind: Partial<Record<SemanticIncidentKind, number>> = {};
	const runsByKind = new Map<SemanticIncidentKind, Set<string>>();
	for (const incident of incidents) {
		incidentsByKind[incident.kind] = (incidentsByKind[incident.kind] ?? 0) + 1;
		const runs = runsByKind.get(incident.kind) ?? new Set<string>();
		runs.add(incident.runId); runsByKind.set(incident.kind, runs);
	}
	const deliveries = records.filter((record): record is DeliveryRecord => record.type === "delivery");
	const deliveryOutcomes: Record<SemanticDeliveryOutcome, number> = { delivered: 0, "suppressed-unchanged": 0, "suppressed-monitor": 0 };
	for (const delivery of deliveries) deliveryOutcomes[delivery.outcome] += 1;
	const decisions = records.filter((record): record is DecisionRecord => record.type === "decision");
	const requests = records.filter((record): record is RequestRecord => record.type === "request");
	const actionOutcomes: Partial<Record<SemanticActionOutcome, number>> = {};
	for (const decision of decisions) {
		if (decision.actionOutcome) actionOutcomes[decision.actionOutcome] = (actionOutcomes[decision.actionOutcome] ?? 0) + 1;
	}
	return {
		days, files, malformedLines,
		totals: {
			decisions: decisions.length, deliveries: deliveries.length, incidents: incidents.length,
			evaluatorErrors: decisions.filter((record) => record.kind === "evaluator-error").length,
			secretSkips: decisions.filter((record) => record.kind === "skipped").length,
			staleResponses: requests.filter((record) => record.outcome === "stale-response").length,
			cancelledResponses: requests.filter((record) => record.outcome === "cancelled-response").length,
		},
		deliveryOutcomes,
		actionOutcomes,
		incidentsByKind,
		recurring: SEMANTIC_INCIDENT_KINDS.flatMap((kind) => {
			const count = incidentsByKind[kind] ?? 0; const runs = runsByKind.get(kind)?.size ?? 0;
			return count >= 3 && runs >= 2 ? [{ kind, count, runs }] : [];
		}),
		latestIncidents: [...incidents].sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, incidentLimit),
	};
}

function base(runId: string): DiagnosticBase {
	return { schemaVersion: SEMANTIC_DIAGNOSTICS_SCHEMA_VERSION, contractVersion: SEMANTIC_CONTRACT_VERSION, timestamp: new Date().toISOString(), runId };
}

function appendRecord(directory: string, config: JevDiagnosticsConfig, record: DiagnosticRecord): boolean {
	return appendRecords(directory, config, [record]);
}

function appendRecords(directory: string, config: JevDiagnosticsConfig, records: readonly DiagnosticRecord[]): boolean {
	const lines = records.map((record) => `${JSON.stringify(record)}\n`);
	if (lines.some((line) => Buffer.byteLength(line) > 4_096)) throw new Error("Semantic diagnostic record exceeded its fixed bound.");
	const content = lines.join("");
	const incomingBytes = Buffer.byteLength(content);
	try {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		chmodSync(directory, 0o700);
		const path = join(directory, `${new Date().toISOString().slice(0, 10)}-${PROCESS_FILE_ID}.jsonl`);
		if (!makeSpace(directory, config, incomingBytes)) return false;
		appendFileSync(path, content, { encoding: "utf8", mode: 0o600 });
		chmodSync(path, 0o600);
		return true;
	} catch {
		if (!warnedStorageFailure) {
			warnedStorageFailure = true;
			console.error("interactive-shell: Jev diagnostics disabled after a local storage failure.");
		}
		return false;
	}
}

function makeSpace(directory: string, config: JevDiagnosticsConfig, incomingBytes: number): boolean {
	const cutoff = Date.now() - config.retentionDays * 86_400_000;
	const cutoffDay = new Date(cutoff).toISOString().slice(0, 10);
	for (const path of diagnosticFiles(directory)) {
		const day = basename(path).slice(0, 10);
		if (day < cutoffDay) rmSync(path);
	}
	const files = diagnosticFiles(directory).filter((path) => basename(path).endsWith(`-${PROCESS_FILE_ID}.jsonl`)).flatMap((path) => {
		try { const stat = statSync(path); return [{ path, size: stat.size, mtimeMs: stat.mtimeMs }]; }
		catch { return []; }
	}).sort((a, b) => a.mtimeMs - b.mtimeMs);
	let total = files.reduce((sum, file) => sum + file.size, 0);
	for (const file of files) {
		if (total + incomingBytes <= config.maxBytes) break;
		rmSync(file.path);
		total -= file.size;
	}
	return total + incomingBytes <= config.maxBytes;
}

function diagnosticFiles(directory: string): string[] {
	try {
		return readdirSync(directory).filter((name) => /^\d{4}-\d{2}-\d{2}-\d+-[0-9a-f-]+\.jsonl$/.test(name)).map((name) => join(directory, name));
	} catch { return []; }
}

function parseRecord(line: string): DiagnosticRecord | undefined {
	try {
		const value: unknown = JSON.parse(line);
		if (!isRecord(value) || value.schemaVersion !== SEMANTIC_DIAGNOSTICS_SCHEMA_VERSION || value.contractVersion !== SEMANTIC_CONTRACT_VERSION
			|| !isTimestamp(value.timestamp) || !isUuid(value.runId) || typeof value.type !== "string") return undefined;
		if (value.type === "incident" && typeof value.incidentId === "string" && isUuid(value.incidentId) && isIncidentKind(value.kind)) {
			return { ...baseFrom(value), type: "incident", incidentId: value.incidentId, kind: value.kind,
				...(validDecisionId(value.decisionId) ? { decisionId: value.decisionId } : {}),
				...(isEventType(value.expectedEvent) ? { expectedEvent: value.expectedEvent } : {}),
				...(isEventType(value.observedEvent) ? { observedEvent: value.observedEvent } : {}) };
		}
		if (value.type === "delivery" && validDecisionId(value.decisionId) && isEventType(value.eventType) && isDeliveryOutcome(value.outcome)) {
			return { ...baseFrom(value), type: "delivery", decisionId: value.decisionId, eventType: value.eventType, outcome: value.outcome };
		}
		if (value.type === "request" && (value.outcome === "stale-response" || value.outcome === "cancelled-response")) {
			return { ...baseFrom(value), type: "request", outcome: value.outcome };
		}
		if (value.type === "decision" && validDecisionId(value.decisionId) && isDecisionKind(value.kind) && isRoute(value.route)
			&& isMode(value.mode) && typeof value.model === "string" && validMetric(value.latencyMs)) {
			return { ...baseFrom(value), type: "decision", decisionId: value.decisionId, kind: value.kind, route: value.route,
				mode: value.mode, model: safeModel(value.model), latencyMs: value.latencyMs,
				...(validMetric(value.inputTokens) ? { inputTokens: value.inputTokens } : {}),
				...(isAttention(value.attention) ? { attention: value.attention } : {}),
				...(isActionOutcome(value.actionOutcome) ? { actionOutcome: value.actionOutcome } : {}) };
		}
	} catch { /* malformed local line */ }
	return undefined;
}

function baseFrom(value: Record<string, unknown>): DiagnosticBase {
	return { schemaVersion: SEMANTIC_DIAGNOSTICS_SCHEMA_VERSION, contractVersion: SEMANTIC_CONTRACT_VERSION, timestamp: value.timestamp as string, runId: value.runId as string };
}
function safeModel(model: string): string { return model === DEFAULT_JEV_MODEL ? DEFAULT_JEV_MODEL : "custom"; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isUuid(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function isTimestamp(value: unknown): value is string { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)); }
function validDecisionId(value: unknown): value is number { return Number.isInteger(value) && (value as number) > 0; }
function validMetric(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER; }
function isIncidentKind(value: unknown): value is SemanticIncidentKind { return typeof value === "string" && (SEMANTIC_INCIDENT_KINDS as readonly string[]).includes(value); }
function isEventType(value: unknown): value is SemanticDiagnosticEventType { return typeof value === "string" && (SEMANTIC_EVENT_TYPES as readonly string[]).includes(value); }
function isDeliveryOutcome(value: unknown): value is SemanticDeliveryOutcome { return value === "delivered" || value === "suppressed-unchanged" || value === "suppressed-monitor"; }
function isAttention(value: unknown): value is SemanticAttentionState { return value === "working" || value === "waiting_input" || value === "waiting_approval" || value === "presenting_result" || value === "blocked" || value === "other"; }
function isDecisionKind(value: unknown): value is SemanticDecision["kind"] { return value === "observation" || value === "evaluator-error" || value === "skipped"; }
function isRoute(value: unknown): value is SemanticDecision["route"] { return value === "continue" || value === "notify" || value === "uncertain" || value === "error"; }
function isMode(value: unknown): value is DecisionRecord["mode"] { return value === "hands-free" || value === "dispatch" || value === "monitor"; }
function isActionOutcome(value: unknown): value is NonNullable<SemanticDecision["action"]>["outcome"] { return value === "executed" || value === "refused" || value === "error" || value === "observe-again" || value === "notified" || value === "stopped" || value === "blocked"; }
function clampInt(value: number | undefined, fallback: number, min: number, max: number): number { return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.trunc(value!))) : fallback; }
