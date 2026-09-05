import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InteractiveShellConfig } from "../config.ts";

const config: InteractiveShellConfig = {
	defer: false,
	exitAutoCloseDelay: 10,
	overlayWidthPercent: 95,
	overlayHeightPercent: 60,
	overlayAnchor: "center",
	focusShortcut: "alt+shift+f",
	spawn: {
		defaultAgent: "pi",
		shortcut: "alt+shift+p",
		commands: { pi: "pi", codex: "codex", claude: "claude", cursor: "agent" },
		defaultArgs: { pi: [], codex: ["-c", 'model_reasoning_effort="high"'], claude: [], cursor: ["--model", "composer-2-fast"] },
		worktree: false,
		worktreeBaseDir: "/tmp/worktrees",
	},
	scrollbackLines: 5000,
	ansiReemit: true,
	handoffPreviewEnabled: true,
	handoffPreviewLines: 30,
	handoffPreviewMaxChars: 2000,
	handoffSnapshotEnabled: false,
	handoffSnapshotLines: 200,
	handoffSnapshotMaxChars: 12000,
	transferLines: 200,
	transferMaxChars: 20000,
	completionNotifyLines: 50,
	completionNotifyMaxChars: 5000,
	handsFreeUpdateMode: "on-quiet",
	handsFreeUpdateInterval: 60000,
	handsFreeQuietThreshold: 8000,
	autoExitGracePeriod: 15000,
	handsFreeUpdateMaxChars: 1500,
	handsFreeMaxTotalChars: 100000,
	minQueryIntervalSeconds: 60,
};

const AGENTS = ["pi", "codex", "claude", "cursor"];

describe("spawn helpers", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it("parses canonical agent tokens, mode, worktree flag, prompt, and monitor mode", async () => {
		const { parseSpawnArgs } = await import("../spawn.ts");
		expect(parseSpawnArgs('claude "review the diffs" --dispatch', AGENTS)).toEqual({
			ok: true,
			parsed: {
				request: { agent: "claude", prompt: "review the diffs" },
				monitorMode: "dispatch",
			},
		});
		expect(parseSpawnArgs("codex fork --worktree", AGENTS)).toEqual({
			ok: true,
			parsed: {
				request: { agent: "codex", mode: "fork", worktree: true },
			},
		});
		expect(parseSpawnArgs('cursor "review the diffs" --dispatch', AGENTS)).toEqual({
			ok: true,
			parsed: {
				request: { agent: "cursor", prompt: "review the diffs" },
				monitorMode: "dispatch",
			},
		});
		expect(parseSpawnArgs('"fix the failing tests" --hands-free', AGENTS)).toEqual({
			ok: true,
			parsed: {
				request: { prompt: "fix the failing tests" },
				monitorMode: "hands-free",
			},
		});
	});

	it("rejects invalid prompt-bearing combinations and unknown tokens", async () => {
		const { parseSpawnArgs } = await import("../spawn.ts");
		expect(parseSpawnArgs("claude-code", AGENTS)).toEqual({
			ok: false,
			error: "Unknown /spawn argument: claude-code",
		});
		expect(parseSpawnArgs('claude "review the diffs"', AGENTS)).toEqual({
			ok: false,
			error: "Prompt-bearing /spawn requires --hands-free or --dispatch.",
		});
		expect(parseSpawnArgs("claude --dispatch", AGENTS)).toEqual({
			ok: false,
			error: "Monitored /spawn requires a quoted prompt, for example /spawn claude \"review the diffs\" --dispatch.",
		});
		expect(parseSpawnArgs("claude review the diffs --dispatch", AGENTS)).toEqual({
			ok: false,
			error: "Unknown /spawn argument: review",
		});
		expect(parseSpawnArgs('claude "review" --dispatch --hands-free', AGENTS)).toEqual({
			ok: false,
			error: "Cannot combine --hands-free and --dispatch.",
		});
	});

	it("accepts custom configured agents and resolves them through their command mapping", async () => {
		const { parseSpawnArgs, resolveSpawn } = await import("../spawn.ts");
		expect(parseSpawnArgs("aider --worktree", [...AGENTS, "aider"])).toEqual({
			ok: true,
			parsed: {
				request: { agent: "aider", worktree: true },
			},
		});
		expect(resolveSpawn({
			...config,
			spawn: {
				...config.spawn,
				commands: { ...config.spawn.commands, aider: "aider" },
				defaultArgs: { ...config.spawn.defaultArgs, aider: ["--yes-always"] },
			},
		}, "/tmp/project", { agent: "aider", prompt: "fix the build" }, () => undefined)).toEqual({
			ok: true,
			spawn: {
				agent: "aider",
				mode: "fresh",
				command: "aider --yes-always 'fix the build'",
				cwd: "/tmp/project",
				reason: "spawn aider (fresh session)",
			},
		});
	});

	it("rejects agents that are not configured, listing the configured ones", async () => {
		const { resolveSpawn } = await import("../spawn.ts");
		expect(resolveSpawn(config, "/tmp/project", { agent: "aider" }, () => undefined)).toEqual({
			ok: false,
			error: "Unknown spawn agent: aider. Configured agents: claude, codex, cursor, pi.",
		});
		// Object.prototype member names must not resolve as configured agents.
		expect(resolveSpawn(config, "/tmp/project", { agent: "constructor" }, () => undefined)).toEqual({
			ok: false,
			error: "Unknown spawn agent: constructor. Configured agents: claude, codex, cursor, pi.",
		});
	});

	it("resolves the configured default agent and default args", async () => {
		const { resolveSpawn } = await import("../spawn.ts");
		const result = resolveSpawn({
			...config,
			spawn: { ...config.spawn, defaultAgent: "codex" },
		}, "/tmp/project", undefined, () => "/tmp/project/session.jsonl");
		expect(result).toEqual({
			ok: true,
			spawn: {
				agent: "codex",
				mode: "fresh",
				command: "codex -c 'model_reasoning_effort=\"high\"'",
				cwd: "/tmp/project",
				reason: "spawn codex (fresh session)",
			},
		});
	});

	it("appends prompt text using each CLI's native startup form", async () => {
		const { resolveSpawn } = await import("../spawn.ts");
		expect(resolveSpawn(config, "/tmp/project", { agent: "claude", prompt: "review the diffs" }, () => "/tmp/project/session.jsonl")).toEqual({
			ok: true,
			spawn: {
				agent: "claude",
				mode: "fresh",
				command: "claude 'review the diffs'",
				cwd: "/tmp/project",
				reason: "spawn claude (fresh session)",
			},
		});
		expect(resolveSpawn(config, "/tmp/project", { agent: "cursor", prompt: "review the diffs" }, () => "/tmp/project/session.jsonl")).toEqual({
			ok: true,
			spawn: {
				agent: "cursor",
				mode: "fresh",
				command: "agent --model composer-2-fast 'review the diffs'",
				cwd: "/tmp/project",
				reason: "spawn cursor (fresh session)",
			},
		});
		expect(resolveSpawn(config, "/tmp/project", { agent: "pi", mode: "fork", prompt: "continue from here" }, () => "/tmp/project/session.jsonl")).toEqual({
			ok: true,
			spawn: {
				agent: "pi",
				mode: "fork",
				command: "pi --fork /tmp/project/session.jsonl 'continue from here'",
				cwd: "/tmp/project",
				reason: "spawn pi (fork current session)",
			},
		});
	});

	it("preserves Bash-sensitive prompt contents as a literal argument", async () => {
		const { resolveSpawn } = await import("../spawn.ts");
		const prompt = "literal $HOME `pwd` and it's";
		const result = resolveSpawn(config, "/tmp/project", { agent: "claude", prompt }, () => "/tmp/project/session.jsonl");

		expect(result).toEqual({
			ok: true,
			spawn: {
				agent: "claude",
				mode: "fresh",
				command: "claude 'literal $HOME `pwd` and it'\\''s'",
				cwd: "/tmp/project",
				reason: "spawn claude (fresh session)",
			},
		});
	});

	it("normalizes serialized spawn fields without erasing standalone requests", async () => {
		const { isEmptySpawnPlaceholder, normalizeSpawnRequest } = await import("../spawn.ts");
		expect(normalizeSpawnRequest(undefined)).toBeUndefined();
		expect(normalizeSpawnRequest({})).toEqual({});
		expect(normalizeSpawnRequest({ agent: "", mode: "fresh", worktree: false, prompt: "" })).toEqual({ worktree: false });
		expect(normalizeSpawnRequest({ agent: "  ", mode: "fresh", worktree: false, prompt: " \t " })).toEqual({ worktree: false });
		expect(normalizeSpawnRequest({ agent: "codex", mode: "fresh", worktree: false, prompt: "" })).toEqual({ agent: "codex", worktree: false });
		expect(normalizeSpawnRequest({ agent: "", mode: "fresh", worktree: false, prompt: "review diffs" })).toEqual({ worktree: false, prompt: "review diffs" });

		expect(isEmptySpawnPlaceholder({ agent: "", mode: "fresh", worktree: false, prompt: "" })).toBe(true);
		expect(isEmptySpawnPlaceholder({})).toBe(true);
		expect(isEmptySpawnPlaceholder({ worktree: false })).toBe(true);
		expect(isEmptySpawnPlaceholder({ agent: "pi", mode: "fresh", worktree: false, prompt: "" })).toBe(false);
		expect(isEmptySpawnPlaceholder({ worktree: true })).toBe(false);
		expect(isEmptySpawnPlaceholder({ prompt: "review diffs" })).toBe(false);
	});

	it("rejects empty structured spawn prompts", async () => {
		const { resolveSpawn } = await import("../spawn.ts");
		expect(resolveSpawn(config, "/tmp/project", { agent: "codex", prompt: "   " }, () => "/tmp/project/session.jsonl")).toEqual({
			ok: false,
			error: "Spawn prompt cannot be empty.",
		});
	});

	it("keeps fork pi-only", async () => {
		const { resolveSpawn } = await import("../spawn.ts");
		expect(resolveSpawn(config, "/tmp/project", { agent: "claude", mode: "fork" }, () => "/tmp/project/session.jsonl")).toEqual({
			ok: false,
			error: "Cannot fork claude. Fork is only supported for pi sessions.",
		});
	});

	it("fails fork before creating a worktree when no session file is available", async () => {
		const execFileSync = vi.fn();
		vi.doMock("node:child_process", () => ({ execFileSync }));
		const { resolveSpawn } = await import("../spawn.ts");
		expect(resolveSpawn({
			...config,
			spawn: { ...config.spawn, worktree: true },
		}, "/tmp/repo", { agent: "pi", mode: "fork", worktree: true }, () => undefined)).toEqual({
			ok: false,
			error: "Cannot fork the current session because it is not persisted (likely --no-session mode).",
		});
		expect(execFileSync).not.toHaveBeenCalled();
	});

	it("creates a detached worktree when requested", async () => {
		const execFileSync = vi.fn((command: string, args: string[]) => {
			expect(command).toBe("git");
			if (args.includes("rev-parse")) {
				return "/tmp/repo\n";
			}
			if (args.includes("worktree")) {
				return "Preparing worktree\n";
			}
			throw new Error("unexpected git invocation");
		});
		vi.doMock("node:child_process", () => ({ execFileSync }));
		vi.doMock("node:fs", async () => {
			const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
			return { ...actual, existsSync: vi.fn(() => true), mkdirSync: vi.fn() };
		});
		const { resolveSpawn } = await import("../spawn.ts");
		const result = resolveSpawn(config, "/tmp/repo/packages/app", { agent: "codex", worktree: true }, () => "/tmp/repo/session.jsonl");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.spawn.cwd).toContain("/tmp/worktrees/repo-codex-");
		expect(result.spawn.cwd).toContain("/packages/app");
		expect(result.spawn.reason).toContain("worktree:");
		expect(execFileSync).toHaveBeenCalledTimes(2);
	});

	it("returns resolver error shape when worktree base directory creation fails", async () => {
		const execFileSync = vi.fn((command: string, args: string[]) => {
			expect(command).toBe("git");
			if (args.includes("rev-parse")) {
				return "/tmp/repo\n";
			}
			throw new Error("unexpected git invocation");
		});
		vi.doMock("node:child_process", () => ({ execFileSync }));
		vi.doMock("node:fs", async () => {
			const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
			return {
				...actual,
				existsSync: vi.fn(() => true),
				mkdirSync: vi.fn(() => { throw new Error("EACCES: permission denied, mkdir '/tmp/worktrees'"); }),
			};
		});
		const { resolveSpawn } = await import("../spawn.ts");
		expect(resolveSpawn(config, "/tmp/repo/packages/app", { agent: "codex", worktree: true }, () => "/tmp/repo/session.jsonl")).toEqual({
			ok: false,
			error: "Failed to create worktree base directory: EACCES: permission denied, mkdir '/tmp/worktrees'",
		});
		expect(execFileSync).toHaveBeenCalledTimes(1);
	});
});
