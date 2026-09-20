import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	createSemanticDiagnosticsSession,
	recordSemanticIncident,
	summarizeSemanticDiagnostics,
} from "../semantic-diagnostics.ts";
import type { JevDiagnosticsConfig } from "../config.ts";
import type { SemanticDecision } from "../types.ts";

const roots: string[] = [];
const config: JevDiagnosticsConfig = { enabled: true, retentionDays: 14, maxBytes: 1_000_000 };

function root(): string {
	const path = mkdtempSync(join(tmpdir(), "semantic-diagnostics-"));
	roots.push(path);
	return path;
}

function decision(overrides: Partial<SemanticDecision> = {}): SemanticDecision {
	return {
		kind: "observation", route: "notify", sessionId: "private-session", decisionId: 1,
		timestamp: new Date().toISOString(), observationHash: "private-observation", generation: 1,
		model: "jev-1.13.0", latencyMs: 12, inputTokens: 44,
		answers: {
			requestsInput: 0.96, requestsApproval: 0, presentsResult: 0, requiresIntervention: 0, meaningfulProgress: 0,
			watches: {}, attention: { value: "waiting_input", confidence: 0.97, probabilities: { working: 0, waiting_input: 0.97, waiting_approval: 0, presenting_result: 0, blocked: 0, other: 0.03 } },
		},
		...overrides,
	} as SemanticDecision;
}

afterEach(() => {
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("semantic diagnostics", () => {
	it("does not create storage while disabled", () => {
		const directory = join(root(), "disabled");
		expect(createSemanticDiagnosticsSession({ config: { ...config, enabled: false }, directory, sessionId: "disabled", mode: "monitor", model: "jev-1.13.0" })).toBeUndefined();
		expect(existsSync(directory)).toBe(false);
	});

	it("persists only fixed metadata and excludes terminal-adjacent values", () => {
		const directory = root();
		const session = createSemanticDiagnosticsSession({ config, directory, sessionId: "SESSION_SECRET", mode: "monitor", model: "MODEL/SECRET" })!;
		session.recordDecision(decision({
			sessionId: "SESSION_SECRET", observationHash: "OBSERVATION_SECRET", model: "MODEL_SECRET",
			action: { choice: "notify_pi", confidence: 1, probability: 1, outcome: "notified", reason: "REASON_SECRET", budgetCount: 1 },
		}), [{ eventType: "input-required", outcome: "delivered" }]);
		const journal = readdirSync(directory).find((name) => name.endsWith(".jsonl"))!;
		const text = readFileSync(join(directory, journal), "utf8");
		expect(text).not.toMatch(/SESSION_SECRET|OBSERVATION_SECRET|REASON_SECRET|MODEL\/SECRET|MODEL_SECRET/);
		expect(text).toContain('"model":"custom"');
		expect(text).toContain('"eventType":"input-required"');
		expect(statSync(join(directory, journal)).mode & 0o777).toBe(0o600);
		expect(summarizeSemanticDiagnostics({ config, directory }).actionOutcomes).toEqual({ notified: 1 });
	});

	it("summarizes outcomes and flags repeated incidents across runs", () => {
		const directory = root();
		const first = createSemanticDiagnosticsSession({ config, directory, sessionId: "one", mode: "monitor", model: "jev-1.13.0" })!;
		const second = createSemanticDiagnosticsSession({ config, directory, sessionId: "two", mode: "monitor", model: "jev-1.13.0" })!;
		first.recordDecision(decision(), [{ eventType: "input-required", outcome: "delivered" }]);
		second.recordRequest("stale-response");
		for (const runId of [first.runId, first.runId, second.runId]) {
			recordSemanticIncident({ config, directory, runId, kind: "missed-notification", expectedEvent: "result-ready" });
		}
		const summary = summarizeSemanticDiagnostics({ config, directory });
		expect(summary.totals).toMatchObject({ decisions: 1, deliveries: 1, incidents: 3, staleResponses: 1 });
		expect(summary.deliveryOutcomes.delivered).toBe(1);
		expect(summary.recurring).toEqual([{ kind: "missed-notification", count: 3, runs: 2 }]);
		expect(summary.latestIncidents).toHaveLength(3);
	});

	it("uses independent journals when processes write concurrently", async () => {
		const directory = root();
		const moduleUrl = pathToFileURL(join(process.cwd(), "semantic-diagnostics.ts")).href;
		const scriptPath = join(directory, "writer.ts");
		writeFileSync(scriptPath, `import { createSemanticDiagnosticsSession } from ${JSON.stringify(moduleUrl)}; const config={enabled:true,retentionDays:14,maxBytes:1000000}; createSemanticDiagnosticsSession({config,directory:${JSON.stringify(directory)},sessionId:String(process.pid),mode:"monitor",model:"jev-1.13.0"})!.recordRequest("stale-response");`);
		const run = () => new Promise<void>((resolve, reject) => {
			const child = spawn(join(process.cwd(), "node_modules", ".bin", "vite-node"), [scriptPath], { cwd: process.cwd(), stdio: "ignore" });
			child.once("error", reject);
			child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`diagnostic child exited ${code}`)));
		});
		await Promise.all([run(), run()]);
		rmSync(scriptPath);
		expect(readdirSync(directory).filter((name) => name.endsWith(".jsonl"))).toHaveLength(2);
		expect(summarizeSemanticDiagnostics({ config, directory }).totals.staleResponses).toBe(2);
	});

	it("removes expired journals and bounds the current process journals", () => {
		const directory = root();
		const old = join(directory, "2020-01-01-99-00000000-0000-4000-8000-000000000000.jsonl");
		writeFileSync(old, "expired\n");
		utimesSync(old, new Date(0), new Date(0));
		const bounded = { ...config, retentionDays: 1, maxBytes: 900 };
		const session = createSemanticDiagnosticsSession({ config: bounded, directory, sessionId: "bounded", mode: "monitor", model: "jev-1.13.0" })!;
		for (let id = 1; id <= 20; id += 1) session.recordDecision(decision({ decisionId: id }), []);
		expect(readdirSync(directory)).not.toContain(old.split("/").at(-1));
		const total = readdirSync(directory).filter((name) => name.endsWith(".jsonl")).reduce((sum, name) => sum + statSync(join(directory, name)).size, 0);
		expect(total).toBeLessThanOrEqual(900);
	});

	it("filters expired records by timestamp regardless of journal mtime", () => {
		const directory = root();
		const bounded = { ...config, retentionDays: 1 };
		const session = createSemanticDiagnosticsSession({ config: bounded, directory, sessionId: "age", mode: "monitor", model: "jev-1.13.0" })!;
		session.recordDecision(decision({ decisionId: 1 }), []);
		session.recordDecision(decision({ decisionId: 2 }), []);
		const originalName = readdirSync(directory).find((name) => name.endsWith(".jsonl"))!;
		const cutoff = Date.now() - 86_400_000;
		const cutoffDay = new Date(cutoff).toISOString().slice(0, 10);
		const path = join(directory, `${cutoffDay}${originalName.slice(10)}`);
		renameSync(join(directory, originalName), path);
		const lines = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
		lines[0]!.timestamp = `${cutoffDay}T00:00:00.000Z`;
		lines[1]!.timestamp = new Date(cutoff + 60_000).toISOString();
		writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
		utimesSync(path, new Date(0), new Date(0));
		expect(summarizeSemanticDiagnostics({ config: bounded, directory, days: 1 }).totals.decisions).toBe(1);
	});

	it("skips malformed or forged local records instead of returning their fields", () => {
		const directory = root();
		writeFileSync(join(directory, "2026-01-01-1-00000000-0000-4000-8000-000000000000.jsonl"), '{"type":"incident","kind":"PRIVATE_FORGERY"}\nnot-json\n');
		const summary = summarizeSemanticDiagnostics({ config, directory, days: 14 });
		expect(summary.totals.incidents).toBe(0);
		expect(summary.malformedLines).toBe(2);
		expect(JSON.stringify(summary)).not.toContain("PRIVATE_FORGERY");
	});
});
