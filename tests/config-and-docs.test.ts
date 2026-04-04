import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function loadConfigModule(agentDir: string) {
	vi.resetModules();
	vi.doMock("@mariozechner/pi-coding-agent", () => ({
		getAgentDir: () => agentDir,
	}));
	return import("../config.js");
}

describe("config + docs parity", () => {
	afterEach(() => {
		vi.doUnmock("@mariozechner/pi-coding-agent");
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
				commands: { codex: "/opt/codex/bin/codex" },
				defaultArgs: { codex: ["--no-alt-screen"] },
				worktree: true,
				worktreeBaseDir: "../worktrees",
			},
		}), { encoding: "utf-8" });
		writeFileSync(projectPath, JSON.stringify({
			autoExitGracePeriod: 1,
			overlayHeightPercent: 150,
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
		expect(config.focusShortcut).toBe("alt+shift+f");
		expect(config.spawn.defaultAgent).toBe("claude");
		expect(config.spawn.shortcut).toBe("alt+shift+p");
		expect(config.spawn.commands.codex).toBe("/opt/codex/bin/codex");
		expect(config.spawn.defaultArgs.codex).toEqual(["--no-alt-screen"]);
		expect(config.spawn.defaultArgs.claude).toEqual(["--allowedTools", "Bash"]);
		expect(config.spawn.worktree).toBe(false);
		expect(config.spawn.worktreeBaseDir).toBe("../worktrees");

		rmSync(root, { recursive: true, force: true });
	});

	it("keeps README, SKILL, and tool help defaults aligned with config defaults", async () => {
		const root = mkdtempSync(join(tmpdir(), "interactive-shell-defaults-"));
		const { loadConfig } = await loadConfigModule(root);
		const defaults = loadConfig(join(root, "project"));
		const readme = readFileSync("README.md", "utf-8");
		const skill = readFileSync("SKILL.md", "utf-8");
		const toolSchema = readFileSync("tool-schema.ts", "utf-8");

		expect(defaults.handsFreeQuietThreshold).toBe(8000);
		expect(defaults.autoExitGracePeriod).toBe(15000);
		expect(defaults.focusShortcut).toBe("alt+shift+f");
		expect(defaults.spawn.defaultAgent).toBe("pi");
		expect(defaults.spawn.shortcut).toBe("alt+shift+p");
		expect(readme).toContain(`"focusShortcut": "${defaults.focusShortcut}"`);
		expect(readme).toContain(`"defaultAgent": "${defaults.spawn.defaultAgent}"`);
		expect(readme).toContain(`"shortcut": "${defaults.spawn.shortcut}"`);
		expect(readme).toContain("Toggle focus between overlay and main chat");
		expect(readme).toContain("configured default spawn agent");
		expect(readme).toContain("/spawn codex");
		expect(readme).toContain("--worktree");
		expect(readme).toContain("Alt+Shift+P");
		expect(readme).toContain(`"handsFreeQuietThreshold": ${defaults.handsFreeQuietThreshold}`);
		expect(readme).toContain(`"autoExitGracePeriod": ${defaults.autoExitGracePeriod}`);
		expect(readme).toContain(`Dispatch defaults \`autoExitOnQuiet: true\` — the session gets a 15s startup grace period`);
		expect(skill).toContain("~8s of quiet");
		expect(toolSchema).toContain(`default: ${defaults.handsFreeQuietThreshold}ms`);
		expect(toolSchema).toContain(`default: ${defaults.autoExitGracePeriod}ms`);

		rmSync(root, { recursive: true, force: true });
	});
});
