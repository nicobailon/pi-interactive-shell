import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function loadConfigModule(agentDir: string) {
	vi.resetModules();
	vi.doMock("@earendil-works/pi-coding-agent", () => ({
		getAgentDir: () => agentDir,
	}));
	return import("../config.ts");
}

describe("config + docs parity", () => {
	afterEach(() => {
		vi.doUnmock("@earendil-works/pi-coding-agent");
	});

	it("merges global and project config with clamping", async () => {
		const root = mkdtempSync(join(tmpdir(), "interactive-shell-config-"));
		const project = join(root, "project");
		const agentDir = join(root, "agent");
		const globalPath = join(agentDir, "interactive-shell.json");
		const projectPath = join(project, ".pi", "interactive-shell.json");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(project, ".pi"), { recursive: true });
		writeFileSync(globalPath, JSON.stringify({
			handsFreeQuietThreshold: 999999,
			overlayWidthPercent: 5,
			focusShortcut: "alt+f",
			spawn: {
				defaultAgent: "codex",
				shortcut: "alt+s",
				commands: { codex: "/opt/codex/bin/codex", aider: "aider", fork: "nope", "--bad": "nope" },
				defaultArgs: { codex: ["--no-alt-screen"], aider: ["--yes-always"] },
				worktree: true,
				worktreeBaseDir: "../worktrees",
			},
		}), { encoding: "utf-8" });
		writeFileSync(projectPath, JSON.stringify({
			autoExitGracePeriod: 1,
			overlayHeightPercent: 150,
			overlayAnchor: "top-center",
			focusShortcut: "   ",
			spawn: {
				shortcut: "   ",
				defaultAgent: "claude",
				defaultArgs: { claude: ["--allowedTools", "Bash"] },
				worktree: false,
			},
		}), { encoding: "utf-8" });

		const { loadConfig } = await loadConfigModule(agentDir);
		const config = loadConfig(project);
		expect(config.handsFreeQuietThreshold).toBe(30000);
		expect(config.overlayWidthPercent).toBe(10);
		expect(config.autoExitGracePeriod).toBe(5000);
		expect(config.overlayHeightPercent).toBe(90);
		expect(config.overlayAnchor).toBe("top-center");
		expect(config.focusShortcut).toBe("alt+shift+f");
		expect(config.spawn.defaultAgent).toBe("claude");
		expect(config.spawn.shortcut).toBe("alt+shift+p");
		expect(config.spawn.commands.codex).toBe("/opt/codex/bin/codex");
		expect(config.spawn.commands.cursor).toBe("agent");
		expect(config.spawn.defaultArgs.codex).toEqual(["--no-alt-screen"]);
		expect(config.spawn.defaultArgs.claude).toEqual(["--allowedTools", "Bash"]);
		expect(config.spawn.defaultArgs.cursor).toEqual(["--model", "composer-2-fast"]);
		expect(config.spawn.commands.aider).toBe("aider");
		expect(config.spawn.defaultArgs.aider).toEqual(["--yes-always"]);
		expect(config.spawn.commands.fork).toBeUndefined();
		expect(config.spawn.commands["--bad"]).toBeUndefined();
		expect(config.spawn.worktree).toBe(false);
		expect(config.spawn.worktreeBaseDir).toBe("../worktrees");

		rmSync(root, { recursive: true, force: true });
	});

	it("ignores invalid config roots and non-finite numeric config", async () => {
		const root = mkdtempSync(join(tmpdir(), "interactive-shell-invalid-config-"));
		const project = join(root, "project");
		const agentDir = join(root, "agent");
		const globalPath = join(agentDir, "interactive-shell.json");
		const projectPath = join(project, ".pi", "interactive-shell.json");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(project, ".pi"), { recursive: true });
		writeFileSync(globalPath, "[]", { encoding: "utf-8" });
		writeFileSync(projectPath, '{ "defer": true, "overlayWidthPercent": 1e999, "scrollbackLines": -1e999 }', { encoding: "utf-8" });
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const { loadConfig } = await loadConfigModule(agentDir);
			const config = loadConfig(project);

			expect(config.defer).toBe(true);
			expect(config.overlayWidthPercent).toBe(95);
			expect(config.scrollbackLines).toBe(5000);
			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(`Ignoring ${globalPath}: config root must be an object`));
		} finally {
			errorSpy.mockRestore();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("requires global Jev enablement while allowing project config only to narrow observation", async () => {
		const root = mkdtempSync(join(tmpdir(), "interactive-shell-jev-config-"));
		const project = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(project, ".pi"), { recursive: true });
		writeFileSync(join(project, ".pi", "interactive-shell.json"), JSON.stringify({
			jev: { enabled: true, model: "project-model", maxRecentChars: 700, redactionPatterns: ["PROJECT_SECRET"], diagnostics: { enabled: true, retentionDays: 1 } },
		}));
		const { loadConfig } = await loadConfigModule(agentDir);
		const projectOnly = loadConfig(project);
		expect(projectOnly.jev).toMatchObject({ enabled: false, model: "jev-1.13.0", maxRecentChars: 700, diagnostics: { enabled: false, retentionDays: 14, maxBytes: 20_000_000 } });

		writeFileSync(join(agentDir, "interactive-shell.json"), JSON.stringify({
			jev: { enabled: true, model: "jev-1.13.0", maxRecentChars: 4000, maxRetries: 1, redactionPatterns: ["GLOBAL_SECRET"], diagnostics: { enabled: true, retentionDays: 30, maxBytes: 5_000_000 } },
		}));
		const reloaded = await loadConfigModule(agentDir);
		const enabled = reloaded.loadConfig(project);
		expect(enabled.jev).toMatchObject({ enabled: true, model: "jev-1.13.0", maxRecentChars: 700, maxRetries: 1, diagnostics: { enabled: true, retentionDays: 30, maxBytes: 5_000_000 } });
		expect(enabled.jev?.redactionPatterns).toEqual(["GLOBAL_SECRET", "PROJECT_SECRET"]);
		writeFileSync(join(agentDir, "interactive-shell.json"), JSON.stringify({ jev: { diagnostics: "PRIVATE_DIAGNOSTIC_CONFIG" } }));
		let diagnosticError: unknown;
		try { reloaded.loadConfig(project); } catch (caught) { diagnosticError = caught; }
		expect(diagnosticError).toEqual(new Error("Invalid global Jev diagnostics configuration."));
		expect(String(diagnosticError)).not.toContain("PRIVATE_DIAGNOSTIC_CONFIG");
		rmSync(root, { recursive: true, force: true });
	});

	it("validates bounded RE2 redactions privately and preserves global-first cap ordering", async () => {
		const root = mkdtempSync(join(tmpdir(), "interactive-shell-redactions-"));
		const project = join(root, "project"); const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true }); mkdirSync(join(project, ".pi"), { recursive: true });
		const globalPath = join(agentDir, "interactive-shell.json");
		const projectPath = join(project, ".pi", "interactive-shell.json");
		const { loadConfig } = await loadConfigModule(agentDir);
		for (const scope of ["global", "project"] as const) {
			const target = scope === "global" ? globalPath : projectPath;
			const other = scope === "global" ? projectPath : globalPath;
			writeFileSync(other, JSON.stringify({}));
			writeFileSync(target, JSON.stringify({ jev: { redactionPatterns: { private: "PRIVATE_CONFIG_SENTINEL" } } }));
			let structuralError: unknown;
			try { loadConfig(project); } catch (caught) { structuralError = caught; }
			expect(structuralError).toEqual(new Error(`Invalid ${scope} Jev redaction configuration.`));
			expect(String(structuralError)).not.toContain("PRIVATE_CONFIG_SENTINEL");
			writeFileSync(target, JSON.stringify({ jev: { redactionPatterns: ["valid-sibling", "PRIVATE_CONFIG_SENTINEL", 7] } }));
			let entryError: unknown;
			try { loadConfig(project); } catch (caught) { entryError = caught; }
			expect(entryError).toEqual(new Error(`Invalid ${scope} Jev redaction entry at index 2.`));
			expect(String(entryError)).not.toContain("PRIVATE_CONFIG_SENTINEL");
		}
		writeFileSync(globalPath, JSON.stringify({ jev: { redactionPatterns: [...Array.from({ length: 51 }, (_, index) => `valid-${index}`), false] } }));
		writeFileSync(projectPath, JSON.stringify({}));
		expect(() => loadConfig(project)).toThrow("Invalid global Jev redaction entry at index 51.");
		const invalid = ["", "[", "(a)\\1", "(?=secret)", "(?<=secret)", "(a+)+$", "x".repeat(513)];
		for (const source of invalid) {
			writeFileSync(globalPath, JSON.stringify({ jev: { redactionPatterns: ["ok", source] } }));
			let error: unknown;
			try { loadConfig(project); } catch (caught) { error = caught; }
			expect(error).toEqual(new Error("Invalid global Jev redaction pattern at index 1."));
			if (source) expect(String(error)).not.toContain(source);
		}
		writeFileSync(globalPath, JSON.stringify({ jev: { redactionPatterns: ["global-ok"] } }));
		writeFileSync(projectPath, JSON.stringify({ jev: { redactionPatterns: ["project-ok", "(?=private-project-pattern)"] } }));
		expect(() => loadConfig(project)).toThrow("Invalid project Jev redaction pattern at index 1.");
		writeFileSync(globalPath, JSON.stringify({ jev: { redactionPatterns: Array.from({ length: 49 }, (_, index) => `global-${index}`) } }));
		writeFileSync(projectPath, JSON.stringify({ jev: { redactionPatterns: ["project-0", "project-1", "["] } }));
		const selected = loadConfig(project).jev!.redactionPatterns;
		expect(selected).toHaveLength(50);
		expect(selected.slice(47)).toEqual(["global-47", "global-48", "project-0"]);
		rmSync(root, { recursive: true, force: true });
	});

	it("loads launchPolicy only from trusted global config and rejects malformed or project rules", async () => {
		const root = mkdtempSync(join(tmpdir(), "interactive-shell-permissions-"));
		const project = join(root, "project"); const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true }); mkdirSync(join(project, ".pi"), { recursive: true });
		const globalPath = join(agentDir, "interactive-shell.json"); const projectPath = join(project, ".pi", "interactive-shell.json");
		writeFileSync(globalPath, JSON.stringify({ launchPolicy: [
			{ command: "npm test", decision: "allow" },
			{ command: "deploy", decision: "deny" },
		] }));
		writeFileSync(projectPath, JSON.stringify({}));
		const { loadConfig } = await loadConfigModule(agentDir);
		expect(loadConfig(project).launchPolicy?.evaluate("npm test")).toBe("allow");
		expect(loadConfig(project).launchPolicy?.evaluate("deploy")).toBe("deny");
		writeFileSync(projectPath, JSON.stringify({ launchPolicy: [{ command: "deploy", decision: "allow" }] }));
		expect(() => loadConfig(project)).toThrow("Project config cannot define launchPolicy");
		writeFileSync(projectPath, JSON.stringify({}));
		writeFileSync(globalPath, JSON.stringify({ launchPolicy: [{ command: "npm test", decision: "maybe" }] }));
		expect(() => loadConfig(project)).toThrow("Invalid global launchPolicy");
		rmSync(root, { recursive: true, force: true });
	});

	it("keeps README, SKILL, and tool help defaults aligned with config defaults", async () => {
		const root = mkdtempSync(join(tmpdir(), "interactive-shell-defaults-"));
		const { loadConfig } = await loadConfigModule(root);
		const defaults = loadConfig(join(root, "project"));
		const readme = readFileSync("README.md", "utf-8");
		const skill = readFileSync("skills/pi-interactive-shell/SKILL.md", "utf-8");
		const toolSchema = readFileSync("tool-schema.ts", "utf-8");

		expect(defaults.defer).toBe(false);
		expect(defaults.launchPolicy).toBeUndefined();
		expect(defaults.handsFreeQuietThreshold).toBe(8000);
		expect(defaults.autoExitGracePeriod).toBe(15000);
		expect(defaults.overlayAnchor).toBe("center");
		expect(readme).toContain(`"defer": ${defaults.defer}`);
		expect(readme).toContain("enable_interactive_shell");
		expect(readme).toContain(`"overlayAnchor": "${defaults.overlayAnchor}"`);
		expect(defaults.focusShortcut).toBe("alt+shift+f");
		expect(defaults.spawn.defaultAgent).toBe("pi");
		expect(defaults.spawn.shortcut).toBe("alt+shift+p");
		expect(defaults.spawn.defaultArgs.cursor).toEqual(["--model", "composer-2-fast"]);
		expect(readme).toContain(`"focusShortcut": "${defaults.focusShortcut}"`);
		expect(readme).toContain(`"defaultAgent": "${defaults.spawn.defaultAgent}"`);
		expect(readme).toContain(`"shortcut": "${defaults.spawn.shortcut}"`);
		expect(readme).toContain("Toggle focus between overlay and main chat");
		expect(readme).toContain("configured default spawn agent");
		expect(readme).toContain("/spawn codex");
		expect(readme).toContain("/spawn cursor");
		expect(readme).toContain('/spawn claude "review the diffs" --dispatch');
		expect(readme).toContain('spawn: { agent: "cursor", prompt: "Review the diffs" }');
		expect(readme).toContain('spawn: { agent: "claude", prompt: "Review the diffs" }');
		expect(readme).toContain("--worktree");
		expect(readme).toContain("Ctrl+G");
		expect(readme).toContain("only after taking over a monitored hands-free or dispatch session");
		expect(readme).toContain('"cursor": "agent"');
		expect(readme).toContain('"cursor": ["--model", "composer-2-fast"]');
		expect(readme).toContain("Alt+Shift+P");
		expect(readme).toContain(`"handsFreeQuietThreshold": ${defaults.handsFreeQuietThreshold}`);
		expect(readme).toContain(`"autoExitGracePeriod": ${defaults.autoExitGracePeriod}`);
		expect(readme).toContain(`Dispatch defaults \`autoExitOnQuiet: true\` — the session gets a 15s startup grace period`);
		expect(readme).toContain("same Bash resolver as Pi");
		expect(readme).toContain("Pi discovers Git Bash in its standard install");
		expect(readme).toContain("locations, then `bash.exe` on `PATH`");
		expect(readme).toContain('"shellPath": "C:/Program Files/Git/bin/bash.exe"');
		expect(readme).toContain("trusted project's `shellPath`");
		expect(readme).toContain("overrides the global setting");
		expect(readme).toContain("legacy WSL `bash.exe` uses");
		expect(readme).toContain("stdin-only command transport");
		expect(readme).toContain('completionReason: "auto-close-quiet"');
		expect(readme).toContain("this is not a terminal command verdict.");
		expect(readme).toContain("provider-agnostic watch-until-terminal pattern");
		expect(skill).toContain("enable_interactive_shell");
		expect(skill).toContain("reloaded, new, resumed, and forked sessions reset it to inactive");
		expect(skill).toContain('completionReason: "auto-close-quiet"');
		expect(skill).toContain("provider-agnostic external gate watcher");
		expect(toolSchema).toContain('completionReason: "auto-close-quiet"');
		expect(toolSchema).toContain('Dispatch completion notifications set completionReason: "auto-close-quiet" when quiet auto-close cancels local supervision and attempts termination; this is not a command-completion verdict and subprocess exit is not confirmed.');
		expect(toolSchema).toContain("Cancel the session locally and attempt termination (requires sessionId); subprocess exit is not confirmed.");
		expect(toolSchema).toContain("Running sessions are cancelled locally and termination is attempted; subprocess exit is not confirmed.");
		expect(toolSchema).toContain("Startup grace period before autoExitOnQuiet cancels local supervision and attempts termination; subprocess exit is not confirmed");
		expect(toolSchema).toContain("Auto-cancel local session supervision and attempt termination when output stops (after quietThreshold); subprocess exit is not confirmed.");
		expect(toolSchema).toContain("Cancel local supervision after N milliseconds and attempt termination; subprocess exit is not confirmed.");
		expect(readme).toContain('submit: true');
		expect(readme).toContain('raw `input` only types text. It does not submit the prompt.');
		expect(skill).toContain("~8s of quiet");
		expect(skill).toContain('submit: true');
		expect(skill).toContain('raw `input` only types text. It does not submit the prompt.');
		expect(toolSchema).toContain(`default: ${defaults.handsFreeQuietThreshold}ms`);
		expect(toolSchema).toContain('submit=true');
		expect(toolSchema).toContain("or any custom key configured by the user");
		expect(toolSchema).toContain('This only types the text; it does not submit it.');
		expect(toolSchema).toContain(`default: ${defaults.autoExitGracePeriod}ms`);

		rmSync(root, { recursive: true, force: true });
	});

	it("packages the semantic runtime, corpus evaluator, command, and accurate key-free documentation", () => {
		const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as { files: string[]; scripts: Record<string, string>; dependencies: Record<string, string> };
		for (const asset of ["jev-client.ts", "terminal-observation.ts", "semantic-supervisor.ts", "semantic-events.ts", "semantic-actions.ts", "launch-policy.ts", "semantic-corpus.ts", "semantic-evaluator.ts", "semantic-diagnostics.ts", "scripts/evaluate-jev.ts"]) {
			expect(pkg.files).toContain(asset);
		}
		expect(pkg.scripts["eval:jev"]).toBe("node --experimental-strip-types scripts/evaluate-jev.ts");
		expect(pkg.dependencies.re2js).toBe("2.8.6");
		const lock = JSON.parse(readFileSync("package-lock.json", "utf-8")) as { packages: Record<string, { version?: string }> };
		expect(lock.packages["node_modules/re2js"]?.version).toBe("2.8.6");
		const readme = readFileSync("README.md", "utf-8");
		const skill = readFileSync("skills/pi-interactive-shell/SKILL.md", "utf-8");
		for (const docs of [readme, skill]) {
			expect(docs).toMatch(/optional/i);
			expect(docs).toContain("off by default");
			expect(docs).toContain("TYPESAFE_API_KEY");
			expect(docs).toContain("never");
			expect(docs).toContain("https://docs.typesafe.ai/models");
			expect(docs).toContain("https://docs.typesafe.ai/legal");
			expect(docs).toContain("https://typesafe.ai/legal/privacy-policy");
			expect(docs).toContain("npm run eval:jev");
			expect(docs).toContain("RE2-compatible");
			expect(docs).not.toMatch(/"(?:apiKey|TYPESAFE_API_KEY)"\s*:/);
		}
		expect(readme).toContain("customer requests/responses are not used to train Jev");
		expect(readme).toContain("do not assume default zero retention");
		expect(readme).toContain("Example global opt-in (the default is `false`):");
		expect(skill).toContain("Enterprise ZDR is a separate");
	});
});
