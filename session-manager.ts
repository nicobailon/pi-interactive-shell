import { PtyTerminalSession } from "./pty-session.js";

export interface BackgroundSession {
	id: string;
	name: string;
	command: string;
	reason?: string;
	session: PtyTerminalSession;
	startedAt: Date;
}

export type ActiveSessionStatus = "running" | "user-takeover" | "exited" | "killed" | "backgrounded";

export interface ActiveSessionResult {
	exitCode: number | null;
	signal?: number;
	backgrounded?: boolean;
	backgroundId?: string;
	cancelled?: boolean;
	timedOut?: boolean;
}

export interface OutputResult {
	output: string;
	truncated: boolean;
	totalBytes: number;
	// Rate limiting
	rateLimited?: boolean;
	waitSeconds?: number;
}

export interface ActiveSession {
	id: string;
	command: string;
	reason?: string;
	write: (data: string) => void;
	kill: () => void;
	getOutput: (skipRateLimit?: boolean) => OutputResult; // Get output since last check (truncated if large)
	getStatus: () => ActiveSessionStatus;
	getRuntime: () => number;
	getResult: () => ActiveSessionResult | undefined; // Available when completed
	setUpdateInterval?: (intervalMs: number) => void;
	setQuietThreshold?: (thresholdMs: number) => void;
	onComplete: (callback: () => void) => void; // Register callback for when session completes
	startedAt: Date;
}

// Human-readable session slug generation
const SLUG_ADJECTIVES = [
	"amber", "brisk", "calm", "clear", "cool", "crisp", "dawn", "ember",
	"fast", "fresh", "gentle", "keen", "kind", "lucky", "mellow", "mild",
	"neat", "nimble", "nova", "quick", "quiet", "rapid", "sharp", "swift",
	"tender", "tidy", "vivid", "warm", "wild", "young",
];

const SLUG_NOUNS = [
	"atlas", "bloom", "breeze", "cedar", "cloud", "comet", "coral", "cove",
	"crest", "delta", "dune", "ember", "falcon", "fjord", "glade", "haven",
	"kelp", "lagoon", "meadow", "mist", "nexus", "orbit", "pine", "reef",
	"ridge", "river", "sage", "shell", "shore", "summit", "trail", "zephyr",
];

function randomChoice<T>(arr: T[]): T {
	return arr[Math.floor(Math.random() * arr.length)];
}

// Track used IDs to avoid collisions
const usedIds = new Set<string>();

export function generateSessionId(name?: string): string {
	// If a custom name is provided, use simple counter approach
	if (name) {
		let counter = 1;
		let id = name;
		while (usedIds.has(id)) {
			counter++;
			id = `${name}-${counter}`;
		}
		usedIds.add(id);
		return id;
	}

	// Generate human-readable slug
	for (let attempt = 0; attempt < 20; attempt++) {
		const adj = randomChoice(SLUG_ADJECTIVES);
		const noun = randomChoice(SLUG_NOUNS);
		const base = `${adj}-${noun}`;

		if (!usedIds.has(base)) {
			usedIds.add(base);
			return base;
		}

		// Try with suffix
		for (let i = 2; i <= 9; i++) {
			const candidate = `${base}-${i}`;
			if (!usedIds.has(candidate)) {
				usedIds.add(candidate);
				return candidate;
			}
		}
	}

	// Fallback: timestamp-based
	const fallback = `shell-${Date.now().toString(36)}`;
	usedIds.add(fallback);
	return fallback;
}

export function releaseSessionId(id: string): void {
	usedIds.delete(id);
}

// Derive a friendly display name from command (e.g., "pi Fix all bugs" -> "pi Fix all bugs")
export function deriveSessionName(command: string): string {
	const trimmed = command.trim();
	if (trimmed.length <= 60) return trimmed;

	// Truncate with ellipsis
	return trimmed.slice(0, 57) + "...";
}

export class ShellSessionManager {
	private sessions = new Map<string, BackgroundSession>();
	private exitWatchers = new Map<string, NodeJS.Timeout>();
	private cleanupTimers = new Map<string, NodeJS.Timeout>();
	private activeSessions = new Map<string, ActiveSession>();

	// Active hands-free session management
	registerActive(session: {
		id: string;
		command: string;
		reason?: string;
		write: (data: string) => void;
		kill: () => void;
		getOutput: (skipRateLimit?: boolean) => OutputResult;
		getStatus: () => ActiveSessionStatus;
		getRuntime: () => number;
		getResult: () => ActiveSessionResult | undefined;
		setUpdateInterval?: (intervalMs: number) => void;
		setQuietThreshold?: (thresholdMs: number) => void;
		onComplete: (callback: () => void) => void;
	}): void {
		this.activeSessions.set(session.id, {
			...session,
			startedAt: new Date(),
		});
	}

	unregisterActive(id: string, releaseId = false): void {
		this.activeSessions.delete(id);
		// Only release the ID if explicitly requested (when session fully terminates)
		// This prevents ID reuse while session is still running after takeover
		if (releaseId) {
			releaseSessionId(id);
		}
	}

	getActive(id: string): ActiveSession | undefined {
		return this.activeSessions.get(id);
	}

	writeToActive(id: string, data: string): boolean {
		const session = this.activeSessions.get(id);
		if (!session) return false;
		session.write(data);
		return true;
	}

	setActiveUpdateInterval(id: string, intervalMs: number): boolean {
		const session = this.activeSessions.get(id);
		if (!session?.setUpdateInterval) return false;
		session.setUpdateInterval(intervalMs);
		return true;
	}

	setActiveQuietThreshold(id: string, thresholdMs: number): boolean {
		const session = this.activeSessions.get(id);
		if (!session?.setQuietThreshold) return false;
		session.setQuietThreshold(thresholdMs);
		return true;
	}

	listActive(): ActiveSession[] {
		return Array.from(this.activeSessions.values());
	}

	// Background session management
	add(command: string, session: PtyTerminalSession, name?: string, reason?: string): string {
		const id = generateSessionId(name);
		this.sessions.set(id, {
			id,
			name: name || deriveSessionName(command),
			command,
			reason,
			session,
			startedAt: new Date(),
		});

		session.setEventHandlers({});

		const checkExit = setInterval(() => {
			if (session.exited) {
				clearInterval(checkExit);
				this.exitWatchers.delete(id);
				const cleanupTimer = setTimeout(() => {
					this.cleanupTimers.delete(id);
					this.remove(id);
				}, 30000);
				this.cleanupTimers.set(id, cleanupTimer);
			}
		}, 1000);
		this.exitWatchers.set(id, checkExit);

		return id;
	}

	get(id: string): BackgroundSession | undefined {
		// Cancel auto-cleanup timer when session is being reattached
		const cleanupTimer = this.cleanupTimers.get(id);
		if (cleanupTimer) {
			clearTimeout(cleanupTimer);
			this.cleanupTimers.delete(id);
		}
		return this.sessions.get(id);
	}

	remove(id: string): void {
		const watcher = this.exitWatchers.get(id);
		if (watcher) {
			clearInterval(watcher);
			this.exitWatchers.delete(id);
		}

		const cleanupTimer = this.cleanupTimers.get(id);
		if (cleanupTimer) {
			clearTimeout(cleanupTimer);
			this.cleanupTimers.delete(id);
		}

		const session = this.sessions.get(id);
		if (session) {
			session.session.dispose();
			this.sessions.delete(id);
			releaseSessionId(id);
		}
	}

	list(): BackgroundSession[] {
		return Array.from(this.sessions.values());
	}

	killAll(): void {
		// Kill all background sessions
		// Collect IDs first to avoid modifying map during iteration
		const bgIds = Array.from(this.sessions.keys());
		for (const id of bgIds) {
			this.remove(id);
		}

		// Kill all active hands-free sessions
		// Collect entries first since kill() may trigger unregisterActive()
		const activeEntries = Array.from(this.activeSessions.entries());
		for (const [id, session] of activeEntries) {
			try {
				session.kill();
				// Only release ID if kill succeeded - let natural cleanup handle failures
				// The session's exit handler will call unregisterActive() which releases the ID
			} catch {
				// Session may already be dead - still safe to release since no process running
				releaseSessionId(id);
			}
		}
		// Don't clear immediately - let unregisterActive() handle cleanup as sessions exit
		// This prevents ID reuse while processes are still terminating
	}
}

export const sessionManager = new ShellSessionManager();
