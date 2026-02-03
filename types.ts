/**
 * Shared types and interfaces for the interactive shell extension.
 */

export interface InteractiveShellResult {
	exitCode: number | null;
	signal?: number;
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
	status: "running" | "user-takeover" | "exited" | "killed";
	sessionId: string;
	runtime: number;
	tail: string[];
	tailTruncated: boolean;
	userTookOver?: boolean;
	// Budget tracking
	totalCharsSent?: number;
	budgetExhausted?: boolean;
}

export interface InteractiveShellOptions {
	command: string;
	cwd?: string;
	name?: string;
	reason?: string;
	handoffPreviewEnabled?: boolean;
	handoffPreviewLines?: number;
	handoffPreviewMaxChars?: number;
	handoffSnapshotEnabled?: boolean;
	handoffSnapshotLines?: number;
	handoffSnapshotMaxChars?: number;
	// Hands-free / dispatch mode
	mode?: "interactive" | "hands-free" | "dispatch";
	sessionId?: string; // Pre-generated sessionId for non-blocking modes
	handsFreeUpdateMode?: "on-quiet" | "interval";
	handsFreeUpdateInterval?: number;
	handsFreeQuietThreshold?: number;
	handsFreeUpdateMaxChars?: number;
	handsFreeMaxTotalChars?: number;
	onHandsFreeUpdate?: (update: HandsFreeUpdate) => void;
	// Auto-exit when output stops (for agents that don't exit on their own)
	autoExitOnQuiet?: boolean;
	// Auto-kill timeout
	timeout?: number;
	// Existing PTY session (for attach flow -- skip creating a new PTY)
	existingSession?: import("./pty-session.js").PtyTerminalSession;
}

export type DialogChoice = "kill" | "background" | "transfer" | "cancel";
export type OverlayState = "running" | "exited" | "detach-dialog" | "hands-free";

// UI constants
export const FOOTER_LINES = 6;
export const HEADER_LINES = 4;
export const CHROME_LINES = HEADER_LINES + FOOTER_LINES + 2;

/** Format milliseconds to human-readable duration */
export function formatDuration(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
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
