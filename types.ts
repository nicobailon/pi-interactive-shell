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
	/** Captured before session disposal for dispatch mode completion notifications */
	completionOutput?: {
		lines: string[];
		totalLines: number;
		truncated: boolean;
	};
	handoffPreview?: {
		type: "tail";
		when: "exit" | "detach" | "kill" | "timeout";
		lines: string[];
	};
	handoff?: {
		type: "snapshot";
		when: "exit" | "detach" | "kill" | "timeout";
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
	stream: "terminal";
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

/** Handoff / session option overrides shared by completion helpers. */
export interface InteractiveShellOptions {
	handoffPreviewEnabled?: boolean;
	handoffPreviewLines?: number;
	handoffPreviewMaxChars?: number;
	handoffSnapshotEnabled?: boolean;
	handoffSnapshotLines?: number;
	handoffSnapshotMaxChars?: number;
}

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
