import { describe, expect, it, vi } from "vitest";
import { SemanticSupervisor, type SemanticObservationSession } from "../semantic-supervisor.ts";
import { compileSemanticActions } from "../semantic-actions.ts";
import { createSemanticChoiceAuthorization, type SemanticChoiceAuthorization } from "../semantic-choice-authorization.ts";
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

const ACTION_CONTROLS = ["observe_again", "notify_pi", "stop_automation"] as const;

const answers = (choice: string, options: { confidence?: number; selected?: number; control?: typeof ACTION_CONTROLS[number] } = {}) => ({
	model: "jev-1.13.0", usage: { input_tokens: 1, output_tokens: 1 }, answers: {
		requests_input: { type: "noul", noul: 0.9 }, requests_approval: { type: "noul", noul: 0.1 },
		presents_result: { type: "noul", noul: 0.1 }, requires_intervention: { type: "noul", noul: 0.1 }, meaningful_progress: { type: "noul", noul: 0.1 },
		attention: { type: "choice", choice: "waiting_input", confidence: 0.99, probabilities: { working: 0, waiting_input: 0.99, waiting_approval: 0, presenting_result: 0, blocked: 0, other: 0.01 } },
		dynamic_choice: { type: "choice", choice, confidence: options.confidence ?? 0.99, probabilities: {
			"dynamic:number_1": choice === "dynamic:number_1" ? (options.selected ?? 0.99) : 0,
			"dynamic:number_2": choice === "dynamic:number_2" ? (options.selected ?? 0.99) : 0,
			none: choice === "none" ? (options.selected ?? 0.99) : 0,
		} },
		action: { type: "choice", choice: options.control ?? "observe_again", confidence: options.control ? 0.99 : 0,
			probabilities: Object.fromEntries(ACTION_CONTROLS.map((control) => [control, control === options.control ? 0.99 : 0])) },
	},
});

const observationAnswers = () => {
	const result = answers("dynamic:number_1");
	delete (result.answers as Record<string, unknown>).dynamic_choice;
	delete (result.answers as Record<string, unknown>).action;
	return result;
};

const answersWithFixedControl = (choice: "observe_again" | "notify_pi") => {
	const result = answers("dynamic:number_1");
	return { ...result, answers: { ...result.answers,
		"action_ready:fixed": { type: "noul", noul: 0.99 },
		action: { type: "choice", choice, confidence: 0.99, probabilities: {
			fixed: 0, observe_again: choice === "observe_again" ? 0.99 : 0,
			notify_pi: choice === "notify_pi" ? 0.99 : 0, stop_automation: 0,
		} },
	} };
};

async function flush() { for (let index = 0; index < 8; index++) await Promise.resolve(); }

function createSupervisor(options: {
	session: ChoiceSession;
	client: JevClient;
	authorization: SemanticChoiceAuthorization;
	interactive?: boolean;
	fixedActions?: boolean;
	decisions?: SemanticDecisionInput[];
}) {
	const actionRegistry = options.fixedActions ? compileSemanticActions({ enabled: true, items: [
		{ id: "fixed", description: "Use the configured fixed response", input: "fixed" },
	] }) : undefined;
	return new SemanticSupervisor({
		session: options.session, mode: "hands-free", config: { goal: "Choose the best release channel", minIntervalMs: 250, dynamicChoices: { enabled: true } },
		client: options.client, model: "jev-1.13.0", requestTimeoutMs: 1_000,
		bounds: { maxViewportLines: 10, maxRecentChars: 500, redactionPatterns: [] }, startedAt: Date.now(),
		isEpochCurrent: () => true, isActionOwner: () => true, reserveGlobalAction: () => true,
		...(actionRegistry ? { actionRegistry } : {}),
		dynamicChoices: { sessionId: "session-1", authorization: options.authorization, isInteractive: () => options.interactive !== false },
		onDecision: (decision) => options.decisions?.push(decision),
	});
}

describe("goal-driven dynamic visible choices", () => {
	it("lets Jev select only an opaque fresh option id and resolves it to extractor-owned bytes", async () => {
		vi.useFakeTimers();
		const session = new ChoiceSession(); const decisions: SemanticDecisionInput[] = [];
		const confirm = vi.fn(async () => true);
		const authorization = createSemanticChoiceAuthorization({
			permissions: compileSemanticPermissions([
				{ decision: "allow", operation: { kind: "dynamic-terminal-choice" } },
				{ decision: "deny", operation: { kind: "dynamic-terminal-confirmation" } },
			]),
			ui: { confirm }, isAvailable: () => true,
		});
		const client: JevClient = { evaluate: vi.fn(async (request) => {
			const serialized = JSON.stringify(request);
			expect(serialized).toContain("Choose the best release channel");
			if (!(request.questions as Record<string, unknown>).dynamic_choice) return observationAnswers();
			expect(Object.keys(((request.questions as Record<string, any>).action).criteria)).toEqual(ACTION_CONTROLS);
			expect(serialized).toContain("dynamic:number_2");
			expect(serialized).toContain("Beta");
			expect(Object.keys(((request.questions as Record<string, any>).dynamic_choice).criteria)).toEqual([
				"dynamic:number_1", "dynamic:number_2", "none",
			]);
			expect(serialized).not.toContain('"bytes"');
			expect(serialized).not.toContain("dynamic-terminal-choice");
			return answers("dynamic:number_2");
		}) };
		const supervisor = createSupervisor({ session, client, decisions, authorization });
		session.show(["Preparing release channels"]); supervisor.handleOutput("working");
		await vi.advanceTimersByTimeAsync(0); await flush();
		expect(session.writes).toEqual([]);
		session.show(["Select a release channel", "1. Alpha", "2. Beta"]); supervisor.handleOutput("new menu");
		await vi.advanceTimersByTimeAsync(250); await flush();
		expect(session.writes).toEqual(["2\r"]);
		expect(confirm).not.toHaveBeenCalled();
		expect(decisions[1]?.action).toMatchObject({ actionId: "dynamic:number_2", confidence: 0.99, probability: 0.99, outcome: "executed" });
		supervisor.dispose(); vi.useRealTimers();
	});

	it("blocks a qualified Yes/No confirmation when confirmation policy denies it", async () => {
		vi.useFakeTimers(); const session = new ChoiceSession(); const confirm = vi.fn(async () => true);
		const authorization = createSemanticChoiceAuthorization({
			permissions: compileSemanticPermissions([
				{ decision: "allow", operation: { kind: "dynamic-terminal-choice" } },
				{ decision: "deny", operation: { kind: "dynamic-terminal-confirmation" } },
			]), ui: { confirm }, isAvailable: () => true,
		});
		const supervisor = createSupervisor({ session, client: { evaluate: vi.fn(async () => answers("dynamic:number_1")) }, authorization });
		session.show(["Delete production database?", "1. Yes, proceed", "2. No, go back"]); supervisor.handleOutput("confirmation");
		await vi.advanceTimersByTimeAsync(0); await flush();
		expect(session.writes).toEqual([]);
		expect(confirm).not.toHaveBeenCalled();
		supervisor.dispose(); vi.useRealTimers();
	});

	it("fails closed when the session is headless and does not offer dynamic options", async () => {
		vi.useFakeTimers(); const session = new ChoiceSession();
		const client: JevClient = { evaluate: vi.fn(async (request) => {
			expect((request.questions as Record<string, unknown>).dynamic_choice).toBeUndefined();
			return observationAnswers();
		}) };
		const supervisor = createSupervisor({ session, client, interactive: false, authorization: { request: vi.fn(), dispose() {} } });
		session.show(["Select", "1. Alpha", "2. Beta"]); supervisor.handleOutput("new menu");
		await vi.advanceTimersByTimeAsync(0); await flush();
		expect(session.writes).toEqual([]);
		supervisor.dispose(); vi.useRealTimers();
	});

	it("offers no executable choice and sends zero bytes for an unsupported visible menu", async () => {
		vi.useFakeTimers(); const session = new ChoiceSession();
		const client: JevClient = { evaluate: vi.fn(async (request) => {
			expect((request.questions as Record<string, unknown>).dynamic_choice).toBeUndefined();
			return observationAnswers();
		}) };
		const authorization = { request: vi.fn(), dispose() {} };
		const supervisor = createSupervisor({ session, client, authorization });
		session.show(["Enter a response:", "[ ] Alpha", "[x] Beta"]); supervisor.handleOutput("unsupported");
		await vi.advanceTimersByTimeAsync(0); await flush();
		expect(session.writes).toEqual([]); expect(authorization.request).not.toHaveBeenCalled();
		supervisor.dispose(); vi.useRealTimers();
	});

	it.each(["observe_again", "notify_pi"] as const)("preserves the configured %s control when the independent dynamic choice selects an option", async (control) => {
		vi.useFakeTimers(); const session = new ChoiceSession(); const decisions: SemanticDecisionInput[] = [];
		const authorization = { request: vi.fn(), dispose() {} };
		const supervisor = createSupervisor({ session, client: { evaluate: vi.fn(async () => answersWithFixedControl(control)) },
			decisions, authorization, fixedActions: true });
		session.show(["Select", "1. Alpha", "2. Beta"]); supervisor.handleOutput("menu");
		await vi.advanceTimersByTimeAsync(0); await flush();
		expect(session.writes).toEqual([]); expect(authorization.request).not.toHaveBeenCalled();
		expect(decisions[0]?.action).toMatchObject({ choice: control, outcome: control === "observe_again" ? "observe-again" : "notified" });
		supervisor.dispose(); vi.useRealTimers();
	});

	it.each(["observe_again", "notify_pi"] as const)("gives the dynamic-only %s control priority over a simultaneous dynamic option", async (control) => {
		vi.useFakeTimers(); const session = new ChoiceSession(); const decisions: SemanticDecisionInput[] = [];
		const authorization = { request: vi.fn(), dispose() {} };
		const supervisor = createSupervisor({ session, client: { evaluate: vi.fn(async () => answers("dynamic:number_1", { control })) },
			decisions, authorization });
		session.show(["Select", "1. Alpha", "2. Beta"]); supervisor.handleOutput("menu");
		await vi.advanceTimersByTimeAsync(0); await flush();
		expect(session.writes).toEqual([]); expect(authorization.request).not.toHaveBeenCalled();
		expect(decisions[0]?.action).toMatchObject({ choice: control, outcome: control === "observe_again" ? "observe-again" : "notified" });
		supervisor.dispose(); vi.useRealTimers();
	});

	it("gives dynamic-only stop_automation priority and removes later dynamic offers", async () => {
		vi.useFakeTimers(); const session = new ChoiceSession(); const decisions: SemanticDecisionInput[] = [];
		const requests: unknown[] = []; const authorization = { request: vi.fn(), dispose() {} };
		const client: JevClient = { evaluate: vi.fn(async (request) => {
			requests.push(request);
			return requests.length === 1 ? answers("dynamic:number_1", { control: "stop_automation" }) : observationAnswers();
		}) };
		const supervisor = createSupervisor({ session, client, decisions, authorization });
		session.show(["Select", "1. Alpha", "2. Beta"]); supervisor.handleOutput("first menu");
		await vi.advanceTimersByTimeAsync(0); await flush();
		expect(decisions[0]?.action).toMatchObject({ choice: "stop_automation", outcome: "stopped" });
		session.show(["Select", "1. Stable", "2. Canary"]); supervisor.handleOutput("later menu");
		await vi.advanceTimersByTimeAsync(250); await flush();
		expect((requests[1] as { questions: Record<string, unknown> }).questions).not.toHaveProperty("action");
		expect((requests[1] as { questions: Record<string, unknown> }).questions).not.toHaveProperty("dynamic_choice");
		expect(session.writes).toEqual([]); expect(authorization.request).not.toHaveBeenCalled();
		supervisor.dispose(); vi.useRealTimers();
	});

	it("rechecks freshness after asynchronous approval and refuses a stale choice", async () => {
		vi.useFakeTimers(); const session = new ChoiceSession(); let approve!: (approved: boolean) => void;
		const authorization = createSemanticChoiceAuthorization({ permissions: compileSemanticPermissions([]),
			ui: { confirm: () => new Promise<boolean>((resolve) => { approve = resolve; }) }, isAvailable: () => true });
		const supervisor = createSupervisor({ session, client: { evaluate: vi.fn(async () => answers("dynamic:number_1")) }, authorization });
		session.show(["Select", "1. Alpha", "2. Beta"]); supervisor.handleOutput("new menu");
		await vi.advanceTimersByTimeAsync(0); await flush(); expect(session.writes).toEqual([]);
		session.show(["Changed", "1. Gamma", "2. Delta"]); approve(true); await flush();
		expect(session.writes).toEqual([]);
		supervisor.dispose(); vi.useRealTimers();
	});

	it("executes delayed approval when only elapsed and quiet buckets drift", async () => {
		vi.useFakeTimers(); const session = new ChoiceSession(); let approve!: (approved: boolean) => void;
		const authorization = createSemanticChoiceAuthorization({ permissions: compileSemanticPermissions([]),
			ui: { confirm: () => new Promise<boolean>((resolve) => { approve = resolve; }) }, isAvailable: () => true });
		const supervisor = createSupervisor({ session, client: { evaluate: vi.fn(async () => answers("dynamic:number_1")) }, authorization });
		session.show(["Select", "1. Alpha", "2. Beta"]); supervisor.handleOutput("new menu");
		await vi.advanceTimersByTimeAsync(0); await flush(); expect(session.writes).toEqual([]);
		await vi.advanceTimersByTimeAsync(5_000); approve(true); await flush();
		expect(session.writes).toEqual(["1\r"]);
		supervisor.dispose(); vi.useRealTimers();
	});

	it.each([[0.89, 0.92], [0.87, 0.91]] as const)("executes at confidence %.2f with selected probability %.2f", async (confidence, selected) => {
		vi.useFakeTimers(); const session = new ChoiceSession(); const decisions: SemanticDecisionInput[] = [];
		const supervisor = createSupervisor({ session, client: { evaluate: vi.fn(async () => answers("dynamic:number_2", { confidence, selected })) }, decisions,
			authorization: { request: (_binding, _option, done) => done(true), dispose() {} } });
		session.show(["Select", "1. Alpha", "2. Beta"]); supervisor.handleOutput("menu");
		await vi.advanceTimersByTimeAsync(0); await flush();
		expect(session.writes).toEqual(["2\r"]);
		expect(decisions[0]?.action).toMatchObject({ confidence, probability: selected, outcome: "executed" });
		supervisor.dispose(); vi.useRealTimers();
	});

	it.each([
		["none", answers("none")],
		["low selected probability", answers("dynamic:number_1", { confidence: 0.99, selected: 0.89 })],
	])("sends zero bytes for %s", async (_name, response) => {
		vi.useFakeTimers(); const session = new ChoiceSession(); const decisions: SemanticDecisionInput[] = [];
		const supervisor = createSupervisor({ session, client: { evaluate: vi.fn(async () => response) }, decisions,
			authorization: { request: (_binding, _option, done) => done(true), dispose() {} } });
		session.show(["Select", "1. Alpha", "2. Beta"]); supervisor.handleOutput("menu");
		await vi.advanceTimersByTimeAsync(0); await flush();
		expect(session.writes).toEqual([]);
		if (_name !== "none") expect(decisions[0]?.action).toMatchObject({ outcome: "blocked", reason: "choice-threshold" });
		supervisor.dispose(); vi.useRealTimers();
	});

	it("fails closed on a malformed dedicated choice response", async () => {
		vi.useFakeTimers(); const session = new ChoiceSession(); const decisions: SemanticDecisionInput[] = [];
		const malformed = answers("dynamic:number_1"); delete (malformed.answers.dynamic_choice.probabilities as Record<string, number>).none;
		const supervisor = createSupervisor({ session, client: { evaluate: vi.fn(async () => malformed) }, decisions,
			authorization: { request: vi.fn(), dispose() {} } });
		session.show(["Select", "1. Alpha", "2. Beta"]); supervisor.handleOutput("menu");
		await vi.advanceTimersByTimeAsync(0); await flush();
		expect(session.writes).toEqual([]); expect(decisions[0]?.kind).toBe("evaluator-error");
		supervisor.dispose(); vi.useRealTimers();
	});
});

describe("trusted permission and human approval bridge", () => {
	const binding = { sessionId: "s", operationId: "dynamic:number_1", observationGeneration: 1, observationHash: "hash" };
	it("enforces deny over allow without opening a generic confirmation", async () => {
		const confirm = vi.fn(async () => true); let result: boolean | undefined;
		const authorization = createSemanticChoiceAuthorization({ permissions: compileSemanticPermissions([
			{ decision: "allow", operation: { kind: "dynamic-terminal-choice" } },
			{ decision: "deny", operation: { kind: "dynamic-terminal-choice" } },
		]), ui: { confirm }, isAvailable: () => true });
		authorization.request(binding, { operation: { kind: "dynamic-terminal-choice" }, label: "Alpha" }, (approved) => { result = approved; }); await flush();
		expect(result).toBe(false); expect(confirm).not.toHaveBeenCalled(); authorization.dispose();
	});

	it("requires the bridge's real confirm result for ask and cannot be bypassed by unrelated confirmation", async () => {
		let resolve!: (approved: boolean) => void; let result: boolean | undefined;
		const confirm = vi.fn(() => new Promise<boolean>((done) => { resolve = done; }));
		const authorization = createSemanticChoiceAuthorization({ permissions: compileSemanticPermissions([]), ui: { confirm }, isAvailable: () => true });
		authorization.request(binding, { operation: { kind: "dynamic-terminal-choice" }, label: "Alpha" }, (approved) => { result = approved; });
		expect(confirm).toHaveBeenCalledOnce(); expect(result).toBeUndefined();
		// An unrelated boolean or terminal/model "yes" has no ingress into approval state.
		await Promise.resolve(true); expect(result).toBeUndefined();
		resolve(false); await flush(); expect(result).toBe(false); authorization.dispose();
	});

	it("allows trusted allow without a modal while the dynamic runtime separately enforces interactive UI", async () => {
		const confirm = vi.fn(async () => true); const results: boolean[] = [];
		const permissions = compileSemanticPermissions([{ decision: "allow", operation: { kind: "dynamic-terminal-choice" } }]);
		const allowed = createSemanticChoiceAuthorization({ permissions, ui: { confirm }, isAvailable: () => true });
		allowed.request(binding, { operation: { kind: "dynamic-terminal-choice" }, label: "Alpha" }, (value) => results.push(value)); await flush();
		const unavailable = createSemanticChoiceAuthorization({ permissions, ui: { confirm }, isAvailable: () => false });
		unavailable.request(binding, { operation: { kind: "dynamic-terminal-choice" }, label: "Alpha" }, (value) => results.push(value)); await flush();
		expect(results).toEqual([true, true]); expect(confirm).not.toHaveBeenCalled(); allowed.dispose(); unavailable.dispose();
	});
});
