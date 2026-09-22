import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SemanticSupervisor, buildSemanticRequest, parseSemanticResult, routeSemanticAnswers, type SemanticObservationSession } from "../semantic-supervisor.ts";
import type { JevClient } from "../jev-client.ts";
import type { SemanticDecisionInput } from "../types.ts";
import { InteractiveShellCoordinator } from "../runtime-coordinator.ts";

class FakeSession implements SemanticObservationSession {
	exited = false;
	visualGeneration = 0;
	lines: string[] = [];
	private listeners: Array<() => void> = [];
	getViewportLines() { return this.lines; }
	addVisualChangeListener(listener: () => void) { this.listeners.push(listener); return () => { this.listeners = this.listeners.filter((item) => item !== listener); }; }
	mutate(line: string | string[]) { this.lines = Array.isArray(line) ? line : [line]; this.visualGeneration += 1; for (const listener of [...this.listeners]) listener(); }
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

function result(choice = "working", confidence = 0.95) {
	const noul = (value: number) => ({ type: "noul", noul: value });
	return {
		model: "jev-1.13.0", usage: { input_tokens: 42, output_tokens: 6 },
		answers: {
			requests_input: noul(choice === "waiting_input" ? 0.95 : 0.05),
			requests_approval: noul(0.05), presents_result: noul(0.05), requires_intervention: noul(0.05), meaningful_progress: noul(0.9),
			attention: { type: "choice", choice, confidence, probabilities: { working: choice === "working" ? 0.9 : 0.02, waiting_input: choice === "waiting_input" ? 0.9 : 0.02, waiting_approval: choice === "waiting_approval" ? 0.9 : 0.02, presenting_result: choice === "presenting_result" ? 0.9 : 0.02, blocked: choice === "blocked" ? 0.9 : 0.02, other: choice === "other" ? 0.9 : 0.02 } },
		},
	};
}

function createSupervisor(session: FakeSession, client: JevClient, decisions: SemanticDecisionInput[], overrides: { watches?: Array<{ id: string; condition: string }>; epoch?: () => boolean; onDiagnostic?: (outcome: "stale-response" | "cancelled-response") => void } = {}) {
	return new SemanticSupervisor({
		session, mode: "monitor", config: { goal: "test", minIntervalMs: 250, watches: overrides.watches }, client,
		model: "jev-1.13.0", requestTimeoutMs: 1000, startedAt: Date.now(), isEpochCurrent: overrides.epoch ?? (() => true),
		bounds: { maxViewportLines: 10, maxRecentChars: 100, redactionPatterns: [] }, onDecision: (decision) => decisions.push(decision),
		onDiagnostic: overrides.onDiagnostic,
	});
}

async function flush() { for (let i = 0; i < 6; i++) await Promise.resolve(); }

describe("SemanticSupervisor observe-only state machine", () => {
	it("fails closed during construction when redaction compilation is unexpectedly invalid", () => {
		const session = new FakeSession(); const client: JevClient = { evaluate: vi.fn() };
		expect(() => new SemanticSupervisor({
			session, mode: "monitor", config: { minIntervalMs: 250 }, client, model: "jev-1.13.0", requestTimeoutMs: 1000,
			startedAt: Date.now(), bounds: { maxViewportLines: 10, maxRecentChars: 100, redactionPatterns: ["(?=unsupported)"] },
			isEpochCurrent: () => true, onDecision: vi.fn(),
		})).toThrow("Semantic redaction configuration invalid.");
		expect(client.evaluate).not.toHaveBeenCalled();
	});

	it("owns the validated redaction snapshot despite caller mutation after construction", async () => {
		const session = new FakeSession(); const requests: unknown[] = [];
		const client: JevClient = { evaluate: vi.fn((request) => { requests.push(request); return new Promise(() => {}); }) };
		const redactionPatterns = ["PRIVATE_VALUE"];
		const supervisor = new SemanticSupervisor({
			session, mode: "monitor", config: { minIntervalMs: 250 }, client, model: "jev-1.13.0", requestTimeoutMs: 1000,
			startedAt: Date.now(), bounds: { maxViewportLines: 10, maxRecentChars: 100, redactionPatterns },
			isEpochCurrent: () => true, onDecision: vi.fn(),
		});
		redactionPatterns[0] = "OTHER_VALUE";
		session.mutate("PRIVATE_VALUE"); supervisor.handleOutput("PRIVATE_VALUE");
		expect((supervisor as unknown as { recentOutput: string }).recentOutput).toBe("[REDACTED]");
		await vi.advanceTimersByTimeAsync(0);
		expect(client.evaluate).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(requests[0])).not.toContain("PRIVATE_VALUE");
		expect(JSON.stringify(requests[0])).toContain("[REDACTED]");
		supervisor.dispose();
	});

	it("applies one opaque compiled custom redactor before retaining whole or split matches", () => {
		const session = new FakeSession();
		const supervisor = new SemanticSupervisor({
			session, mode: "monitor", config: { minIntervalMs: 250 }, client: { evaluate: vi.fn(() => new Promise(() => {})) },
			model: "jev-1.13.0", requestTimeoutMs: 1_000, startedAt: Date.now(),
			bounds: { maxViewportLines: 10, maxRecentChars: 100, redactionPatterns: ["MAGIC-[0-9]+"] }, isEpochCurrent: () => true, onDecision: vi.fn(),
		});
		const retained = supervisor as unknown as {
			recentOutput: string;
			retainedRedactor: (value: string) => string;
			options: { bounds: { redactor: (value: string) => string } };
		};
		const compiled = retained.retainedRedactor;
		expect(compiled).toBe(retained.options.bounds.redactor);
		expect(Object.isFrozen(compiled)).toBe(true);
		expect(Reflect.ownKeys(compiled)).toEqual(["length", "name"]);

		session.mutate("ordinary"); supervisor.handleOutput("MAGIC-987654");
		expect(retained.recentOutput).toBe("[REDACTED]");
		expect(retained.recentOutput).not.toContain("MAGIC-987654");
		supervisor.handleOutput(" MAGIC-");
		expect(retained.recentOutput).toBe("[REDACTED] MAGIC-");
		supervisor.handleOutput("12345");
		expect(retained.recentOutput).toBe("[REDACTED] [REDACTED]");
		expect(retained.retainedRedactor).toBe(compiled);
		supervisor.dispose();
	});

	it("never retains raw split secret responses and resumes only after a later clean transition", async () => {
		const retained = (supervisor: SemanticSupervisor) => supervisor as unknown as { recentOutput: string; secretPromptFence?: unknown };
		const session = new FakeSession();
		const evaluate = vi.fn(async () => result());
		const decisions: SemanticDecisionInput[] = [];
		const supervisor = new SemanticSupervisor({
			session, mode: "monitor", config: { minIntervalMs: 250 }, client: { evaluate }, model: "jev-1.13.0", requestTimeoutMs: 1_000,
			startedAt: Date.now(), bounds: { maxViewportLines: 10, maxRecentChars: 100, redactionPatterns: ["password"] },
			isEpochCurrent: () => true, onDecision: (decision) => decisions.push(decision),
		});

		session.mutate("Password:"); supervisor.handleOutput("Password:");
		expect(retained(supervisor).recentOutput).toBe("");
		expect(retained(supervisor).recentOutput).not.toContain("hunter2");
		supervisor.handleOutput("\nhunter2");
		expect(retained(supervisor).recentOutput).toBe("");
		expect(retained(supervisor).recentOutput).not.toContain("hunter2");
		await vi.advanceTimersByTimeAsync(0);
		expect(evaluate).not.toHaveBeenCalled();
		expect(decisions[0]).toMatchObject({ kind: "skipped", reason: "secret-prompt" });

		supervisor.dispose();
		for (const prompt of ["Authentication code:", "PIN:"]) {
			const guardedSession = new FakeSession();
			const guardedEvaluate = vi.fn(async () => result());
			const guarded = new SemanticSupervisor({
				session: guardedSession, mode: "monitor", config: { minIntervalMs: 250 }, client: { evaluate: guardedEvaluate }, model: "jev-1.13.0", requestTimeoutMs: 1_000,
				startedAt: Date.now(), bounds: { maxViewportLines: 10, maxRecentChars: 100, redactionPatterns: [] }, isEpochCurrent: () => true, onDecision: vi.fn(),
			});
			guardedSession.mutate(prompt); guarded.handleOutput(prompt);
			expect(retained(guarded).recentOutput, prompt).toBe("");
			await vi.advanceTimersByTimeAsync(0);
			guardedSession.mutate("654321"); guarded.handleOutput("654321");
			expect(retained(guarded).recentOutput, prompt).toBe("");
			expect(guardedEvaluate, prompt).not.toHaveBeenCalled();
			guarded.dispose();
		}
		const mfaSession = new FakeSession();
		const requests: unknown[] = [];
		const mfa = new SemanticSupervisor({
			session: mfaSession, mode: "monitor", config: { minIntervalMs: 250 }, client: { evaluate: vi.fn(async (request) => { requests.push(request); return result(); }) },
			model: "jev-1.13.0", requestTimeoutMs: 1_000, startedAt: Date.now(), bounds: { maxViewportLines: 10, maxRecentChars: 100, redactionPatterns: ["mfa"] },
			isEpochCurrent: () => true, onDecision: vi.fn(),
		});
		mfaSession.mutate("Enter MFA code:"); mfa.handleOutput("Enter MFA code:");
		expect(retained(mfa).recentOutput).toBe("");
		await vi.advanceTimersByTimeAsync(0);
		expect(requests).toEqual([]);
		mfaSession.mutate("123456"); mfa.handleOutput("123456");
		expect(retained(mfa).recentOutput).toBe("");
		expect(retained(mfa).secretPromptFence).toBeUndefined();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(requests).toEqual([]);
		mfaSession.mutate("clean transition"); mfa.handleOutput("clean transition");
		await vi.advanceTimersByTimeAsync(0); await flush();
		expect(requests).toHaveLength(1);
		expect(JSON.stringify(requests[0])).toContain("clean transition");
		expect(JSON.stringify(requests[0])).not.toMatch(/123456|MFA code/i);
		mfa.dispose();
	});

	it("discards a truncated password response while fenced and resumes only on later clean output", async () => {
		const retained = (supervisor: SemanticSupervisor) => supervisor as unknown as { recentOutput: string; secretPromptFence?: unknown };
		const session = new FakeSession();
		const requests: unknown[] = [];
		const evaluate = vi.fn(async (request) => { requests.push(request); return result(); });
		const supervisor = new SemanticSupervisor({
			session, mode: "monitor", config: { minIntervalMs: 250 }, client: { evaluate }, model: "jev-1.13.0", requestTimeoutMs: 1_000,
			startedAt: Date.now(), bounds: { maxViewportLines: 5, maxRecentChars: 500, redactionPatterns: ["password"] },
			isEpochCurrent: () => true, onDecision: vi.fn(),
		});
		session.mutate(["Password:", "row 1", "row 2", "row 3", "row 4", "row 5"]);
		supervisor.handleOutput(`Password:${" ".repeat(1_000)}`);
		expect(retained(supervisor).recentOutput).toBe("");
		expect(retained(supervisor).secretPromptFence).toBeDefined();
		session.mutate("RAW_RESPONSE_SECRET"); supervisor.handleOutput("RAW_RESPONSE_SECRET");
		expect(retained(supervisor).recentOutput).toBe("");
		expect(JSON.stringify({ recentOutput: retained(supervisor).recentOutput, fence: retained(supervisor).secretPromptFence })).not.toContain("RAW_RESPONSE_SECRET");
		await vi.advanceTimersByTimeAsync(1_000);
		expect(evaluate).not.toHaveBeenCalled();
		session.mutate("safe later output"); supervisor.handleOutput("safe later output");
		await vi.advanceTimersByTimeAsync(0); await flush();
		expect(evaluate).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(requests[0])).toContain("safe later output");
		expect(JSON.stringify(requests[0])).not.toContain("RAW_RESPONSE_SECRET");
		supervisor.dispose();

		for (const [position, chunk] of [
			["head", `Password:${" ".repeat(1_000)}`],
			["middle", `${" ".repeat(600)}Password:${" ".repeat(600)}`],
			["tail", `${" ".repeat(1_000)}Password:`],
		] as const) {
			const positionedSession = new FakeSession();
			const positioned = new SemanticSupervisor({
				session: positionedSession, mode: "monitor", config: { minIntervalMs: 250 }, client: { evaluate: vi.fn() }, model: "jev-1.13.0", requestTimeoutMs: 1_000,
				startedAt: Date.now(), bounds: { maxViewportLines: 5, maxRecentChars: 500, redactionPatterns: [] }, isEpochCurrent: () => true, onDecision: vi.fn(),
			});
			positionedSession.mutate(["old prompt row", "row 1", "row 2", "row 3", "row 4", "row 5"]);
			positioned.handleOutput(chunk);
			expect(retained(positioned).recentOutput, position).toBe("");
			expect(retained(positioned).secretPromptFence, position).toBeDefined();
			positioned.dispose();
		}
	});

	beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-14T00:00:00Z")); });
	afterEach(() => vi.useRealTimers());

	it("coalesces A/B/C to A then newest C with concurrency one and rejects stale A", async () => {
		const session = new FakeSession();
		const calls: Array<{ request: unknown; signal: AbortSignal; work: ReturnType<typeof deferred<unknown>> }> = [];
		let active = 0; let maxActive = 0;
		const client: JevClient = { evaluate: vi.fn((_request, options) => {
			active += 1; maxActive = Math.max(maxActive, active);
			const work = deferred<unknown>(); calls.push({ request: _request, signal: options.signal, work });
			return work.promise.finally(() => { active -= 1; });
		}) };
		const decisions: SemanticDecisionInput[] = [];
		const diagnostics = vi.fn();
		const supervisor = createSupervisor(session, client, decisions, { onDiagnostic: diagnostics });

		session.mutate("A"); supervisor.handleOutput("A"); await vi.advanceTimersByTimeAsync(0);
		expect(calls).toHaveLength(1);
		session.mutate("B"); supervisor.handleOutput("B");
		session.mutate("C"); supervisor.handleOutput("C");
		expect(calls[0]?.signal.aborted).toBe(true);
		calls[0]!.work.resolve(result()); await flush();
		expect(decisions).toEqual([]);
		expect(diagnostics).toHaveBeenCalledWith("cancelled-response");
		await vi.advanceTimersByTimeAsync(250);
		expect(calls).toHaveLength(2);
		expect(JSON.stringify(calls[1]?.request)).toContain("ABC");
		expect(maxActive).toBe(1);
		calls[1]!.work.resolve(result()); await flush();
		expect(decisions[0]).toMatchObject({ kind: "observation", route: "continue", model: "jev-1.13.0", inputTokens: 42, generation: 3 });
		supervisor.dispose();
	});

	it("performs one bounded observe-only reassessment when launch remains quiet", async () => {
		const session = new FakeSession();
		const requests: any[] = [];
		const decisions: SemanticDecisionInput[] = [];
		const supervisor = createSupervisor(session, { evaluate: vi.fn(async (request) => { requests.push(request); return result(); }) }, decisions);

		await vi.advanceTimersByTimeAsync(1_999);
		expect(requests).toEqual([]);
		await vi.advanceTimersByTimeAsync(1); await flush();
		expect(requests).toHaveLength(1);
		expect(requests[0].state.observation.terminal).toMatchObject({ viewport: [], recentOutput: "" });
		expect(requests[0].questions).not.toHaveProperty("action");
		expect(decisions).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(60_000); await flush();
		expect(requests).toHaveLength(1);
		supervisor.dispose();
	});

	it("arms one quiet follow-up per output episode without replaying action choices", async () => {
		const session = new FakeSession();
		const requests: any[] = [];
		const decisions: SemanticDecisionInput[] = [];
		const supervisor = createSupervisor(session, { evaluate: vi.fn(async (request) => { requests.push(request); return result(); }) }, decisions);

		session.mutate("working"); supervisor.handleOutput("working");
		await vi.advanceTimersByTimeAsync(0); await flush();
		expect(requests).toHaveLength(1);
		expect(requests[0].state.observation.terminal.changed).toBe(true);

		await vi.advanceTimersByTimeAsync(1_999);
		expect(requests).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1); await flush();
		expect(requests).toHaveLength(2);
		expect(requests[1].state.observation.terminal.changed).toBe(false);
		expect(requests[1].questions).not.toHaveProperty("action");
		expect(decisions).toHaveLength(2);

		await vi.advanceTimersByTimeAsync(60_000); await flush();
		expect(requests).toHaveLength(2);
		supervisor.dispose();
	});

	it("invalidates quiet timers across pause, epoch loss, exit, and disposal", async () => {
		for (const invalidate of ["pause", "epoch", "exit", "dispose"] as const) {
			const session = new FakeSession(); let epoch = true;
			const evaluate = vi.fn(async () => result());
			const supervisor = createSupervisor(session, { evaluate }, [], { epoch: () => epoch });
			session.mutate("working"); supervisor.handleOutput("working");
			await vi.advanceTimersByTimeAsync(0); await flush();
			expect(evaluate, invalidate).toHaveBeenCalledTimes(1);

			if (invalidate === "pause") supervisor.pause();
			if (invalidate === "epoch") epoch = false;
			if (invalidate === "exit") session.exited = true;
			if (invalidate === "dispose") supervisor.dispose();
			await vi.advanceTimersByTimeAsync(2_000); await flush();
			expect(evaluate, invalidate).toHaveBeenCalledTimes(1);
			supervisor.dispose();
		}
	});

	it("invalidates on visual mutation and suppresses late results after pause, disposal, and epoch change", async () => {
		for (const invalidate of ["resize", "pause", "dispose", "epoch"] as const) {
			const session = new FakeSession(); const work = deferred<unknown>(); let epoch = true;
			const client: JevClient = { evaluate: vi.fn(() => work.promise) };
			const decisions: SemanticDecisionInput[] = [];
			const diagnostics = vi.fn();
			const supervisor = createSupervisor(session, client, decisions, { epoch: () => epoch, onDiagnostic: diagnostics });
			session.mutate("A"); supervisor.handleOutput("A"); await vi.advanceTimersByTimeAsync(0);
			if (invalidate === "resize") session.mutate("resized");
			if (invalidate === "pause") supervisor.pause();
			if (invalidate === "dispose") supervisor.dispose();
			if (invalidate === "epoch") epoch = false;
			work.resolve(result()); await flush();
			expect(decisions, invalidate).toEqual([]);
			expect(diagnostics, invalidate).toHaveBeenCalledWith(invalidate === "epoch" ? "stale-response" : "cancelled-response");
			supervisor.dispose();
		}
	});

	it("rejects a result settled in the unbound reload gap and resumes once after fresh output", async () => {
		const coordinator = new InteractiveShellCoordinator();
		const firstApi = {} as never; const secondApi = {} as never;
		coordinator.bindExtensionApi(firstApi);
		const session = new FakeSession(); const work: Array<ReturnType<typeof deferred<unknown>>> = [];
		const client: JevClient = { evaluate: vi.fn(() => { const next = deferred<unknown>(); work.push(next); return next.promise; }) };
		const decisions: SemanticDecisionInput[] = []; const delivered: unknown[] = [];
		const epoch = coordinator.getRuntimeEpoch();
		const supervisor = new SemanticSupervisor({
			session, mode: "monitor", config: { minIntervalMs: 250 }, client, model: "jev-1.13.0", requestTimeoutMs: 1000,
			startedAt: Date.now(), bounds: { maxViewportLines: 10, maxRecentChars: 100, redactionPatterns: [] },
			isEpochCurrent: () => coordinator.isRuntimeEpochCurrent(epoch),
			onDecision: (decision) => { decisions.push(decision); coordinator.runWithExtensionApi((api) => delivered.push(api)); },
		});
		coordinator.setMonitor("reload", {
			pauseSemantic: () => supervisor.pause(),
			rebindSemanticEpoch: (check: () => boolean) => supervisor.rebindEpoch(check),
		} as never);

		session.mutate("before reload"); supervisor.handleOutput("before reload"); await vi.advanceTimersByTimeAsync(0);
		expect(work).toHaveLength(1);
		coordinator.unbindExtensionApi(firstApi);
		expect(work[0]!.promise).toBeDefined();
		work[0]!.resolve(result()); await flush();
		expect(decisions).toEqual([]);
		expect(delivered).toEqual([]);

		coordinator.bindExtensionApi(secondApi);
		await vi.advanceTimersByTimeAsync(1000);
		expect(work).toHaveLength(1);
		session.mutate("after reload"); supervisor.handleOutput("after reload"); await vi.advanceTimersByTimeAsync(0);
		expect(work).toHaveLength(2);
		work[1]!.resolve(result()); await flush();
		expect(decisions).toHaveLength(1);
		expect(delivered).toEqual([secondApi]);
		supervisor.dispose();
	});

	it("requires fresh output after resume and never sends authentication prompts", async () => {
		const evaluate = vi.fn(async () => result());
		for (const prompt of ["Password: hunter2", "Enter verification code:", "Authentication code:", "Security code?", "Enter passcode:", "PIN:"]) {
			const session = new FakeSession(); const decisions: SemanticDecisionInput[] = [];
			const supervisor = createSupervisor(session, { evaluate }, decisions);
			supervisor.pause(); supervisor.resume(); await vi.advanceTimersByTimeAsync(1000);
			expect(evaluate).not.toHaveBeenCalled();
			session.mutate(prompt); supervisor.handleOutput(prompt); await vi.advanceTimersByTimeAsync(0);
			expect(evaluate, prompt).not.toHaveBeenCalled();
			expect(decisions[0], prompt).toMatchObject({ kind: "skipped", reason: "secret-prompt" });
			supervisor.dispose();
		}

		const ordinary = new FakeSession(); const decisions: SemanticDecisionInput[] = [];
		const supervisor = createSupervisor(ordinary, { evaluate }, decisions);
		ordinary.mutate("Verification code module compiled successfully");
		supervisor.handleOutput("Verification code module compiled successfully");
		await vi.advanceTimersByTimeAsync(0); await flush();
		expect(evaluate).toHaveBeenCalledTimes(1);
		expect(decisions[0]).toMatchObject({ kind: "observation", route: "continue" });
		supervisor.dispose();
	});

	it("records typed uncertainty and bounded malformed-response errors", async () => {
		const session = new FakeSession(); const decisions: SemanticDecisionInput[] = [];
		const responses = [result("other", 0.2), { model: "jev-1.13.0", answers: {} }, result("waiting_input")];
		const client: JevClient = { evaluate: vi.fn(async () => responses.shift()) };
		const supervisor = createSupervisor(session, client, decisions);
		session.mutate("ambiguous"); supervisor.handleOutput("ambiguous"); await vi.advanceTimersByTimeAsync(0); await flush();
		expect(decisions[0]).toMatchObject({ kind: "observation", route: "uncertain" });
		session.mutate("new"); supervisor.handleOutput("new"); await vi.advanceTimersByTimeAsync(250); await flush();
		expect(decisions[1]).toMatchObject({ kind: "evaluator-error", route: "error", model: "jev-1.13.0" });
		session.mutate("input"); supervisor.handleOutput("input"); await vi.advanceTimersByTimeAsync(250); await flush();
		expect(decisions[2]).toMatchObject({ kind: "observation", route: "notify", answers: { attention: { value: "waiting_input" } } });
		supervisor.dispose();
	});

	it("fails closed on missing or invalid required SDK usage fields", async () => {
		const notify = result("waiting_input");
		const malformed = [
			{ label: "missing usage", value: { ...notify, usage: undefined } },
			{ label: "missing output", value: { ...notify, usage: { input_tokens: 1 } } },
			{ label: "negative input", value: { ...notify, usage: { input_tokens: -1, output_tokens: 1 } } },
			{ label: "negative output", value: { ...notify, usage: { input_tokens: 1, output_tokens: -1 } } },
			{ label: "nonfinite output", value: { ...notify, usage: { input_tokens: 1, output_tokens: Number.POSITIVE_INFINITY } } },
		];
		for (const sample of malformed) {
			const session = new FakeSession(); const decisions: SemanticDecisionInput[] = [];
			const supervisor = createSupervisor(session, { evaluate: vi.fn(async () => sample.value) }, decisions);
			const terminalLine = `provider-${sample.label}`;
			session.mutate(terminalLine); supervisor.handleOutput(terminalLine);
			await vi.advanceTimersByTimeAsync(0); await flush();
			expect(decisions, sample.label).toHaveLength(1);
			expect(decisions[0], sample.label).toMatchObject({ kind: "evaluator-error", route: "error" });
			expect(JSON.stringify(decisions[0])).not.toContain(terminalLine);
			supervisor.dispose();
		}
	});

	it("keeps provider-controlled malformed response text out of decisions and coordinator details", async () => {
		const malicious = [
			{ ...result(), provider_secret_root: "ROOT_BODY_SECRET" },
			{ ...result(), model: "provider-model-secret" },
			{ ...result(), usage: { ...result().usage, provider_usage_secret: "USAGE_BODY_SECRET" } },
			{ ...result(), answers: { ...result().answers, requests_input: { type: "noul", noul: 0.1, provider_noul_secret: "NOUL_BODY_SECRET" } } },
			{ ...result(), answers: { ...result().answers, attention: { ...result().answers.attention, provider_choice_secret: "CHOICE_BODY_SECRET" } } },
			{ ...result(), answers: { ...result().answers, provider_answer_key_secret: { type: "noul", noul: 1 } } },
		];
		for (const raw of malicious) {
			const session = new FakeSession(); const decisions: SemanticDecisionInput[] = [];
			const supervisor = createSupervisor(session, { evaluate: vi.fn(async () => raw) }, decisions);
			session.mutate("ordinary output"); supervisor.handleOutput("ordinary output"); await vi.advanceTimersByTimeAsync(0); await flush();
			expect(decisions).toHaveLength(1);
			expect(decisions[0]).toMatchObject({ kind: "evaluator-error", model: "jev-1.13.0", error: "SemanticResponseError: semantic evaluator response invalid" });
			const coordinator = new InteractiveShellCoordinator(); coordinator.registerSemanticSession("audit", new Date());
			coordinator.recordSemanticDecision("audit", decisions[0]!);
			const serialized = JSON.stringify(coordinator.getSemanticDecisions("audit"));
			expect(serialized).not.toMatch(/provider|BODY_SECRET/i);
			supervisor.dispose();
		}
	});

	it("constructs independent untrusted-data Nouls, Choice, and semantic watches", () => {
		const observation = { task: "x", session: { mode: "monitor" as const, lifecycle: "running" as const, elapsedMsBucket: "<1s", quietMsBucket: "<1s" }, terminal: { viewport: [] as string[], recentOutput: "", changed: true }, actions: [], recentActionIds: [] };
		const request = buildSemanticRequest(observation, { watches: [{ id: "db", condition: "asks for database" }] }, "jev-1.13.0");
		expect(Object.keys(request.questions)).toEqual(expect.arrayContaining(["requests_input", "requests_approval", "presents_result", "requires_intervention", "meaningful_progress", "watch:db", "attention"]));
		for (const question of Object.values(request.questions)) expect(JSON.stringify(question)).toContain("untrusted data");
		const withWatch = result() as any; withWatch.answers["watch:db"] = { type: "noul", noul: 0.9 };
		expect(parseSemanticResult(withWatch, { watches: [{ id: "db", condition: "asks for database" }] }, "jev-1.13.0").answers.watches.db).toBe(0.9);
	});

	it("routes confident attention directly and treats confident other as uncertain", () => {
		for (const attention of ["waiting_input", "waiting_approval", "presenting_result", "blocked"] as const) {
			const answers = parseSemanticResult(result(attention), {}, "jev-1.13.0").answers;
			expect(routeSemanticAnswers(answers, {})).toBe("notify");
		}
		const other = parseSemanticResult(result("other"), {}, "jev-1.13.0").answers;
		expect(routeSemanticAnswers(other, {})).toBe("uncertain");
	});
});
