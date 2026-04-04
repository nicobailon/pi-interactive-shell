import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { InteractiveShellConfig, SpawnAgent } from "./config.js";

export type SpawnMode = "fresh" | "fork";
export type SpawnMonitorMode = "hands-free" | "dispatch";

export interface SpawnRequest {
	agent?: SpawnAgent;
	mode?: SpawnMode;
	worktree?: boolean;
	prompt?: string;
}

export interface ParsedSpawnArgs {
	request: SpawnRequest;
	monitorMode?: SpawnMonitorMode;
}

export interface ResolvedSpawn {
	agent: SpawnAgent;
	mode: SpawnMode;
	command: string;
	cwd: string;
	reason: string;
	worktreePath?: string;
}

export function parseSpawnArgs(args: string):
	| { ok: true; parsed: ParsedSpawnArgs }
	| { ok: false; error: string } {
	const tokenized = tokenizeSpawnArgs(args);
	if (!tokenized.ok) {
		return tokenized;
	}

	let agent: SpawnAgent | undefined;
	let mode: SpawnMode | undefined;
	let monitorMode: SpawnMonitorMode | undefined;
	let worktree = false;
	const promptTokens: string[] = [];

	for (const token of tokenized.tokens) {
		if (!token.quoted && token.value === "--worktree") {
			if (worktree) {
				return { ok: false, error: "Duplicate flag: --worktree" };
			}
			worktree = true;
			continue;
		}
		if (!token.quoted && (token.value === "--hands-free" || token.value === "--dispatch")) {
			const nextMonitorMode = token.value === "--hands-free" ? "hands-free" : "dispatch";
			if (monitorMode) {
				return monitorMode === nextMonitorMode
					? { ok: false, error: `Duplicate flag: ${token.value}` }
					: { ok: false, error: "Cannot combine --hands-free and --dispatch." };
			}
			monitorMode = nextMonitorMode;
			continue;
		}
		if (!token.quoted && (token.value === "pi" || token.value === "codex" || token.value === "claude")) {
			if (agent) {
				return { ok: false, error: `Duplicate spawn agent: ${token.value}` };
			}
			agent = token.value;
			continue;
		}
		if (!token.quoted && (token.value === "fresh" || token.value === "fork")) {
			if (mode) {
				return { ok: false, error: `Duplicate spawn mode: ${token.value}` };
			}
			mode = token.value;
			continue;
		}
		if (!token.quoted && token.value.startsWith("--")) {
			return { ok: false, error: `Unknown /spawn argument: ${token.value}` };
		}
		if (!token.quoted) {
			return { ok: false, error: `Unknown /spawn argument: ${token.value}` };
		}
		promptTokens.push(token.value);
	}

	if (promptTokens.length > 1) {
		return {
			ok: false,
			error: "Prompt text must be quoted as a single argument, for example /spawn claude \"review the diffs\" --dispatch.",
		};
	}

	const prompt = promptTokens[0];
	if (prompt !== undefined && !monitorMode) {
		return {
			ok: false,
			error: "Prompt-bearing /spawn requires --hands-free or --dispatch.",
		};
	}
	if (monitorMode && prompt === undefined) {
		return {
			ok: false,
			error: "Monitored /spawn requires a quoted prompt, for example /spawn claude \"review the diffs\" --dispatch.",
		};
	}

	return {
		ok: true,
		parsed: {
			request: { agent, mode, worktree: worktree || undefined, prompt },
			monitorMode,
		},
	};
}

export function resolveSpawn(
	config: InteractiveShellConfig,
	cwd: string,
	request: SpawnRequest | undefined,
	getSessionFile: () => string | undefined,
):
	| { ok: true; spawn: ResolvedSpawn }
	| { ok: false; error: string } {
	const agent = request?.agent ?? config.spawn.defaultAgent;
	const mode = request?.mode ?? "fresh";
	const worktree = request?.worktree ?? config.spawn.worktree;
	const prompt = request?.prompt?.trim();

	if (request?.prompt !== undefined && !prompt) {
		return { ok: false, error: "Spawn prompt cannot be empty." };
	}

	if (mode === "fork" && agent !== "pi") {
		return { ok: false, error: `Cannot fork ${agent}. Fork is only supported for pi sessions.` };
	}

	let sourceSessionFile: string | undefined;
	if (mode === "fork") {
		sourceSessionFile = getSessionFile();
		if (!sourceSessionFile) {
			return { ok: false, error: "Cannot fork the current session because it is not persisted (likely --no-session mode)." };
		}
	}

	let effectiveCwd = cwd;
	let worktreePath: string | undefined;
	if (worktree) {
		const resolvedWorktree = createSpawnWorktree(config, cwd, agent);
		if (!resolvedWorktree.ok) {
			return resolvedWorktree;
		}
		effectiveCwd = resolvedWorktree.cwd;
		worktreePath = resolvedWorktree.path;
	}

	const executable = config.spawn.commands[agent];
	const args = [...config.spawn.defaultArgs[agent]];
	let reason = `spawn ${agent} (${mode === "fork" ? "fork current session" : "fresh session"})`;

	if (sourceSessionFile) {
		args.push("--fork", sourceSessionFile);
	}
	if (prompt) {
		args.push(prompt);
	}
	if (worktreePath) {
		reason += ` • worktree: ${worktreePath}`;
	}

	return {
		ok: true,
		spawn: {
			agent,
			mode,
			command: buildShellCommand(executable, args),
			cwd: effectiveCwd,
			reason,
			worktreePath,
		},
	};
}

function createSpawnWorktree(
	config: InteractiveShellConfig,
	cwd: string,
	agent: SpawnAgent,
):
	| { ok: true; cwd: string; path: string }
	| { ok: false; error: string } {
	const workingDir = resolve(cwd);
	const repoRoot = runGit(["-C", workingDir, "rev-parse", "--show-toplevel"], workingDir);
	if (!repoRoot.ok) {
		return { ok: false, error: "Cannot create a worktree here because the current directory is not inside a git repository." };
	}

	const baseDir = config.spawn.worktreeBaseDir
		? resolve(repoRoot.stdout, config.spawn.worktreeBaseDir)
		: join(dirname(repoRoot.stdout), `${basename(repoRoot.stdout)}-worktrees`);
	mkdirSync(baseDir, { recursive: true });

	const timestamp = new Date().toISOString().replace(/[-:.]/g, "").replace("T", "-").replace("Z", "");
	const suffix = Math.random().toString(36).slice(2, 7);
	const worktreePath = join(baseDir, `${basename(repoRoot.stdout)}-${agent}-${timestamp}-${suffix}`);
	const addWorktree = runGit(["-C", repoRoot.stdout, "worktree", "add", "--detach", worktreePath, "HEAD"], repoRoot.stdout);
	if (!addWorktree.ok) {
		return { ok: false, error: addWorktree.error };
	}

	const relativeCwd = relative(repoRoot.stdout, workingDir);
	if (relativeCwd.length === 0 || relativeCwd.startsWith("..")) {
		return { ok: true, cwd: worktreePath, path: worktreePath };
	}

	const nestedCwd = join(worktreePath, relativeCwd);
	return {
		ok: true,
		cwd: existsSync(nestedCwd) ? nestedCwd : worktreePath,
		path: worktreePath,
	};
}

function runGit(args: string[], cwd: string):
	| { ok: true; stdout: string }
	| { ok: false; error: string } {
	try {
		return {
			ok: true,
			stdout: execFileSync("git", args, {
				cwd,
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "pipe"],
			}).trim(),
		};
	} catch (error) {
		const stderr = error instanceof Error && "stderr" in error && typeof error.stderr === "string"
			? error.stderr.trim()
			: "";
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, error: stderr ? `${message}\n${stderr}` : message };
	}
}

function buildShellCommand(executable: string, args: string[]): string {
	return [shellQuoteIfNeeded(executable), ...args.map(shellQuoteIfNeeded)].join(" ");
}

function shellQuoteIfNeeded(value: string): string {
	return /^[A-Za-z0-9_./:-]+$/.test(value) ? value : shellQuote(value);
}

function shellQuote(value: string): string {
	if (process.platform === "win32") {
		return `"${value.replace(/"/g, '""')}"`;
	}
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

type ParsedToken = { value: string; quoted: boolean };

function tokenizeSpawnArgs(args: string):
	| { ok: true; tokens: ParsedToken[] }
	| { ok: false; error: string } {
	const tokens: ParsedToken[] = [];
	let current = "";
	let currentQuoted = false;
	let quote: '"' | "'" | null = null;

	for (let i = 0; i < args.length; i++) {
		const char = args[i];
		if (!char) continue;

		if (quote) {
			if (char === quote) {
				quote = null;
				currentQuoted = true;
				continue;
			}
			if (char === "\\" && i + 1 < args.length) {
				current += args[++i] ?? "";
				continue;
			}
			current += char;
			continue;
		}

		if (/\s/.test(char)) {
			if (current.length > 0 || currentQuoted) {
				tokens.push({ value: current, quoted: currentQuoted });
				current = "";
				currentQuoted = false;
			}
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			currentQuoted = true;
			continue;
		}
		if (char === "\\" && i + 1 < args.length) {
			current += args[++i] ?? "";
			continue;
		}
		current += char;
	}

	if (quote) {
		return { ok: false, error: "Unterminated quote in /spawn arguments." };
	}
	if (current.length > 0 || currentQuoted) {
		tokens.push({ value: current, quoted: currentQuoted });
	}

	return { ok: true, tokens };
}
