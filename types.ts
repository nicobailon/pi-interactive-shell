/**
 * Shared types and interfaces for the interactive shell extension.
 */

import type { ResolvedShellConfig } from "./shell-resolution.ts";

export type DispatchCompletionReason = "exited" | "timed-out" | "killed" | "auto-close-quiet";

export interface InteractiveShellResult {
	exitCode: number | null;
	signal?: number;
	/** Why a dispatch session completed. `auto-close-quiet` is not a command verdict. */
	completionReason?: DispatchCompletionReason;
	backgrounded: boolean;
	backgroundId?: string;
	cancelled: boolean;
	timedOut?: boolean;
	sessionId?: string;
	userTookOver?: boolean;
	/** When user triggers "Transfer" action, this contains the captured output */
	transferred?: {
		lines: string[];
		totalLines: number;
		truncated: boolean;
	};
	/** Captured before PTY disposal for dispatch mode completion notifications */
	completionOutput?: {
		lines: string[];
		totalLines: number;
		truncated: boolean;
	};
	handoffPreview?: {
		type: "tail";
		when: "exit" | "detach" | "kill" | "timeout" | "transfer";
		lines: string[];
	};
	handoff?: {
		type: "snapshot";
		when: "exit" | "detach" | "kill" | "timeout" | "transfer";
		transcriptPath: string;
		linesWritten: number;
	};
}

export interface HandsFreeUpdate {
	status: "running" | "user-takeover" | "exited" | "killed" | "agent-resumed";
	sessionId: string;
	runtime: number;
	tail: string[];
	tailTruncated: boolean;
	userTookOver?: boolean;
	// Budget tracking
	totalCharsSent?: number;
	budgetExhausted?: boolean;
}

export type MonitorStrategy = "stream" | "poll-diff" | "file-watch";

export type MonitorThresholdOperator = "lt" | "lte" | "gt" | "gte";

export interface MonitorThresholdConfig {
	captureGroup: number;
	op: MonitorThresholdOperator;
	value: number;
}

export interface MonitorTriggerConfig {
	id: string;
	literal?: string;
	regex?: string;
	cooldownMs?: number;
	threshold?: MonitorThresholdConfig;
}

export interface MonitorFileWatchConfig {
	path: string;
	recursive?: boolean;
	events?: Array<"rename" | "change">;
}

export interface MonitorConfig {
	strategy?: MonitorStrategy;
	triggers: MonitorTriggerConfig[];
	fileWatch?: MonitorFileWatchConfig;
	poll?: {
		intervalMs?: number;
	};
	persistence?: {
		stopAfterFirstEvent?: boolean;
		maxEvents?: number;
	};
	throttle?: {
		dedupeExactLine?: boolean;
		cooldownMs?: number;
	};
	detector?: {
		detectorCommand: string;
		timeoutMs?: number;
	};
}

export interface MonitorEventPayload {
	sessionId: string;
	eventId: number;
	timestamp: string;
	strategy: MonitorStrategy;
	triggerId: string;
	eventType: string;
	matchedText: string;
	lineOrDiff: string;
	stream: "pty";
}

export type MonitorTerminalReason = "stream-ended" | "script-failed" | "stopped" | "timed-out";

export interface MonitorSessionState {
	sessionId: string;
	strategy: MonitorStrategy;
	triggerIds: string[];
	status: "running" | "stopped";
	eventCount: number;
	startedAt: string;
	lastEventId?: number;
	lastEventAt?: string;
	lastTriggerId?: string;
	endedAt?: string;
	terminalReason?: MonitorTerminalReason;
	exitCode?: number | null;
	signal?: number;
}

/** Options for starting or reattaching an interactive shell session. */
export interface InteractiveShellOptions {
	command: string;
	cwd?: string;
	/** Resolved once for a new launch; omitted when attaching to an existing PTY. */
	shellConfig?: ResolvedShellConfig;
	name?: string;
	reason?: string;
	/** Original session start time in ms since epoch, preserved across background/reattach transitions. */
	startedAt?: number;
	handoffPreviewEnabled?: boolean;
	handoffPreviewLines?: number;
	handoffPreviewMaxChars?: number;
	handoffSnapshotEnabled?: boolean;
	handoffSnapshotLines?: number;
	handoffSnapshotMaxChars?: number;
	// Hands-free / dispatch / monitor mode
	mode?: "interactive" | "hands-free" | "dispatch" | "monitor";
	monitor?: MonitorConfig;
	sessionId?: string; // Pre-generated sessionId for non-blocking modes
	handsFreeUpdateMode?: "on-quiet" | "interval";
	handsFreeUpdateInterval?: number;
	handsFreeQuietThreshold?: number;
	handsFreeUpdateMaxChars?: number;
	handsFreeMaxTotalChars?: number;
	onHandsFreeUpdate?: (update: HandsFreeUpdate) => void;
	// Auto-exit when output stops (for agents that don't exit on their own)
	autoExitOnQuiet?: boolean;
	autoExitGracePeriod?: number;
	// Auto-kill timeout
	timeout?: number;
	// When true, unregister active session on completion (blocking tool call path).
	// When false/undefined, keep registered so agent can query result later.
	streamingMode?: boolean;
	// Existing PTY session (for attach flow -- skip creating a new PTY)
	existingSession?: import("./pty-session.ts").PtyTerminalSession;
	onUnfocus?: () => void;
}

export type DialogChoice = "kill" | "background" | "transfer" | "cancel" | "return-to-agent";
export type OverlayState = "running" | "exited" | "detach-dialog" | "hands-free";

// UI constants
export const FOOTER_LINES_COMPACT = 2;
export const FOOTER_LINES_DIALOG = 6;
export const HEADER_LINES = 4;

/** Format milliseconds to human-readable duration */
export function formatDuration(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}

/** Format a key shortcut string for display (capitalize modifier names) */
export function formatShortcut(shortcut: string): string {
	return shortcut
		.replace(/ctrl/gi, "Ctrl")
		.replace(/shift/gi, "Shift")
		.replace(/alt/gi, "Alt");
}

/** Format milliseconds with ms precision for shorter durations */
export function formatDurationMs(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}
