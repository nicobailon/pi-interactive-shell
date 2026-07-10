import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

export type SpawnAgent = "pi" | "codex" | "claude" | "cursor";

export interface SpawnConfig {
	defaultAgent: SpawnAgent;
	shortcut: string;
	commands: Record<SpawnAgent, string>;
	defaultArgs: Record<SpawnAgent, string[]>;
	worktree: boolean;
	worktreeBaseDir?: string;
}

export interface KittyConfig {
	listenOn?: string;
	remoteControlPassword?: string;
	publicKey?: string;
	version: [number, number, number];
	responseTimeoutMs: number;
	connectTimeoutMs: number;
	pollIntervalMs: number;
	killGraceMs: number;
	osWindowTitle: string;
	tabTitlePrefix: string;
	focusNewSessions: boolean;
}

export interface InteractiveShellConfig {
	focusShortcut: string;
	spawn: SpawnConfig;
	kitty: KittyConfig;
	scrollbackLines: number;
	ansiReemit: boolean;
	handoffPreviewEnabled: boolean;
	handoffPreviewLines: number;
	handoffPreviewMaxChars: number;
	handoffSnapshotEnabled: boolean;
	handoffSnapshotLines: number;
	handoffSnapshotMaxChars: number;
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
		cursor: "agent",
	},
	defaultArgs: {
		pi: [],
		codex: [],
		claude: [],
		cursor: ["--model", "composer-2-fast"],
	},
	worktree: false,
	worktreeBaseDir: undefined,
};

const DEFAULT_CONFIG: InteractiveShellConfig = {
	focusShortcut: "alt+shift+f",
	spawn: DEFAULT_SPAWN_CONFIG,
	kitty: {
		listenOn: undefined,
		remoteControlPassword: undefined,
		publicKey: undefined,
		version: [0, 47, 4],
		responseTimeoutMs: 5000,
		connectTimeoutMs: 5000,
		pollIntervalMs: 500,
		killGraceMs: 5000,
		osWindowTitle: "Pi Interactive Kitty",
		tabTitlePrefix: "pi-shell",
		focusNewSessions: true,
	},
	scrollbackLines: 5000,
	ansiReemit: true,
	handoffPreviewEnabled: true,
	handoffPreviewLines: 30,
	handoffPreviewMaxChars: 2000,
	handoffSnapshotEnabled: false,
	handoffSnapshotLines: 200,
	handoffSnapshotMaxChars: 12000,
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

function readConfigFile(dir: string, filename: string): Partial<InteractiveShellConfig> {
	const path = join(dir, filename);
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as Partial<InteractiveShellConfig>;
	} catch (error) {
		console.error(`Warning: Could not parse ${path}:`, error);
		return {};
	}
}

export function loadConfig(cwd: string): InteractiveShellConfig {
	const globalConfig = readConfigFile(getAgentDir(), "interactive-kitty.json");
	const projectConfig = readConfigFile(join(cwd, ".pi"), "interactive-kitty.json");

	const mergedSpawn = mergeSpawnConfig(globalConfig.spawn, projectConfig.spawn);
	const mergedKitty = mergeKittyConfig(globalConfig.kitty, projectConfig.kitty);
	const merged = { ...DEFAULT_CONFIG, ...globalConfig, ...projectConfig, spawn: mergedSpawn, kitty: mergedKitty };

	return {
		...merged,
		focusShortcut: resolveShortcut(merged.focusShortcut, DEFAULT_CONFIG.focusShortcut),
		spawn: mergedSpawn,
		kitty: mergedKitty,
		scrollbackLines: clampInt(merged.scrollbackLines, DEFAULT_CONFIG.scrollbackLines, 200, 50000),
		ansiReemit: merged.ansiReemit !== false,
		handoffPreviewEnabled: merged.handoffPreviewEnabled !== false,
		handoffPreviewLines: clampInt(merged.handoffPreviewLines, DEFAULT_CONFIG.handoffPreviewLines, 0, 500),
		handoffPreviewMaxChars: clampInt(merged.handoffPreviewMaxChars, DEFAULT_CONFIG.handoffPreviewMaxChars, 0, 50000),
		handoffSnapshotEnabled: merged.handoffSnapshotEnabled === true,
		handoffSnapshotLines: clampInt(merged.handoffSnapshotLines, DEFAULT_CONFIG.handoffSnapshotLines, 0, 5000),
		handoffSnapshotMaxChars: clampInt(merged.handoffSnapshotMaxChars, DEFAULT_CONFIG.handoffSnapshotMaxChars, 0, 200000),
		completionNotifyLines: clampInt(merged.completionNotifyLines, DEFAULT_CONFIG.completionNotifyLines, 10, 500),
		completionNotifyMaxChars: clampInt(merged.completionNotifyMaxChars, DEFAULT_CONFIG.completionNotifyMaxChars, 1000, 50000),
		handsFreeUpdateMode: merged.handsFreeUpdateMode === "interval" ? "interval" : "on-quiet",
		handsFreeUpdateInterval: clampInt(merged.handsFreeUpdateInterval, DEFAULT_CONFIG.handsFreeUpdateInterval, 5000, 300000),
		handsFreeQuietThreshold: clampInt(merged.handsFreeQuietThreshold, DEFAULT_CONFIG.handsFreeQuietThreshold, 1000, 30000),
		autoExitGracePeriod: clampInt(merged.autoExitGracePeriod, DEFAULT_CONFIG.autoExitGracePeriod, 5000, 120000),
		handsFreeUpdateMaxChars: clampInt(merged.handsFreeUpdateMaxChars, DEFAULT_CONFIG.handsFreeUpdateMaxChars, 500, 50000),
		handsFreeMaxTotalChars: clampInt(merged.handsFreeMaxTotalChars, DEFAULT_CONFIG.handsFreeMaxTotalChars, 10000, 1000000),
		minQueryIntervalSeconds: clampInt(merged.minQueryIntervalSeconds, DEFAULT_CONFIG.minQueryIntervalSeconds, 5, 300),
	};
}

function mergeKittyConfig(globalValue: unknown, projectValue: unknown): KittyConfig {
	const globalKitty = isPlainObject(globalValue) ? globalValue : undefined;
	const projectKitty = isPlainObject(projectValue) ? projectValue : undefined;
	return {
		listenOn: resolveOptionalString(projectKitty?.listenOn ?? globalKitty?.listenOn),
		remoteControlPassword: resolveOptionalString(projectKitty?.remoteControlPassword ?? globalKitty?.remoteControlPassword),
		publicKey: resolveOptionalString(projectKitty?.publicKey ?? globalKitty?.publicKey),
		version: resolveVersion(projectKitty?.version ?? globalKitty?.version, DEFAULT_CONFIG.kitty.version),
		responseTimeoutMs: clampInt(
			projectKitty?.responseTimeoutMs ?? globalKitty?.responseTimeoutMs,
			DEFAULT_CONFIG.kitty.responseTimeoutMs,
			1000,
			120000,
		),
		connectTimeoutMs: clampInt(
			projectKitty?.connectTimeoutMs ?? globalKitty?.connectTimeoutMs,
			DEFAULT_CONFIG.kitty.connectTimeoutMs,
			500,
			60000,
		),
		pollIntervalMs: clampInt(projectKitty?.pollIntervalMs ?? globalKitty?.pollIntervalMs, DEFAULT_CONFIG.kitty.pollIntervalMs, 100, 10000),
		killGraceMs: clampInt(projectKitty?.killGraceMs ?? globalKitty?.killGraceMs, DEFAULT_CONFIG.kitty.killGraceMs, 500, 60000),
		osWindowTitle: resolveString(projectKitty?.osWindowTitle ?? globalKitty?.osWindowTitle, DEFAULT_CONFIG.kitty.osWindowTitle),
		tabTitlePrefix: resolveString(projectKitty?.tabTitlePrefix ?? globalKitty?.tabTitlePrefix, DEFAULT_CONFIG.kitty.tabTitlePrefix),
		focusNewSessions: resolveBoolean(
			projectKitty?.focusNewSessions ?? globalKitty?.focusNewSessions,
			DEFAULT_CONFIG.kitty.focusNewSessions,
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
		pi: resolveString(projectCommands?.pi ?? globalCommands?.pi, DEFAULT_SPAWN_CONFIG.commands.pi),
		codex: resolveString(projectCommands?.codex ?? globalCommands?.codex, DEFAULT_SPAWN_CONFIG.commands.codex),
		claude: resolveString(projectCommands?.claude ?? globalCommands?.claude, DEFAULT_SPAWN_CONFIG.commands.claude),
		cursor: resolveString(projectCommands?.cursor ?? globalCommands?.cursor, DEFAULT_SPAWN_CONFIG.commands.cursor),
	};

	const mergedDefaultArgs = {
		pi: resolveStringArray(projectArgs?.pi ?? globalArgs?.pi, DEFAULT_SPAWN_CONFIG.defaultArgs.pi),
		codex: resolveStringArray(projectArgs?.codex ?? globalArgs?.codex, DEFAULT_SPAWN_CONFIG.defaultArgs.codex),
		claude: resolveStringArray(projectArgs?.claude ?? globalArgs?.claude, DEFAULT_SPAWN_CONFIG.defaultArgs.claude),
		cursor: resolveStringArray(projectArgs?.cursor ?? globalArgs?.cursor, DEFAULT_SPAWN_CONFIG.defaultArgs.cursor),
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
	return value === "pi" || value === "codex" || value === "claude" || value === "cursor" ? value : fallback;
}

function resolveString(value: unknown, fallback: string): string {
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

function resolveVersion(value: unknown, fallback: [number, number, number]): [number, number, number] {
	if (!Array.isArray(value) || value.length !== 3) return fallback;
	const parsed = value.map((part) => Number(part));
	if (!parsed.every((part) => Number.isInteger(part) && part >= 0)) return fallback;
	return [parsed[0]!, parsed[1]!, parsed[2]!];
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
