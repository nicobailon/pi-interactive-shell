import { describe, expect, it, vi } from "vitest";
import type { PtyTerminalSession } from "../pty-session.ts";
import * as terminalObservation from "../terminal-observation.ts";
import { toolParameters } from "../tool-schema.ts";

const sdk = vi.hoisted(() => ({ constructor: vi.fn(), systemOne: vi.fn() }));
vi.mock("@typesafe-ai/sdk", () => ({
	TypeSafeClient: class {
		retry = { maxRetries: 1 };
		constructor(options: unknown) { sdk.constructor(options); }
		systemOne(request: unknown, options: unknown) { return sdk.systemOne(request, options); }
	},
}));

import { createJevClient, DEFAULT_JEV_MODEL } from "../jev-client.ts";

const { buildTerminalObservation, containsSecretPrompt, createTerminalRedactor, sanitizeTerminalText } = terminalObservation;

function fakeSession(lines: string[], exited = false): PtyTerminalSession {
	return { exited, getViewportLines: () => lines } as unknown as PtyTerminalSession;
}

describe("Jev foundation", () => {
	it("publishes semantic observation without any credential field", () => {
		const schema = JSON.stringify(toolParameters);
		expect(schema).toContain('"semantic"');
		expect(schema).toContain("TYPESAFE_API_KEY");
		expect(schema.replaceAll("TYPESAFE_API_KEY", "credential-env")).not.toMatch(/apiKey|api_key/i);
		const semanticProperties = (toolParameters as any).properties.monitor.properties.semantic.properties;
		expect(semanticProperties).toHaveProperty("attention");
		expect(semanticProperties).toHaveProperty("uncertain");
	});

	it("is gated before SDK client construction and never accepts a key from public configuration", () => {
		expect(() => createJevClient({ enabled: false, model: DEFAULT_JEV_MODEL, maxRetries: 1 }, { TYPESAFE_API_KEY: "present" }))
			.toThrow("disabled");
		expect(() => createJevClient({ enabled: true, model: DEFAULT_JEV_MODEL, maxRetries: 1 }, {}))
			.toThrow("TYPESAFE_API_KEY");
		expect(sdk.constructor).not.toHaveBeenCalled();
	});

	it("pins model, logging, timeout, retries, and AbortSignal at the SDK seam", async () => {
		sdk.systemOne.mockResolvedValueOnce({ model: DEFAULT_JEV_MODEL, answers: {}, usage: { input_tokens: 1, output_tokens: 1 } });
		const client = createJevClient({ enabled: true, model: DEFAULT_JEV_MODEL, maxRetries: 1 }, { TYPESAFE_API_KEY: "present" });
		const signal = new AbortController().signal;
		await client.evaluate({ state: "bounded", questions: { check: { type: "noul" } }, model: DEFAULT_JEV_MODEL }, { signal, timeoutMs: 4321 });
		expect(sdk.constructor).toHaveBeenCalledWith(expect.objectContaining({ defaultModel: "jev-1.13.0", logLevel: "off", retry: { maxRetries: 1 } }));
		expect(sdk.systemOne).toHaveBeenCalledWith(expect.objectContaining({ model: "jev-1.13.0" }), { signal, timeout: 4321, retry: { maxRetries: 1 } });
	});

	it("bounds, strips, and redacts viewport and recent output before hashing", () => {
		const result = buildTerminalObservation({
			session: fakeSession(["old", "\u001b[31mPassword: hunter2\u001b[0m", "token=abc123xyz", "visible"]),
			mode: "monitor", task: "task", recentOutput: `noise\napi_key=supersecret\n${"x".repeat(100)}`,
			changed: true, startedAt: Date.now() - 2000, lastOutputAt: Date.now(), actions: [], recentActionIds: [],
			bounds: { maxViewportLines: 2, maxRecentChars: 40, redactionPatterns: ["abc123xyz"] },
		});
		expect(result.observation.terminal.viewport).toEqual(["token: [REDACTED]", "visible"]);
		expect(result.observation.terminal.recentOutput.length).toBeLessThanOrEqual(40);
		expect(JSON.stringify(result.observation)).not.toContain("supersecret");
		expect(result.hash).toMatch(/^[a-f0-9]{24}$/);
	});

	it("detects bounded secret prompts before attacker-controlled custom redaction", () => {
		const viewport = buildTerminalObservation({
			session: fakeSession(["Password:", "hunter2"]), mode: "monitor", recentOutput: "", changed: true,
			startedAt: Date.now(), lastOutputAt: Date.now(), actions: [], recentActionIds: [],
			bounds: { maxViewportLines: 10, maxRecentChars: 100, redactionPatterns: ["password"] },
		});
		expect(viewport.secretPrompt).toBe(true);
		expect(viewport.observation.terminal.viewport).toEqual(["[REDACTED]:", "hunter2"]);

		const recent = buildTerminalObservation({
			session: fakeSession(["ordinary"]), mode: "monitor", recentOutput: "Password:\nhunter2", changed: true,
			startedAt: Date.now(), lastOutputAt: Date.now(), actions: [], recentActionIds: [],
			bounds: { maxViewportLines: 10, maxRecentChars: 100, redactionPatterns: ["password", "hunter2"] },
		});
		expect(recent.secretPrompt).toBe(true);
		expect(JSON.stringify(recent.observation)).not.toMatch(/password|hunter2/i);
		expect(recent.observation.terminal.recentOutput).toBe("[REDACTED]: [REDACTED]");
	});

	it("applies RE2 redactions globally with case-insensitive Unicode matching and literal replacement", () => {
		expect(sanitizeTerminalText("SÉCRET secret SéCrEt", ["sécret|secret"])).toBe("[REDACTED] [REDACTED] [REDACTED]");
		expect(sanitizeTerminalText("prefix-$1-prefix", ["(prefix)-(\\$1)-prefix"])).toBe("[REDACTED]");
	});

	it("rejects nested catastrophic repetition before matching", () => {
		expect(() => sanitizeTerminalText(`${"a".repeat(100_000)}!`, ["(a+)+$"])).toThrow("Semantic redaction configuration invalid.");
	});

	it("completes a long ambiguous RE2-compatible near miss", () => {
		const input = `${"a".repeat(100_000)}c`;
		expect(sanitizeTerminalText(input, ["(a|aa)+b"])).toBe(input);
	});

	it("exposes only an opaque redactor and recompiles safely after mutable source changes", () => {
		const sources = ["alpha"];
		const first = createTerminalRedactor(sources);
		expect(Object.isFrozen(first)).toBe(true);
		expect(Reflect.ownKeys(first)).toEqual(["length", "name"]);
		expect((terminalObservation as Record<string, unknown>).compileRedactionPatterns).toBeUndefined();
		expect((terminalObservation as Record<string, unknown>).compileRedactionPattern).toBeUndefined();
		expect((terminalObservation as Record<string, unknown>).cacheCompiledRedactionPatterns).toBeUndefined();
		expect((first as unknown as Record<string, unknown>).re2Input).toBeUndefined();
		expect(() => { (first as any).re2Input.prog.start = 0; }).toThrow(TypeError);
		expect(() => { (first as any).re2Input = { prog: { start: 0 } }; }).toThrow(TypeError);
		expect(first("alpha beta")).toBe("[REDACTED] beta");
		sources[0] = "beta";
		const second = createTerminalRedactor(sources);
		expect(second).not.toBe(first);
		expect(Object.isFrozen(second)).toBe(true);
		expect(sanitizeTerminalText("alpha beta", sources)).toBe("alpha [REDACTED]");
		expect(first("alpha beta")).toBe("[REDACTED] beta");
	});

	it("recognizes constrained authentication prompts without classifying ordinary status text", () => {
		const classify = (line: string) => containsSecretPrompt(buildTerminalObservation({
			session: fakeSession([line]), mode: "dispatch", recentOutput: "", changed: true,
			startedAt: Date.now(), lastOutputAt: Date.now(), actions: [], recentActionIds: [],
			bounds: { maxViewportLines: 10, maxRecentChars: 500, redactionPatterns: [] },
		}).observation);
		for (const prompt of [
			"Enter MFA code:", "Enter verification code:", "Authentication code:", "Provide your auth code",
			"Security code?", "Enter passcode:", "PIN:", "Please type your PIN number",
		]) expect(classify(prompt), prompt).toBe(true);
		expect(classify("Verification code module compiled successfully")).toBe(false);
	});

	it("redacts supported standalone token shapes without hiding nearby ordinary text", () => {
		const secretForms = [
			"ghp_abcdefghijklmnop",
			"github_pat_abcdefghijklmnop",
			"sk_live_abcdefghijklmnop",
			"pk_test_abcdefghijklmnop",
			"sk-abcdefghijklmnop",
			"sk-proj-abcdefghijklmnop",
		];
		for (const secret of secretForms) {
			expect(sanitizeTerminalText(`value ${secret} end`, [])).toBe("value [REDACTED] end");
		}
		expect(sanitizeTerminalText("value sk-project-alpha end", [])).toBe("value sk-project-alpha end");
	});
});
