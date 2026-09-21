import { describe, expect, it, vi } from "vitest";
import { SemanticSupervisor, type SemanticObservationSession } from "../semantic-supervisor.ts";
import { createSemanticChoiceAuthorization } from "../semantic-choice-authorization.ts";
import { compileSemanticPermissions } from "../semantic-permissions.ts";
import type { JevClient } from "../jev-client.ts";
import type { SemanticDecisionInput } from "../types.ts";

class ChoiceSession implements SemanticObservationSession {
	exited = false;
	visualGeneration = 0;
	lines: string[] = [];
	writes: string[] = [];
	private listeners: Array<() => void> = [];
	getViewportLines() { return this.lines; }
	addVisualChangeListener(listener: () => void) { this.listeners.push(listener); return () => { this.listeners = this.listeners.filter((item) => item !== listener); }; }
	writeIfActive(data: string) { this.writes.push(data); return true; }
	show(lines: string[]) { this.lines = lines; this.visualGeneration++; for (const listener of [...this.listeners]) listener(); }
}

const answers = (choice: string) => ({
	model: "jev-1.13.0", usage: { input_tokens: 1, output_tokens: 1 }, answers: {
		requests_input: { type: "noul", noul: 0.9 }, requests_approval: { type: "noul", noul: 0.1 },
		presents_result: { type: "noul", noul: 0.1 }, requires_intervention: { type: "noul", noul: 0.1 }, meaningful_progress: { type: "noul", noul: 0.1 },
		attention: { type: "choice", choice: "waiting_input", confidence: 0.99, probabilities: { working: 0, waiting_input: 0.99, waiting_approval: 0, presenting_result: 0, blocked: 0, other: 0.01 } },
		"action_ready:visible_number_1": { type: "noul", noul: 0.99 }, "action_ready:visible_number_2": { type: "noul", noul: 0.99 },
		action: { type: "choice", choice, confidence: 0.99, probabilities: {
			visible_number_1: choice === "visible_number_1" ? 0.99 : 0,
			visible_number_2: choice === "visible_number_2" ? 0.99 : 0,
			observe_again: 0, notify_pi: 0, stop_automation: 0,
		} },
	},
});

async function flush() { for (let index = 0; index < 8; index++) await Promise.resolve(); }

function createSupervisor(options: {
	session: ChoiceSession;
	client: JevClient;
	authorization: { request: (binding: any, label: string, complete: (approved: boolean) => void) => void; dispose(): void };
	interactive?: boolean;
	decisions?: SemanticDecisionInput[];
}) {
	return new SemanticSupervisor({
		session: options.session, mode: "hands-free", config: { goal: "Choose the best release channel", minIntervalMs: 250, dynamicChoices: { enabled: true } },
		client: options.client, model: "jev-1.13.0", requestTimeoutMs: 1_000,
		bounds: { maxViewportLines: 10, maxRecentChars: 500, redactionPatterns: [] }, startedAt: Date.now(),
		isEpochCurrent: () => true, isActionOwner: () => true, reserveGlobalAction: () => true,
		dynamicChoices: { sessionId: "session-1", authorization: options.authorization, isInteractive: () => options.interactive !== false, maxActions: 1, cooldownMs: 0 },
		onDecision: (decision) => options.decisions?.push(decision),
	});
}

describe("goal-driven dynamic visible choices", () => {
	it("lets Jev select only an opaque fresh option id and resolves it to extractor-owned bytes", async () => {
		vi.useFakeTimers();
		const session = new ChoiceSession(); const decisions: SemanticDecisionInput[] = [];
		const client: JevClient = { evaluate: vi.fn(async (request) => {
			const serialized = JSON.stringify(request);
			expect(serialized).toContain("Choose the best release channel");
			expect(serialized).toContain("visible_number_2");
			expect(serialized).toContain("Beta");
			expect(serialized).not.toContain('"bytes"');
			return answers("visible_number_2");
		}) };
		const supervisor = createSupervisor({ session, client, decisions, authorization: { request: (_binding, _label, done) => done(true), dispose() {} } });
		session.show(["Select a release channel", "1. Alpha", "2. Beta"]); supervisor.handleOutput("new menu");
		await vi.advanceTimersByTimeAsync(0); await flush();
		expect(session.writes).toEqual(["2\r"]);
		expect(decisions[0]?.action).toMatchObject({ actionId: "visible_number_2", outcome: "executed" });
		supervisor.dispose(); vi.useRealTimers();
	});

	it("fails closed when the session is headless and does not offer dynamic options", async () => {
		vi.useFakeTimers(); const session = new ChoiceSession();
		const client: JevClient = { evaluate: vi.fn(async () => { throw new Error("no dynamic response"); }) };
		const supervisor = createSupervisor({ session, client, interactive: false, authorization: { request: vi.fn(), dispose() {} } });
		session.show(["Select", "1. Alpha", "2. Beta"]); supervisor.handleOutput("new menu");
		await vi.advanceTimersByTimeAsync(0); await flush();
		expect(session.writes).toEqual([]);
		supervisor.dispose(); vi.useRealTimers();
	});

	it("rechecks freshness after asynchronous approval and refuses a stale choice", async () => {
		vi.useFakeTimers(); const session = new ChoiceSession(); let approve!: (approved: boolean) => void;
		const supervisor = createSupervisor({ session, client: { evaluate: vi.fn(async () => answers("visible_number_1")) }, authorization: { request: (_binding, _label, done) => { approve = done; }, dispose() {} } });
		session.show(["Select", "1. Alpha", "2. Beta"]); supervisor.handleOutput("new menu");
		await vi.advanceTimersByTimeAsync(0); await flush(); expect(session.writes).toEqual([]);
		session.show(["Changed", "1. Gamma", "2. Delta"]); approve(true); await flush();
		expect(session.writes).toEqual([]);
		supervisor.dispose(); vi.useRealTimers();
	});
});

describe("trusted permission and human approval bridge", () => {
	const binding = { sessionId: "s", operationId: "visible_number_1", observationGeneration: 1, observationHash: "hash" };
	it("enforces deny over allow without opening a generic confirmation", async () => {
		const confirm = vi.fn(async () => true); let result: boolean | undefined;
		const authorization = createSemanticChoiceAuthorization({ permissions: compileSemanticPermissions([
			{ decision: "allow", operation: { kind: "dynamic-terminal-choice" } },
			{ decision: "deny", operation: { kind: "dynamic-terminal-choice" } },
		]), ui: { confirm }, isAvailable: () => true });
		authorization.request(binding, "Alpha", (approved) => { result = approved; }); await flush();
		expect(result).toBe(false); expect(confirm).not.toHaveBeenCalled(); authorization.dispose();
	});

	it("requires the bridge's real confirm result for ask and cannot be bypassed by unrelated confirmation", async () => {
		let resolve!: (approved: boolean) => void; let result: boolean | undefined;
		const confirm = vi.fn(() => new Promise<boolean>((done) => { resolve = done; }));
		const authorization = createSemanticChoiceAuthorization({ permissions: compileSemanticPermissions([]), ui: { confirm }, isAvailable: () => true });
		authorization.request(binding, "Alpha", (approved) => { result = approved; });
		expect(confirm).toHaveBeenCalledOnce(); expect(result).toBeUndefined();
		// An unrelated boolean or terminal/model "yes" has no ingress into approval state.
		await Promise.resolve(true); expect(result).toBeUndefined();
		resolve(false); await flush(); expect(result).toBe(false); authorization.dispose();
	});

	it("allows trusted allow without a modal while the dynamic runtime separately enforces interactive UI", async () => {
		const confirm = vi.fn(async () => true); const results: boolean[] = [];
		const permissions = compileSemanticPermissions([{ decision: "allow", operation: { kind: "dynamic-terminal-choice" } }]);
		const allowed = createSemanticChoiceAuthorization({ permissions, ui: { confirm }, isAvailable: () => true });
		allowed.request(binding, "Alpha", (value) => results.push(value)); await flush();
		const unavailable = createSemanticChoiceAuthorization({ permissions, ui: { confirm }, isAvailable: () => false });
		unavailable.request(binding, "Alpha", (value) => results.push(value)); await flush();
		expect(results).toEqual([true, true]); expect(confirm).not.toHaveBeenCalled(); allowed.dispose(); unavailable.dispose();
	});
});
