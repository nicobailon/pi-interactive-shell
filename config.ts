import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

export type SpawnAgent = "pi" | "codex" | "claude" | "agent";

export interface SpawnConfig {
	defaultAgent: SpawnAgent;
	shortcut: string;
	commands: Record<SpawnAgent, string>;
	defaultArgs: Record<SpawnAgent, string[]>;
	worktree: boolean;
	worktreeBaseDir?: string;
}

export interface InteractiveShellConfig {
	exitAutoCloseDelay: number;
	overlayWidthPercent: number;
	overlayHeightPercent: number;
	focusShortcut: string;
	spawn: SpawnConfig;
	scrollbackLines: number;
	ansiReemit: boolean;
	handoffPreviewEnabled: boolean;
	handoffPreviewLines: number;
	handoffPreviewMaxChars: number;
	handoffSnapshotEnabled: boolean;
	handoffSnapshotLines: number;
	handoffSnapshotMaxChars: number;
	transferLines: number;
	transferMaxChars: number;
	completionNotifyLines: number;
	completionNotifyMaxChars: number;
	handsFreeUpdateMode: "on-quiet" | "interval";
	handsFreeUpdateInterval: number;
	handsFreeQuietThreshold: number;
	autoExitGracePeriod: number;
	handsFreeUpdateMaxChars: number;
	handsFreeMaxTotalChars: number;
	minQueryIntervalSeconds: number;
}

const DEFAULT_SPAWN_CONFIG: SpawnConfig = {
	defaultAgent: "pi",
	shortcut: "alt+shift+p",
	commands: {
		pi: "pi",
		codex: "codex",
		claude: "claude",
		agent: "agent",
	},
	defaultArgs: {
		pi: [],
		codex: [],
		claude: [],
		agent: [],
	},
	worktree: false,
	worktreeBaseDir: undefined,
};

const DEFAULT_CONFIG: InteractiveShellConfig = {
	exitAutoCloseDelay: 10,
	overlayWidthPercent: 95,
	overlayHeightPercent: 60,
	focusShortcut: "alt+shift+f",
	spawn: DEFAULT_SPAWN_CONFIG,
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

export function loadConfig(cwd: string): InteractiveShellConfig {
	const projectPath = join(cwd, ".pi", "interactive-shell.json");
	const globalPath = join(getAgentDir(), "interactive-shell.json");

	let globalConfig: Partial<InteractiveShellConfig> = {};
	let projectConfig: Partial<InteractiveShellConfig> = {};

	if (existsSync(globalPath)) {
		try {
			globalConfig = JSON.parse(readFileSync(globalPath, "utf-8"));
		} catch (error) {
			console.error(`Warning: Could not parse ${globalPath}:`, error);
		}
	}

	if (existsSync(projectPath)) {
		try {
			projectConfig = JSON.parse(readFileSync(projectPath, "utf-8"));
		} catch (error) {
			console.error(`Warning: Could not parse ${projectPath}:`, error);
		}
	}

	const mergedSpawn = mergeSpawnConfig(globalConfig.spawn, projectConfig.spawn);
	const merged = { ...DEFAULT_CONFIG, ...globalConfig, ...projectConfig, spawn: mergedSpawn };

	return {
		...merged,
		exitAutoCloseDelay: clampInt(merged.exitAutoCloseDelay, DEFAULT_CONFIG.exitAutoCloseDelay, 0, 60),
		overlayWidthPercent: clampPercent(merged.overlayWidthPercent, DEFAULT_CONFIG.overlayWidthPercent),
		overlayHeightPercent: clampInt(merged.overlayHeightPercent, DEFAULT_CONFIG.overlayHeightPercent, 20, 90),
		focusShortcut: resolveShortcut(merged.focusShortcut, DEFAULT_CONFIG.focusShortcut),
		spawn: mergedSpawn,
		scrollbackLines: clampInt(merged.scrollbackLines, DEFAULT_CONFIG.scrollbackLines, 200, 50000),
		ansiReemit: merged.ansiReemit !== false,
		handoffPreviewEnabled: merged.handoffPreviewEnabled !== false,
		handoffPreviewLines: clampInt(merged.handoffPreviewLines, DEFAULT_CONFIG.handoffPreviewLines, 0, 500),
		handoffPreviewMaxChars: clampInt(
			merged.handoffPreviewMaxChars,
			DEFAULT_CONFIG.handoffPreviewMaxChars,
			0,
			50000,
		),
		handoffSnapshotEnabled: merged.handoffSnapshotEnabled === true,
		handoffSnapshotLines: clampInt(merged.handoffSnapshotLines, DEFAULT_CONFIG.handoffSnapshotLines, 0, 5000),
		handoffSnapshotMaxChars: clampInt(
			merged.handoffSnapshotMaxChars,
			DEFAULT_CONFIG.handoffSnapshotMaxChars,
			0,
			200000,
		),
		transferLines: clampInt(merged.transferLines, DEFAULT_CONFIG.transferLines, 10, 1000),
		transferMaxChars: clampInt(merged.transferMaxChars, DEFAULT_CONFIG.transferMaxChars, 1000, 100000),
		completionNotifyLines: clampInt(merged.completionNotifyLines, DEFAULT_CONFIG.completionNotifyLines, 10, 500),
		completionNotifyMaxChars: clampInt(merged.completionNotifyMaxChars, DEFAULT_CONFIG.completionNotifyMaxChars, 1000, 50000),
		handsFreeUpdateMode: merged.handsFreeUpdateMode === "interval" ? "interval" : "on-quiet",
		handsFreeUpdateInterval: clampInt(
			merged.handsFreeUpdateInterval,
			DEFAULT_CONFIG.handsFreeUpdateInterval,
			5000,
			300000,
		),
		handsFreeQuietThreshold: clampInt(
			merged.handsFreeQuietThreshold,
			DEFAULT_CONFIG.handsFreeQuietThreshold,
			1000,
			30000,
		),
		autoExitGracePeriod: clampInt(
			merged.autoExitGracePeriod,
			DEFAULT_CONFIG.autoExitGracePeriod,
			5000,
			120000,
		),
		handsFreeUpdateMaxChars: clampInt(
			merged.handsFreeUpdateMaxChars,
			DEFAULT_CONFIG.handsFreeUpdateMaxChars,
			500,
			50000,
		),
		handsFreeMaxTotalChars: clampInt(
			merged.handsFreeMaxTotalChars,
			DEFAULT_CONFIG.handsFreeMaxTotalChars,
			10000,
			1000000,
		),
		minQueryIntervalSeconds: clampInt(
			merged.minQueryIntervalSeconds,
			DEFAULT_CONFIG.minQueryIntervalSeconds,
			5,
			300,
		),
	};
}

function mergeSpawnConfig(globalValue: unknown, projectValue: unknown): SpawnConfig {
	const globalSpawn = isPlainObject(globalValue) ? globalValue : undefined;
	const projectSpawn = isPlainObject(projectValue) ? projectValue : undefined;
	const globalCommands = isPlainObject(globalSpawn?.commands) ? globalSpawn.commands : undefined;
	const projectCommands = isPlainObject(projectSpawn?.commands) ? projectSpawn.commands : undefined;
	const globalArgs = isPlainObject(globalSpawn?.defaultArgs) ? globalSpawn.defaultArgs : undefined;
	const projectArgs = isPlainObject(projectSpawn?.defaultArgs) ? projectSpawn.defaultArgs : undefined;

	const mergedCommands = {
		pi: resolveCommand(projectCommands?.pi ?? globalCommands?.pi, DEFAULT_SPAWN_CONFIG.commands.pi),
		codex: resolveCommand(projectCommands?.codex ?? globalCommands?.codex, DEFAULT_SPAWN_CONFIG.commands.codex),
		claude: resolveCommand(projectCommands?.claude ?? globalCommands?.claude, DEFAULT_SPAWN_CONFIG.commands.claude),
		agent: resolveCommand(projectCommands?.agent ?? globalCommands?.agent, DEFAULT_SPAWN_CONFIG.commands.agent),
	};

	const mergedDefaultArgs = {
		pi: resolveStringArray(projectArgs?.pi ?? globalArgs?.pi, DEFAULT_SPAWN_CONFIG.defaultArgs.pi),
		codex: resolveStringArray(projectArgs?.codex ?? globalArgs?.codex, DEFAULT_SPAWN_CONFIG.defaultArgs.codex),
		claude: resolveStringArray(projectArgs?.claude ?? globalArgs?.claude, DEFAULT_SPAWN_CONFIG.defaultArgs.claude),
		agent: resolveStringArray(projectArgs?.agent ?? globalArgs?.agent, DEFAULT_SPAWN_CONFIG.defaultArgs.agent),
	};

	return {
		defaultAgent: resolveSpawnAgent(projectSpawn?.defaultAgent ?? globalSpawn?.defaultAgent, DEFAULT_SPAWN_CONFIG.defaultAgent),
		shortcut: resolveShortcut(projectSpawn?.shortcut ?? globalSpawn?.shortcut, DEFAULT_SPAWN_CONFIG.shortcut),
		commands: mergedCommands,
		defaultArgs: mergedDefaultArgs,
		worktree: resolveBoolean(projectSpawn?.worktree ?? globalSpawn?.worktree, DEFAULT_SPAWN_CONFIG.worktree),
		worktreeBaseDir: resolveOptionalString(projectSpawn?.worktreeBaseDir ?? globalSpawn?.worktreeBaseDir),
	};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveSpawnAgent(value: unknown, fallback: SpawnAgent): SpawnAgent {
	return value === "pi" || value === "codex" || value === "claude" || value === "agent" ? value : fallback;
}

function resolveCommand(value: unknown, fallback: string): string {
	return resolveShortcut(typeof value === "string" ? value : undefined, fallback);
}

function resolveStringArray(value: unknown, fallback: string[]): string[] {
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return fallback;
	return value;
}

function resolveBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function resolveOptionalString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function clampPercent(value: number | undefined, fallback: number): number {
	if (typeof value !== "number" || Number.isNaN(value)) return fallback;
	return Math.min(100, Math.max(10, value));
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || Number.isNaN(value)) return fallback;
	const rounded = Math.trunc(value);
	return Math.min(max, Math.max(min, rounded));
}

function resolveShortcut(value: string | undefined, fallback: string): string {
	if (typeof value !== "string") return fallback;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : fallback;
}
