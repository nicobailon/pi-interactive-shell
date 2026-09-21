import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compileSemanticActions } from "../semantic-actions.ts";
import { buildSemanticRequest, parseSemanticResult, SemanticSupervisor, type SemanticObservationSession } from "../semantic-supervisor.ts";
import type { JevClient } from "../jev-client.ts";
import type { SemanticActionItemConfig, SemanticDecisionInput } from "../types.ts";
import { toolParameters } from "../tool-schema.ts";
import { InteractiveShellCoordinator } from "../runtime-coordinator.ts";

class ActionSession implements SemanticObservationSession {
	exited = false;
	visualGeneration = 0;
	lines: string[] = [];
	writes: string[] = [];
	active = true;
	private listeners: Array<() => void> = [];
	getViewportLines() { return this.lines; }
	addVisualChangeListener(cb: () => void) { this.listeners.push(cb); return () => { this.listeners = this.listeners.filter((x) => x !== cb); }; }
	writeIfActive(data: string) { if (!this.active || this.exited) return false; this.writes.push(data); return true; }
	mutate(text: string | string[]) { this.lines = Array.isArray(text) ? text : [text]; this.visualGeneration++; for (const cb of [...this.listeners]) cb(); }
	bump() { this.visualGeneration++; for (const cb of [...this.listeners]) cb(); }
}

const config = (items: SemanticActionItemConfig[], maxActions = 3) => ({ minIntervalMs: 250, actions: { enabled: true as const, maxActions, items } });
const baseAnswers = () => ({
	requests_input: { type: "noul", noul: 0.1 }, requests_approval: { type: "noul", noul: 0.1 },
	presents_result: { type: "noul", noul: 0.1 }, requires_intervention: { type: "noul", noul: 0.1 }, meaningful_progress: { type: "noul", noul: 0.8 },
	attention: { type: "choice", choice: "working", confidence: 0.95, probabilities: { working: 0.95, waiting_input: 0.01, waiting_approval: 0.01, presenting_result: 0.01, blocked: 0.01, other: 0.01 } },
});
function actionResult(ids: string[], choice: string, options: { confidence?: number; selected?: number; readiness?: number } = {}) {
	const choices = [...ids, "observe_again", "notify_pi", "stop_automation"];
	const probabilities = Object.fromEntries(choices.map((id) => [id, id === choice ? (options.selected ?? 0.96) : 0.01]));
	const readiness = Object.fromEntries(ids.map((id) => [`action_ready:${id}`, { type: "noul", noul: options.readiness ?? 0.97 }]));
	return { model: "jev-1.13.0", usage: { input_tokens: 1, output_tokens: 1 }, answers: { ...baseAnswers(), ...readiness,
		action: { type: "choice", choice, confidence: options.confidence ?? 0.96, probabilities } } };
}
async function flush() { for (let i = 0; i < 6; i++) await Promise.resolve(); }

function supervisor(session: ActionSession, responses: unknown[], items: SemanticActionItemConfig[], decisions: SemanticDecisionInput[], overrides: { owner?: () => boolean; epoch?: () => boolean; maxActions?: number; reserveGlobalAction?: (() => boolean) | null; redactionPatterns?: string[] } = {}) {
	const semantic = config(items, overrides.maxActions ?? 3);
	const registry = compileSemanticActions(semantic.actions)!;
	const client: JevClient = { evaluate: vi.fn(async () => responses.shift()) };
	return { client, value: new SemanticSupervisor({ session, mode: "monitor", config: semantic, client, actionRegistry: registry,
		model: "jev-1.13.0", requestTimeoutMs: 1000, bounds: { maxViewportLines: 10, maxRecentChars: 100, redactionPatterns: overrides.redactionPatterns ?? [] }, startedAt: Date.now(),
		isEpochCurrent: overrides.epoch ?? (() => true), isActionOwner: overrides.owner ?? (() => true),
		...(overrides.reserveGlobalAction === null ? {} : { reserveGlobalAction: overrides.reserveGlobalAction ?? (() => true) }), onDecision: (d) => decisions.push(d) }) };
}

const text = { id: "confirm", description: "Confirm the visible ordinary prompt", input: "yes", submit: true, maxExecutions: 2 };
const keys = { id: "move", description: "Move to the next visible option", inputKeys: ["down", "enter"] };

describe("authorized semantic action compilation", () => {
	it("publishes only the explicit enabled/maxActions/items action schema", () => {
		const actions = (toolParameters as any).properties.monitor.anyOf?.[0]?.properties?.semantic?.anyOf?.[0]?.properties?.actions
			?? (toolParameters as any).properties.monitor.properties.semantic.properties.actions;
		const schema = JSON.stringify(actions);
		expect(schema).toContain('"enabled"'); expect(schema).toContain('"items"'); expect(schema).toContain('"inputKeys"');
		expect(schema).not.toContain("inputHex"); expect(schema).not.toContain("inputPaste");
	});
	it("copies/freezes valid exact text and named-key actions and applies the default budget", () => {
		const source: { enabled: true; items: Array<Record<string, unknown>> } = { enabled: true, items: [{ ...text }, { ...keys, inputKeys: [...keys.inputKeys] }] };
		const registry = compileSemanticActions(source)!;
		expect(registry.maxActions).toBe(1);
		expect(registry.get("confirm")?.bytes).toBe("yes\r");
		expect(registry.get("move")?.bytes).toBe("\x1b[B\r");
		source.items[0]!.input = "mutated";
		expect(registry.get("confirm")?.bytes).toBe("yes\r");
		expect(Object.isFrozen(registry.actions)).toBe(true);
		expect(Object.isFrozen(registry.get("confirm"))).toBe(true);
	});

	it.each([
		["missing", { id: "a", description: "x" }], ["mixed", { ...text, inputKeys: ["enter"] }],
		["hex", { ...text, inputHex: ["03"] }], ["paste", { ...text, inputPaste: "x" }],
		["duplicate", [text, text]], ["unsafe id", { ...text, id: "bad id" }], ["reserved id", { ...text, id: "notify_pi" }],
		["control text", { ...text, input: "yes\n" }], ["unknown key", { ...keys, inputKeys: ["wat"] }],
		["ctrl-c", { ...keys, inputKeys: ["ctrl+c"] }], ["ctrl-z", { ...keys, inputKeys: ["ctrl+z"] }],
		["unsupported ctrl digit", { ...keys, inputKeys: ["ctrl+1"] }], ["unsupported ctrl symbol", { ...keys, inputKeys: ["ctrl+@"] }],
		["unsupported shift digit", { ...keys, inputKeys: ["shift+1"] }], ["unsupported combined digit alias", { ...keys, inputKeys: ["c-m-1"] }],
		["ctrl-backslash", { ...keys, inputKeys: ["ctrl+\\"] }], ["ctrl-d", { ...keys, inputKeys: ["ctrl+d"] }], ["submit keys", { ...keys, submit: true }],
		["shifted ctrl-c", { ...keys, inputKeys: ["ctrl+shift+c"] }], ["alt ctrl-d", { ...keys, inputKeys: ["alt+ctrl+d"] }],
		["compact shifted ctrl-z", { ...keys, inputKeys: ["c-s-z"] }], ["compact alt ctrl-backslash", { ...keys, inputKeys: ["m-c-\\"] }],
		["lifecycle intent", { ...text, description: "Kill and exit the process" }], ["credential input", { ...text, input: "sk-abcdefghijklmnop" }],
		["hidden lifecycle text", { ...text, description: "Choose the ordinary response", input: "kill 123" }],
		["hidden credential text", { ...text, description: "Choose the ordinary response", input: "password=hunter2" }],
		["hidden payment text", { ...text, description: "Choose the ordinary response", input: "credit card 4111111111111111" }],
		["generic opaque token", { ...text, description: "Choose the ordinary response", input: "a94f17c92b6d43e88a10304d56ef7781" }],
		["shell metacharacters", { ...text, description: "Choose the ordinary response", input: "yes && exit" }],
		["empty", { ...text, input: "" }], ["oversized", { ...text, input: "x".repeat(2001) }],
		["cooldown", { ...text, cooldownMs: -1 }], ["item budget", { ...text, maxExecutions: 11 }],
	] as Array<[string, unknown]>)("rejects %s", (_label, item) => {
		const items = Array.isArray(item) ? item : [item];
		expect(() => compileSemanticActions({ enabled: true, items })).toThrow();
	});

	it("keeps ordinary text responses and benign terminal keys authorized", () => {
		for (const input of ["yes", "continue", "option 2", "Retry this operation?"]) {
			expect(compileSemanticActions({ enabled: true, items: [{ id: "safe", description: "Choose an ordinary response", input }] })?.get("safe")?.bytes).toBe(input);
		}
		const registry = compileSemanticActions({ enabled: true, items: [{ id: "keys", description: "Navigate an ordinary menu", inputKeys: ["enter", "tab", "escape", "up", "shift+tab", "alt+x"] }] })!;
		expect(registry.get("keys")?.bytes).toBe("\r\t\x1b\x1b[A\x1b[Z\x1bx");
	});

	it("rejects equivalent job-control spellings in metadata and exact text without matching ordinary nearby prose", () => {
		for (const spelling of ["job control", "job-control", "job_control"]) {
			expect(() => compileSemanticActions({ enabled: true, items: [{ id: "safe", description: `${spelling} operation`, input: "yes" }] })).toThrow();
			expect(() => compileSemanticActions({ enabled: true, items: [{ id: "safe", description: "Choose an ordinary response", input: `${spelling} operation` }] })).toThrow();
		}
		const ordinary = "control the selected job option";
		expect(compileSemanticActions({ enabled: true, items: [{ id: "safe", description: "Choose an ordinary response", input: ordinary }] })?.get("safe")?.bytes).toBe(ordinary);
	});

	it("rejects disabled, empty, oversized, fractional, zero, and over-cap session budgets", () => {
		for (const actions of [{ enabled: false, items: [text] }, { enabled: true, items: [] }, { enabled: true, items: Array(11).fill(text) },
			{ enabled: true, maxActions: 0, items: [text] }, { enabled: true, maxActions: 1.5, items: [text] }, { enabled: true, maxActions: 11, items: [text] }]) {
			expect(() => compileSemanticActions(actions)).toThrow();
		}
	});
});

describe("authorized semantic action Jev and execution path", () => {
	beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-14T00:00:00Z")); });
	afterEach(() => vi.useRealTimers());

	it("sends ids/descriptions and exact questions, never immutable bytes/input", () => {
		const registry = compileSemanticActions(config([text, keys]).actions)!;
		const observation = { session: { mode: "monitor" as const, lifecycle: "running" as const, elapsedMsBucket: "<1s", quietMsBucket: "<1s" }, terminal: { viewport: ["Continue?"], recentOutput: "", changed: true }, actions: registry.actions.map(({ id, description }) => ({ id, description })), recentActionIds: [] };
		const request = buildSemanticRequest(observation, config([text, keys]), "jev-1.13.0", registry);
		const serialized = JSON.stringify(request);
		expect(Object.keys(request.questions)).toEqual(expect.arrayContaining(["action", "action_ready:confirm", "action_ready:move"]));
		expect((request.questions.action as any).criteria).toMatchObject({ confirm: text.description, move: keys.description, observe_again: expect.any(String), notify_pi: expect.any(String), stop_automation: expect.any(String) });
		expect(serialized).not.toContain("yes\\r");
		expect(serialized).not.toContain("\\u001b[B");
		expect(serialized).not.toContain('"input"');
	});

	it("parser rejects missing, extra, unknown and malformed action answers", () => {
		const registry = compileSemanticActions(config([text]).actions)!;
		const samples: any[] = [];
		const missing = actionResult(["confirm"], "confirm"); delete (missing.answers as any)["action_ready:confirm"]; samples.push(missing);
		const extra = actionResult(["confirm"], "confirm"); (extra.answers as any)["action_ready:extra"] = { type: "noul", noul: 1 }; samples.push(extra);
		const unknown = actionResult(["confirm"], "confirm"); unknown.answers.action.choice = "other"; samples.push(unknown);
		const missingProbability = actionResult(["confirm"], "confirm"); delete missingProbability.answers.action.probabilities.notify_pi; samples.push(missingProbability);
		const bad = actionResult(["confirm"], "confirm"); bad.answers.action.confidence = Number.NaN; samples.push(bad);
		for (const sample of samples) expect(() => parseSemanticResult(sample, config([text]), "jev-1.13.0", registry)).toThrow("JEV_RESPONSE_INVALID");
	});

	it("requires the exact SDK result shape and configured model with fixed validation errors", () => {
		const registry = compileSemanticActions(config([text]).actions)!;
		const mutate = (change: (sample: any) => void) => { const sample = actionResult(["confirm"], "confirm") as any; change(sample); return sample; };
		const samples = [
			mutate((x) => { x.provider_body = "ROOT_SECRET"; }),
			mutate((x) => { x.usage.provider_detail = "USAGE_SECRET"; }),
			mutate((x) => { x.answers.requests_input.explanation = "NOUL_SECRET"; }),
			mutate((x) => { x.answers.attention.explanation = "CHOICE_SECRET"; }),
			mutate((x) => { x.answers.attention.probabilities.PROVIDER_SECRET = 0.1; }),
			mutate((x) => { x.model = "provider-model-secret"; }),
		];
		for (const sample of samples) {
			try { parseSemanticResult(sample, config([text]), "jev-1.13.0", registry); throw new Error("expected rejection"); }
			catch (error) { expect(error).toMatchObject({ message: "JEV_RESPONSE_INVALID" }); }
		}
	});

	it("writes exact text+submit and named-key bytes once when all hard gates pass", async () => {
		const session = new ActionSession(); const decisions: SemanticDecisionInput[] = [];
		const h = supervisor(session, [actionResult(["confirm", "move"], "confirm"), actionResult(["confirm", "move"], "move")], [text, keys], decisions);
		session.mutate("Confirm ordinary operation?"); h.value.handleOutput("Confirm ordinary operation?"); await vi.advanceTimersByTimeAsync(0); await flush();
		expect(session.writes).toEqual(["yes\r"]);
		session.mutate("Choose next option"); h.value.handleOutput("Choose next option"); await vi.advanceTimersByTimeAsync(1000); await flush();
		expect(session.writes).toEqual(["yes\r", "\x1b[B\r"]);
		expect(decisions.map((d) => d.action?.outcome)).toEqual(["executed", "executed"]);
		expect(JSON.stringify(decisions)).not.toContain(text.input);
		expect(JSON.stringify(decisions)).not.toContain(text.description);
		h.value.dispose();
	});

	it("hard confidence, selected probability, readiness, ownership, active-state and session-budget gates block writes", async () => {
		for (const sample of [actionResult(["confirm"], "confirm", { confidence: 0.89 }), actionResult(["confirm"], "confirm", { selected: 0.89 }), actionResult(["confirm"], "confirm", { readiness: 0.94 })]) {
			const session = new ActionSession(); const decisions: SemanticDecisionInput[] = []; const h = supervisor(session, [sample], [text], decisions);
			session.mutate("Confirm?"); h.value.handleOutput("Confirm?"); await vi.advanceTimersByTimeAsync(0); await flush(); expect(session.writes).toEqual([]); h.value.dispose();
		}
		const noOwner = new ActionSession(); const h1 = supervisor(noOwner, [actionResult(["confirm"], "confirm")], [text], [], { owner: () => false });
		noOwner.mutate("Confirm?"); h1.value.handleOutput("Confirm?"); await vi.advanceTimersByTimeAsync(0); await flush(); expect(noOwner.writes).toEqual([]); h1.value.dispose();
		const inactive = new ActionSession(); inactive.active = false; const d: SemanticDecisionInput[] = []; const h2 = supervisor(inactive, [actionResult(["confirm"], "confirm")], [text], d);
		inactive.mutate("Confirm?"); h2.value.handleOutput("Confirm?"); await vi.advanceTimersByTimeAsync(0); await flush(); expect(inactive.writes).toEqual([]); expect(d[0]?.action?.outcome).toBe("refused"); h2.value.dispose();
	});

	it("enforces cooldown, observation dedupe, per-action, and session budgets before writes", async () => {
		const cooldownAction = { ...text, cooldownMs: 1_000, maxExecutions: 3 };
		const session = new ActionSession(); const decisions: SemanticDecisionInput[] = [];
		const h = supervisor(session, Array(4).fill(0).map(() => actionResult(["confirm"], "confirm")), [cooldownAction], decisions, { maxActions: 3 });
		session.mutate("Confirm one?"); h.value.handleOutput("one"); await vi.advanceTimersByTimeAsync(0); await flush();
		session.mutate("Confirm two?"); h.value.handleOutput("two"); await vi.advanceTimersByTimeAsync(250); await flush();
		expect(decisions[1]?.action).toMatchObject({ outcome: "blocked", reason: "cooldown" });
		await vi.advanceTimersByTimeAsync(1000); session.mutate("Confirm three?"); h.value.handleOutput("three"); await vi.advanceTimersByTimeAsync(0); await flush();
		expect(session.writes).toEqual(["yes\r", "yes\r"]); h.value.dispose();

		const dedupeSession = new ActionSession(); const dedupeDecisions: SemanticDecisionInput[] = [];
		const dedupe = supervisor(dedupeSession, [actionResult(["confirm"], "confirm"), actionResult(["confirm"], "confirm")], [text], dedupeDecisions);
		dedupeSession.mutate("Same prompt"); dedupe.value.handleOutput(""); await vi.advanceTimersByTimeAsync(0); await flush();
		dedupeSession.bump(); dedupe.value.handleOutput(""); await vi.advanceTimersByTimeAsync(250); await flush();
		expect(dedupeSession.writes).toEqual(["yes\r"]); expect(dedupeDecisions[1]?.action).toMatchObject({ outcome: "blocked", reason: "observation-dedupe" }); dedupe.value.dispose();

		const limited = { ...text, maxExecutions: 1 };
		const budgetSession = new ActionSession(); const budgetDecisions: SemanticDecisionInput[] = [];
		const budget = supervisor(budgetSession, [actionResult(["confirm"], "confirm"), actionResult(["confirm"], "confirm")], [limited], budgetDecisions, { maxActions: 3 });
		budgetSession.mutate("First?"); budget.value.handleOutput("first"); await vi.advanceTimersByTimeAsync(0); await flush();
		budgetSession.mutate("Second?"); budget.value.handleOutput("second"); await vi.advanceTimersByTimeAsync(1000); await flush();
		expect(budgetSession.writes).toEqual(["yes\r"]); expect(budgetDecisions[1]?.action).toMatchObject({ reason: "action-budget" }); budget.value.dispose();

		const sessionBudget = new ActionSession(); const sessionBudgetDecisions: SemanticDecisionInput[] = [];
		const ordinaryResult = { model: "jev-1.13.0", usage: { input_tokens: 1, output_tokens: 1 }, answers: baseAnswers() };
		const capped = supervisor(sessionBudget, [actionResult(["confirm"], "confirm"), ordinaryResult], [text], sessionBudgetDecisions, { maxActions: 1 });
		sessionBudget.mutate("First only?"); capped.value.handleOutput("first"); await vi.advanceTimersByTimeAsync(0); await flush();
		sessionBudget.mutate("Budget exhausted"); capped.value.handleOutput("second"); await vi.advanceTimersByTimeAsync(250); await flush();
		expect(sessionBudget.writes).toEqual(["yes\r"]); expect(sessionBudgetDecisions[1]?.action).toBeUndefined(); capped.value.dispose();
	});

	it("shares the hard ten-attempt budget across sessions and consumes refused/error attempts", async () => {
		const coordinator = new InteractiveShellCoordinator();
		const reserveGlobalAction = () => coordinator.reserveSemanticActionAttempt();
		const outcomes: Array<string | undefined> = [];
		for (let attempt = 0; attempt < 11; attempt++) {
			const session = new ActionSession();
			if (attempt === 0) session.active = false;
			if (attempt === 1) session.writeIfActive = () => { throw new Error("write failed"); };
			const decisions: SemanticDecisionInput[] = [];
			const h = supervisor(session, [actionResult(["confirm"], "confirm")], [text], decisions, { maxActions: 1, reserveGlobalAction });
			session.mutate(`Confirm attempt ${attempt}?`); h.value.handleOutput(`attempt ${attempt}`);
			await vi.advanceTimersByTimeAsync(0); await flush();
			outcomes.push(decisions[0]?.action?.outcome);
			h.value.dispose();
		}
		expect(outcomes.slice(0, 3)).toEqual(["refused", "error", "executed"]);
		expect(outcomes[9]).toBe("executed");
		expect(outcomes[10]).toBe("blocked");
		expect(coordinator.getSemanticActionAttempts()).toBe(10);
	});

	it("fails closed with global-budget when no shared reservation authority is supplied", async () => {
		const session = new ActionSession(); const decisions: SemanticDecisionInput[] = [];
		const h = supervisor(session, [actionResult(["confirm"], "confirm")], [text], decisions, { reserveGlobalAction: null });
		session.mutate("Confirm?"); h.value.handleOutput("confirm"); await vi.advanceTimersByTimeAsync(0); await flush();
		expect(session.writes).toEqual([]);
		expect(decisions[0]?.action).toMatchObject({ outcome: "blocked", reason: "global-budget" });
		h.value.dispose();
	});

	it("secret prompts never evaluate and changed secret state invalidates an in-flight result", async () => {
		const secret = new ActionSession(); const registry = compileSemanticActions(config([text]).actions)!;
		const skippedClient: JevClient = { evaluate: vi.fn() };
		const skipped = new SemanticSupervisor({ session: secret, mode: "monitor", config: config([text]), actionRegistry: registry, client: skippedClient, model: "jev-1.13.0", requestTimeoutMs: 1000,
			bounds: { maxViewportLines: 5, maxRecentChars: 500, redactionPatterns: ["password"] }, startedAt: Date.now(), isEpochCurrent: () => true, isActionOwner: () => true, onDecision: () => {} });
		secret.mutate(["Password:", "row 1", "row 2", "row 3", "row 4", "row 5"]); skipped.handleOutput(`Password:${" ".repeat(1_000)}`);
		expect((skipped as unknown as { recentOutput: string }).recentOutput).toBe("");
		expect((skipped as unknown as { secretPromptFence?: unknown }).secretPromptFence).toBeDefined();
		secret.mutate("RAW_RESPONSE_SECRET"); skipped.handleOutput("RAW_RESPONSE_SECRET");
		expect((skipped as unknown as { recentOutput: string }).recentOutput).not.toContain("RAW_RESPONSE_SECRET");
		expect((skipped as unknown as { recentOutput: string }).recentOutput).toBe("");
		await vi.advanceTimersByTimeAsync(0);
		expect(skippedClient.evaluate).not.toHaveBeenCalled();
		expect(secret.writes).toEqual([]);
		skipped.dispose();

		const session = new ActionSession(); const work: { resolve?: (x: unknown) => void } = {}; const decisions: SemanticDecisionInput[] = [];
		const client: JevClient = { evaluate: vi.fn(() => new Promise((resolve) => { work.resolve = resolve; })) };
		const value = new SemanticSupervisor({ session, mode: "monitor", config: config([text]), actionRegistry: registry, client, model: "jev-1.13.0", requestTimeoutMs: 1000,
			bounds: { maxViewportLines: 10, maxRecentChars: 100, redactionPatterns: [] }, startedAt: Date.now(), isEpochCurrent: () => true, isActionOwner: () => true, onDecision: (d) => decisions.push(d) });
		session.mutate("Confirm?"); value.handleOutput("Confirm?"); await vi.advanceTimersByTimeAsync(0); expect(client.evaluate).toHaveBeenCalledOnce();
		session.mutate("Enter API key:"); work.resolve!(actionResult(["confirm"], "confirm")); await flush();
		expect(session.writes).toEqual([]); expect(decisions.some((d) => d.action)).toBe(false); value.dispose();
	});

	it("rechecks the trusted pre-redaction secret flag immediately before writing", async () => {
		const session = new ActionSession();
		let resolve!: (value: unknown) => void;
		const decisions: SemanticDecisionInput[] = [];
		const registry = compileSemanticActions(config([text]).actions)!;
		const value = new SemanticSupervisor({
			session, mode: "monitor", config: config([text]), actionRegistry: registry,
			client: { evaluate: vi.fn(() => new Promise((done) => { resolve = done; })) }, model: "jev-1.13.0", requestTimeoutMs: 1_000,
			bounds: { maxViewportLines: 10, maxRecentChars: 100, redactionPatterns: ["ordinary|password"] }, startedAt: Date.now(),
			isEpochCurrent: () => true, isActionOwner: () => true, reserveGlobalAction: () => true, onDecision: (decision) => decisions.push(decision),
		});
		session.mutate(["ordinary:", "hunter2"]); value.handleOutput("stable recent"); await vi.advanceTimersByTimeAsync(0);
		session.lines = ["Password:", "hunter2"];
		resolve(actionResult(["confirm"], "confirm")); await flush();
		expect(session.writes).toEqual([]);
		expect(decisions[0]?.action).toMatchObject({ outcome: "blocked", reason: "changed-hash-or-secret" });
		value.dispose();
	});

	it("waits for changed visual state after a write and controls never write", async () => {
		const session = new ActionSession(); const decisions: SemanticDecisionInput[] = [];
		const responses = [actionResult(["confirm"], "confirm"), actionResult(["confirm"], "observe_again"), actionResult(["confirm"], "notify_pi"), actionResult(["confirm"], "stop_automation")];
		const h = supervisor(session, responses, [text], decisions, { maxActions: 3 });
		session.mutate("Confirm?"); h.value.handleOutput("Confirm?"); await vi.advanceTimersByTimeAsync(0); await flush();
		h.value.handleOutput("same generation"); await vi.advanceTimersByTimeAsync(1000); expect(h.client.evaluate).toHaveBeenCalledTimes(1);
		for (const line of ["changed 1", "changed 2", "changed 3"]) { session.mutate(line); h.value.handleOutput(line); await vi.advanceTimersByTimeAsync(1000); await flush(); }
		expect(session.writes).toEqual(["yes\r"]);
		expect(decisions.map((d) => d.action?.outcome)).toEqual(["executed", "observe-again", "notified", "stopped"]);
		h.value.dispose();
	});

	it("pause, reload epoch, exit, and disposal fence late action results; resume needs fresh output", async () => {
		for (const fence of ["pause", "epoch", "exit", "dispose"] as const) {
			const session = new ActionSession(); let currentEpoch = true; let resolve!: (value: unknown) => void;
			const decisions: SemanticDecisionInput[] = [];
			const registry = compileSemanticActions(config([text]).actions)!;
			const client: JevClient = { evaluate: vi.fn(() => new Promise((done) => { resolve = done; })) };
			const value = new SemanticSupervisor({ session, mode: "monitor", config: config([text]), actionRegistry: registry, client, model: "jev-1.13.0", requestTimeoutMs: 1000,
				bounds: { maxViewportLines: 10, maxRecentChars: 100, redactionPatterns: [] }, startedAt: Date.now(), isEpochCurrent: () => currentEpoch, isActionOwner: () => true, onDecision: (d) => decisions.push(d) });
			session.mutate("Confirm?"); value.handleOutput("Confirm?"); await vi.advanceTimersByTimeAsync(0);
			if (fence === "pause") value.pause();
			if (fence === "epoch") currentEpoch = false;
			if (fence === "exit") session.exited = true;
			if (fence === "dispose") value.dispose();
			resolve(actionResult(["confirm"], "confirm")); await flush();
			expect(session.writes, fence).toEqual([]); expect(decisions, fence).toEqual([]);
			if (fence === "pause") {
				value.resume(); await vi.advanceTimersByTimeAsync(1000); expect(client.evaluate).toHaveBeenCalledOnce();
			}
			value.dispose();
		}
	});
});
