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
		const globalPath = join(agentDir, "interactive-kitty.json");
		const projectPath = join(project, ".pi", "interactive-kitty.json");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(project, ".pi"), { recursive: true });
		writeFileSync(
			globalPath,
			JSON.stringify({
				handsFreeQuietThreshold: 999999,
				focusShortcut: "alt+f",
				spawn: {
					defaultAgent: "codex",
					shortcut: "alt+s",
					commands: { codex: "/opt/codex/bin/codex" },
					defaultArgs: { codex: ["--no-alt-screen"] },
					worktree: true,
					worktreeBaseDir: "../worktrees",
				},
			}),
			{ encoding: "utf-8" },
		);
		writeFileSync(
			projectPath,
			JSON.stringify({
				autoExitGracePeriod: 1,
				focusShortcut: "   ",
				spawn: {
					shortcut: "   ",
					defaultAgent: "claude",
					defaultArgs: { claude: ["--allowedTools", "Bash"] },
					worktree: false,
				},
			}),
			{ encoding: "utf-8" },
		);

		const { loadConfig } = await loadConfigModule(agentDir);
		const config = loadConfig(project);
		expect(config.handsFreeQuietThreshold).toBe(30000);
		expect(config.autoExitGracePeriod).toBe(5000);
		expect(config.focusShortcut).toBe("alt+shift+f");
		expect(config.spawn.defaultAgent).toBe("claude");
		expect(config.spawn.shortcut).toBe("alt+shift+p");
		expect(config.spawn.commands.codex).toBe("/opt/codex/bin/codex");
		expect(config.spawn.commands.cursor).toBe("agent");
		expect(config.spawn.defaultArgs.codex).toEqual(["--no-alt-screen"]);
		expect(config.spawn.defaultArgs.claude).toEqual(["--allowedTools", "Bash"]);
		expect(config.spawn.defaultArgs.cursor).toEqual(["--model", "composer-2-fast"]);
		expect(config.spawn.worktree).toBe(false);
		expect(config.spawn.worktreeBaseDir).toBe("../worktrees");

		rmSync(root, { recursive: true, force: true });
	});

	it("keeps README, SKILL, and tool help defaults aligned with config defaults", async () => {
		const root = mkdtempSync(join(tmpdir(), "interactive-shell-defaults-"));
		const { loadConfig } = await loadConfigModule(root);
		const defaults = loadConfig(join(root, "project"));
		const readme = readFileSync("README.md", "utf-8");
		const skill = readFileSync("skills/pi-interactive-kitty/SKILL.md", "utf-8");
		const toolSchema = readFileSync("tool-schema.ts", "utf-8");

		expect(defaults.handsFreeQuietThreshold).toBe(8000);
		expect(defaults.autoExitGracePeriod).toBe(15000);
		expect(defaults.focusShortcut).toBe("alt+shift+f");
		expect(defaults.spawn.defaultAgent).toBe("pi");
		expect(defaults.spawn.shortcut).toBe("alt+shift+p");
		expect(defaults.spawn.defaultArgs.cursor).toEqual(["--model", "composer-2-fast"]);
		expect(defaults.kitty.tabTitlePrefix).toBe("pi-shell");
		expect(defaults.kitty.osWindowTitle).toBe("Pi Interactive Kitty");
		expect(readme).toContain(`"focusShortcut": "${defaults.focusShortcut}"`);
		expect(readme).toContain(`"tabTitlePrefix": "${defaults.kitty.tabTitlePrefix}"`);
		expect(readme).toContain(`"osWindowTitle": "${defaults.kitty.osWindowTitle}"`);
		expect(readme).toContain(`"defaultAgent": "${defaults.spawn.defaultAgent}"`);
		expect(readme).toContain(`"shortcut": "${defaults.spawn.shortcut}"`);
		expect(readme).toContain("Focus the latest managed kitty session");
		expect(readme).toContain("configured default spawn agent");
		expect(readme).toContain("/spawn codex");
		expect(readme).toContain("/spawn cursor");
		expect(readme).toContain('/spawn claude "review the diffs" --dispatch');
		expect(readme).toContain('spawn: { agent: "cursor", prompt: "Review the diffs" }');
		expect(readme).toContain('spawn: { agent: "claude", prompt: "Review the diffs" }');
		expect(readme).toContain("--worktree");
		expect(readme).toContain("Focus the latest managed kitty session");
		expect(readme).toContain('"cursor": "agent"');
		expect(readme).toContain('"cursor": ["--model", "composer-2-fast"]');
		expect(readme).toContain("Alt+Shift+P");
		expect(readme).toContain(`"handsFreeQuietThreshold": ${defaults.handsFreeQuietThreshold}`);
		expect(readme).toContain(`"autoExitGracePeriod": ${defaults.autoExitGracePeriod}`);
		expect(readme).toContain(`Dispatch defaults \`autoExitOnQuiet: true\` — the session gets a 15s startup grace period`);
		expect(readme).toContain("submit: true");
		expect(readme).toContain("raw `input` only types text. It does not submit the prompt.");
		expect(skill).toContain("~8s of quiet");
		expect(skill).toContain("submit: true");
		expect(skill).toContain("raw `input` only types text. It does not submit the prompt.");
		expect(toolSchema).toContain(`default: ${defaults.handsFreeQuietThreshold}ms`);
		expect(toolSchema).toContain("submit: true");
		expect(toolSchema).toContain('Type.Literal("cursor")');
		expect(toolSchema).toContain("Structured \\`spawn\\` also supports a \\`prompt\\` field for Pi, Codex, Claude, and Cursor");
		expect(toolSchema).toContain("This only types the text; it does not submit it.");
		expect(toolSchema).toContain(`default: ${defaults.autoExitGracePeriod}ms`);

		rmSync(root, { recursive: true, force: true });
	});
});
