import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { KeyId, OverlayAnchor } from "@earendil-works/pi-tui";
import { validateRedactionPatterns } from "./terminal-observation.ts";
import { DEFAULT_JEV_MODEL } from "./semantic-policy.ts";
import { compileSemanticPermissions, type CompiledSemanticPermissions } from "./semantic-permissions.ts";

/** A spawn agent is any key configured in `spawn.commands`, including the built-in defaults. */
export type SpawnAgent = string;

export interface SpawnConfig {
	defaultAgent: SpawnAgent;
	shortcut: KeyId;
	commands: Record<SpawnAgent, string>;
	defaultArgs: Record<SpawnAgent, string[]>;
	worktree: boolean;
	worktreeBaseDir?: string;
}

export interface InteractiveShellConfig {
	defer: boolean;
	exitAutoCloseDelay: number;
	overlayWidthPercent: number;
	overlayHeightPercent: number;
	overlayAnchor: OverlayAnchor;
	focusShortcut: KeyId;
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
	jev?: JevConfig;
}

export interface JevConfig {
	enabled: boolean;
	model: string;
	requestTimeoutMs: number;
	maxRetries: number;
	maxViewportLines: number;
	maxRecentChars: number;
	redactionPatterns: readonly string[];
	diagnostics: JevDiagnosticsConfig;
	semanticPermissions: CompiledSemanticPermissions;
}

export interface JevDiagnosticsConfig {
	enabled: boolean;
	retentionDays: number;
	maxBytes: number;
}

const DEFAULT_JEV_CONFIG: JevConfig = {
	enabled: false,
	model: DEFAULT_JEV_MODEL,
	requestTimeoutMs: 10_000,
	maxRetries: 1,
	maxViewportLines: 40,
	maxRecentChars: 4_000,
	redactionPatterns: [],
	diagnostics: { enabled: false, retentionDays: 14, maxBytes: 20_000_000 },
	semanticPermissions: compileSemanticPermissions([]),
};

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
};

const DEFAULT_CONFIG: InteractiveShellConfig = {
	defer: false,
	exitAutoCloseDelay: 10,
	overlayWidthPercent: 95,
	overlayHeightPercent: 60,
	overlayAnchor: "center",
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
	jev: DEFAULT_JEV_CONFIG,
};

export function loadConfig(cwd: string): InteractiveShellConfig {
	const projectPath = join(cwd, ".pi", "interactive-shell.json");
	const globalPath = join(getAgentDir(), "interactive-shell.json");

	const globalConfig = loadConfigObject(globalPath);
	const projectConfig = loadConfigObject(projectPath);

	const mergedSpawn = mergeSpawnConfig(globalConfig.spawn, projectConfig.spawn);
	const merged = { ...DEFAULT_CONFIG, ...globalConfig, ...projectConfig, spawn: mergedSpawn };
	const globalJev = isPlainObject(globalConfig.jev) ? globalConfig.jev : {};
	const projectJev = isPlainObject(projectConfig.jev) ? projectConfig.jev : {};
	// Transmission can only be enabled by the user's global config. Project config may only narrow limits/redaction.
	const jev = resolveJevConfig(globalJev, projectJev);

	return {
		...merged,
		defer: merged.defer === true,
		exitAutoCloseDelay: clampInt(merged.exitAutoCloseDelay, DEFAULT_CONFIG.exitAutoCloseDelay, 0, 60),
		overlayWidthPercent: clampPercent(merged.overlayWidthPercent, DEFAULT_CONFIG.overlayWidthPercent),
		overlayHeightPercent: clampInt(merged.overlayHeightPercent, DEFAULT_CONFIG.overlayHeightPercent, 20, 90),
		overlayAnchor: resolveOverlayAnchor(merged.overlayAnchor, DEFAULT_CONFIG.overlayAnchor),
		focusShortcut: resolveKeyId(merged.focusShortcut, DEFAULT_CONFIG.focusShortcut),
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
		jev,
	};
}

function resolveJevConfig(globalValue: Record<string, unknown>, projectValue: Record<string, unknown>): JevConfig {
	if (projectValue.semanticPermissions !== undefined) throw new Error("Project config cannot define trusted semantic permissions.");
	let semanticPermissions: CompiledSemanticPermissions;
	try { semanticPermissions = compileSemanticPermissions(globalValue.semanticPermissions ?? []); }
	catch (error) { throw new Error(`Invalid global Jev semantic permissions: ${error instanceof Error ? error.message : "invalid rules"}`); }
	if (globalValue.diagnostics !== undefined && !isPlainObject(globalValue.diagnostics)) throw new Error("Invalid global Jev diagnostics configuration.");
	const diagnostics = isPlainObject(globalValue.diagnostics) ? globalValue.diagnostics : {};
	const globalPatterns = resolveRedactionPatterns(globalValue.redactionPatterns, "global");
	const projectPatterns = resolveRedactionPatterns(projectValue.redactionPatterns, "project");
	const selectedPatterns = [
		...globalPatterns.map((source, index) => ({ source, scope: "global", index })),
		...projectPatterns.map((source, index) => ({ source, scope: "project", index })),
	].slice(0, 50);
	const redactionPatterns = Object.freeze(selectedPatterns.map(({ source }) => source));
	const invalidPatternIndex = validateRedactionPatterns(redactionPatterns);
	if (invalidPatternIndex !== undefined) {
		const pattern = selectedPatterns[invalidPatternIndex]!;
		throw new Error(`Invalid ${pattern.scope} Jev redaction pattern at index ${pattern.index}.`);
	}
	const globalTimeout = clampInt(globalValue.requestTimeoutMs, DEFAULT_JEV_CONFIG.requestTimeoutMs, 1_000, 30_000);
	const globalRetries = clampInt(globalValue.maxRetries, DEFAULT_JEV_CONFIG.maxRetries, 0, 2);
	const globalViewportLines = clampInt(globalValue.maxViewportLines, DEFAULT_JEV_CONFIG.maxViewportLines, 5, 80);
	const globalRecentChars = clampInt(globalValue.maxRecentChars, DEFAULT_JEV_CONFIG.maxRecentChars, 500, 8_000);
	return {
		enabled: globalValue.enabled === true,
		model: resolveOptionalString(globalValue.model) ?? DEFAULT_JEV_CONFIG.model,
		requestTimeoutMs: Math.min(globalTimeout, clampInt(projectValue.requestTimeoutMs, globalTimeout, 1_000, 30_000)),
		maxRetries: Math.min(globalRetries, clampInt(projectValue.maxRetries, globalRetries, 0, 2)),
		maxViewportLines: Math.min(globalViewportLines, clampInt(projectValue.maxViewportLines, globalViewportLines, 5, 80)),
		maxRecentChars: Math.min(globalRecentChars, clampInt(projectValue.maxRecentChars, globalRecentChars, 500, 8_000)),
		redactionPatterns,
		semanticPermissions,
		diagnostics: {
			enabled: diagnostics.enabled === true,
			retentionDays: clampInt(diagnostics.retentionDays, DEFAULT_JEV_CONFIG.diagnostics.retentionDays, 1, 90),
			maxBytes: clampInt(diagnostics.maxBytes, DEFAULT_JEV_CONFIG.diagnostics.maxBytes, 1_000_000, 100_000_000),
		},
	};
}

function loadConfigObject(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (isPlainObject(parsed)) return parsed;
		console.error(`Warning: Ignoring ${path}: config root must be an object`);
	} catch (error) {
		console.error(`Warning: Could not parse ${path}:`, error);
	}
	return {};
}

function mergeSpawnConfig(globalValue: unknown, projectValue: unknown): SpawnConfig {
	const globalSpawn = isPlainObject(globalValue) ? globalValue : undefined;
	const projectSpawn = isPlainObject(projectValue) ? projectValue : undefined;
	const globalCommands = isPlainObject(globalSpawn?.commands) ? globalSpawn.commands : undefined;
	const projectCommands = isPlainObject(projectSpawn?.commands) ? projectSpawn.commands : undefined;
	const globalArgs = isPlainObject(globalSpawn?.defaultArgs) ? globalSpawn.defaultArgs : undefined;
	const projectArgs = isPlainObject(projectSpawn?.defaultArgs) ? projectSpawn.defaultArgs : undefined;

	const mergedCommands = mergeSpawnCommands(globalCommands, projectCommands);
	const mergedDefaultArgs = mergeSpawnDefaultArgs(mergedCommands, globalArgs, projectArgs);

	return {
		defaultAgent: resolveSpawnAgent(projectSpawn?.defaultAgent ?? globalSpawn?.defaultAgent, DEFAULT_SPAWN_CONFIG.defaultAgent, mergedCommands),
		shortcut: resolveKeyId(projectSpawn?.shortcut ?? globalSpawn?.shortcut, DEFAULT_SPAWN_CONFIG.shortcut),
		commands: mergedCommands,
		defaultArgs: mergedDefaultArgs,
		worktree: resolveBoolean(projectSpawn?.worktree ?? globalSpawn?.worktree, DEFAULT_SPAWN_CONFIG.worktree),
		worktreeBaseDir: resolveOptionalString(projectSpawn?.worktreeBaseDir ?? globalSpawn?.worktreeBaseDir),
	};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Agent names double as `/spawn` tokens and as generated worktree directory segments, so they must
 * not collide with `/spawn` mode keywords, start with a dash, or contain path/shell characters.
 * Object.prototype member names are rejected too, so agent maps are never read through the prototype.
 */
const SPAWN_AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RESERVED_SPAWN_AGENT_NAMES = new Set(["fresh", "fork"]);

function isSpawnAgentName(name: string): boolean {
	return SPAWN_AGENT_NAME_PATTERN.test(name)
		&& !RESERVED_SPAWN_AGENT_NAMES.has(name)
		&& !(name in Object.prototype);
}

function mergeSpawnCommands(
	globalCommands: Record<string, unknown> | undefined,
	projectCommands: Record<string, unknown> | undefined,
): Record<SpawnAgent, string> {
	const commands: Record<SpawnAgent, string> = { ...DEFAULT_SPAWN_CONFIG.commands };
	for (const source of [globalCommands, projectCommands]) {
		for (const [name, value] of Object.entries(source ?? {})) {
			if (!isSpawnAgentName(name)) {
				console.error(`pi-interactive-shell: ignoring invalid spawn agent name "${name}" in config`);
				continue;
			}
			const command = resolveOptionalString(value);
			if (command) commands[name] = command;
		}
	}
	return commands;
}

function mergeSpawnDefaultArgs(
	commands: Record<SpawnAgent, string>,
	globalArgs: Record<string, unknown> | undefined,
	projectArgs: Record<string, unknown> | undefined,
): Record<SpawnAgent, string[]> {
	const defaultArgs: Record<SpawnAgent, string[]> = {};
	for (const name of Object.keys(commands)) {
		defaultArgs[name] = resolveStringArray(
			projectArgs?.[name] ?? globalArgs?.[name],
			DEFAULT_SPAWN_CONFIG.defaultArgs[name] ?? [],
		);
	}
	return defaultArgs;
}

function resolveSpawnAgent(value: unknown, fallback: SpawnAgent, commands: Record<SpawnAgent, string>): SpawnAgent {
	if (typeof value !== "string") return fallback;
	const trimmed = value.trim();
	if (trimmed.length === 0) return fallback;
	if (Object.hasOwn(commands, trimmed)) return trimmed;
	console.error(`pi-interactive-shell: unknown spawn.defaultAgent "${trimmed}" in config, using "${fallback}"`);
	return fallback;
}

function resolveStringArray(value: unknown, fallback: string[]): string[] {
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return fallback;
	return value;
}

function resolveRedactionPatterns(value: unknown, scope: "global" | "project"): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error(`Invalid ${scope} Jev redaction configuration.`);
	for (let index = 0; index < value.length; index++) {
		if (typeof value[index] !== "string") throw new Error(`Invalid ${scope} Jev redaction entry at index ${index}.`);
	}
	return value as string[];
}

function resolveBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function resolveOptionalString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

const OVERLAY_ANCHORS: readonly OverlayAnchor[] = [
	"center", "top-left", "top-center", "top-right",
	"left-center", "right-center",
	"bottom-left", "bottom-center", "bottom-right",
];

function isOverlayAnchor(value: string): value is OverlayAnchor {
	return (OVERLAY_ANCHORS as readonly string[]).includes(value);
}

function resolveOverlayAnchor(value: unknown, fallback: OverlayAnchor): OverlayAnchor {
	if (typeof value !== "string") return fallback;
	const trimmed = value.trim();
	if (trimmed.length === 0) return fallback;
	if (isOverlayAnchor(trimmed)) return trimmed;
	console.error(`pi-interactive-shell: invalid overlayAnchor "${trimmed}" in config, using "${fallback}"`);
	return fallback;
}

function clampPercent(value: number | undefined, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(100, Math.max(10, value));
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	const rounded = Math.trunc(value);
	return Math.min(max, Math.max(min, rounded));
}

const KEY_MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);
const KEY_SYMBOLS = "`-=[]\\;',./!@#$%^&*()_+|~{}:<>?";
const KEY_SPECIALS = new Set([
	"escape", "esc", "enter", "return", "tab", "space", "backspace", "delete", "insert", "clear",
	"home", "end", "pageUp", "pageDown", "up", "down", "left", "right",
	"f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
]);

function isKeyId(value: string): value is KeyId {
	const parts = value.split("+");
	let base = parts.pop() ?? "";
	if (base === "") {
		// A trailing "+" means the base key is the "+" symbol itself (e.g. "ctrl++").
		if (parts.pop() !== "") return false;
		base = "+";
	}
	if (parts.some((mod) => !KEY_MODIFIERS.has(mod))) return false;
	if (new Set(parts).size !== parts.length) return false;
	if (base.length === 1) return /[a-z0-9]/.test(base) || KEY_SYMBOLS.includes(base);
	return KEY_SPECIALS.has(base);
}

function resolveKeyId(value: unknown, fallback: KeyId): KeyId {
	if (typeof value !== "string") return fallback;
	const trimmed = value.trim();
	if (trimmed.length === 0) return fallback;
	if (isKeyId(trimmed)) return trimmed;
	console.error(`pi-interactive-shell: invalid shortcut "${trimmed}" in config, using "${fallback}"`);
	return fallback;
}
