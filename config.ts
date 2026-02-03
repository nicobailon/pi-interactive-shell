import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface InteractiveShellConfig {
	exitAutoCloseDelay: number;
	overlayWidthPercent: number;
	overlayHeightPercent: number;
	scrollbackLines: number;
	ansiReemit: boolean;
	handoffPreviewEnabled: boolean;
	handoffPreviewLines: number;
	handoffPreviewMaxChars: number;
	handoffSnapshotEnabled: boolean;
	handoffSnapshotLines: number;
	handoffSnapshotMaxChars: number;
	// Transfer output settings (Ctrl+T)
	transferLines: number;
	transferMaxChars: number;
	// Dispatch completion notification output
	completionNotifyLines: number;
	completionNotifyMaxChars: number;
	// Hands-free mode defaults
	handsFreeUpdateMode: "on-quiet" | "interval";
	handsFreeUpdateInterval: number;
	handsFreeQuietThreshold: number;
	handsFreeUpdateMaxChars: number;
	handsFreeMaxTotalChars: number;
	// Query rate limiting
	minQueryIntervalSeconds: number;
}

const DEFAULT_CONFIG: InteractiveShellConfig = {
	exitAutoCloseDelay: 10,
	overlayWidthPercent: 95,
	overlayHeightPercent: 45,
	scrollbackLines: 5000,
	ansiReemit: true,
	handoffPreviewEnabled: true,
	handoffPreviewLines: 30,
	handoffPreviewMaxChars: 2000,
	handoffSnapshotEnabled: false,
	handoffSnapshotLines: 200,
	handoffSnapshotMaxChars: 12000,
	// Transfer output settings (Ctrl+T) - generous defaults for full context transfer
	transferLines: 200,
	transferMaxChars: 20000,
	// Dispatch completion notification output (between handoff preview and transfer)
	completionNotifyLines: 50,
	completionNotifyMaxChars: 5000,
	// Hands-free mode defaults
	handsFreeUpdateMode: "on-quiet" as const,
	handsFreeUpdateInterval: 60000,
	handsFreeQuietThreshold: 5000,
	handsFreeUpdateMaxChars: 1500,
	handsFreeMaxTotalChars: 100000,
	// Query rate limiting (default 60 seconds between queries)
	minQueryIntervalSeconds: 60,
};

export function loadConfig(cwd: string): InteractiveShellConfig {
	const projectPath = join(cwd, ".pi", "interactive-shell.json");
	const globalPath = join(homedir(), ".pi", "agent", "interactive-shell.json");

	let globalConfig: Partial<InteractiveShellConfig> = {};
	let projectConfig: Partial<InteractiveShellConfig> = {};

	if (existsSync(globalPath)) {
		try {
			globalConfig = JSON.parse(readFileSync(globalPath, "utf-8"));
		} catch (error) {
			console.error(`Warning: Could not parse ${globalPath}: ${String(error)}`);
		}
	}

	if (existsSync(projectPath)) {
		try {
			projectConfig = JSON.parse(readFileSync(projectPath, "utf-8"));
		} catch (error) {
			console.error(`Warning: Could not parse ${projectPath}: ${String(error)}`);
		}
	}

	const merged = { ...DEFAULT_CONFIG, ...globalConfig, ...projectConfig };

	return {
		...merged,
		exitAutoCloseDelay: clampInt(merged.exitAutoCloseDelay, DEFAULT_CONFIG.exitAutoCloseDelay, 0, 60),
		overlayWidthPercent: clampPercent(merged.overlayWidthPercent, DEFAULT_CONFIG.overlayWidthPercent),
		// Height: 20-90% range (default 45%)
		overlayHeightPercent: clampInt(merged.overlayHeightPercent, DEFAULT_CONFIG.overlayHeightPercent, 20, 90),
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
		// Transfer output settings (Ctrl+T)
		transferLines: clampInt(merged.transferLines, DEFAULT_CONFIG.transferLines, 10, 1000),
		transferMaxChars: clampInt(merged.transferMaxChars, DEFAULT_CONFIG.transferMaxChars, 1000, 100000),
		// Dispatch completion notification output
		completionNotifyLines: clampInt(merged.completionNotifyLines, DEFAULT_CONFIG.completionNotifyLines, 10, 500),
		completionNotifyMaxChars: clampInt(merged.completionNotifyMaxChars, DEFAULT_CONFIG.completionNotifyMaxChars, 1000, 50000),
		// Hands-free mode
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
		// Query rate limiting (min 5 seconds, max 300 seconds)
		minQueryIntervalSeconds: clampInt(
			merged.minQueryIntervalSeconds,
			DEFAULT_CONFIG.minQueryIntervalSeconds,
			5,
			300,
		),
	};
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
