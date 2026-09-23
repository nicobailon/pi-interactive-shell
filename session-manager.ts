import { PtyTerminalSession } from "./pty-session.ts";
import type { DispatchCompletionReason } from "./types.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { OutputSourceStore, type OutputCapture, type OutputSourceRead, type OutputSourceStatus } from "./output-source-store.ts";

export interface BackgroundSession {
	id: string;
	name: string;
	explicitName?: boolean;
	command: string;
	reason?: string;
	session: PtyTerminalSession;
	startedAt: Date;
}

export type ActiveSessionStatus = "running" | "monitoring" | "user-takeover" | "exited" | "killed" | "backgrounded";

export interface ActiveSessionResult {
	exitCode: number | null;
	signal?: number;
	completionReason?: DispatchCompletionReason;
	backgrounded?: boolean;
	backgroundId?: string;
	cancelled?: boolean;
	timedOut?: boolean;
	completionOutput?: {
		lines: string[];
		totalLines: number;
		truncated: boolean;
	};
}

export interface OutputResult {
	output: string;
	truncated: boolean;
	totalBytes: number;
	// For incremental/offset modes
	totalLines?: number;
	hasMore?: boolean;
	// Rate limiting
	rateLimited?: boolean;
	waitSeconds?: number;
}

export interface OutputOptions {
	skipRateLimit?: boolean;
	lines?: number; // Override default 20 lines
	maxChars?: number; // Override default 5KB
	offset?: number; // Line offset for pagination (0-indexed)
	drain?: boolean; // If true, return only NEW output since last query (raw stream)
	incremental?: boolean; // If true, return next N lines not yet seen (server tracks position)
}

export interface ActiveSession {
	id: string;
	command: string;
	reason?: string;
	write: (data: string) => void;
	kill: () => void;
	background: () => void;
	getOutput: (options?: OutputOptions | boolean) => OutputResult;
	getStatus: () => ActiveSessionStatus;
	getRuntime: () => number;
	getResult: () => ActiveSessionResult | undefined;
	dispose?: () => void;
	retainAfterCompletion?: boolean;
	setUpdateInterval?: (intervalMs: number) => void;
	setQuietThreshold?: (thresholdMs: number) => void;
	onComplete: (callback: () => void) => void;
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
function deriveSessionName(command: string): string {
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
	private changeListeners = new Set<() => void>();
	private outputStore: OutputSourceStore | undefined;
	private outputLaunches = new Map<string, { goal: string; command: string; sourceId?: string; available: boolean; status?: string; fallback?: string }>();
	private outputSweepTimer: ReturnType<typeof setInterval> | undefined;
	private outputSweepInFlight: Promise<void> = Promise.resolve();
	private static readonly MAX_OUTPUT_LAUNCHES = 1024;
	private static readonly OUTPUT_SWEEP_INTERVAL_MS = 60_000;

	ensureReloadState(): void {
		this.outputLaunches ??= new Map();
		this.outputSweepInFlight ??= Promise.resolve();
		if (this.outputStore) {
			Object.setPrototypeOf(this.outputStore, OutputSourceStore.prototype);
			this.outputStore.ensureReloadState();
		}
		for (const id of this.sessions?.keys?.() ?? []) usedIds.add(id);
		for (const id of this.activeSessions?.keys?.() ?? []) usedIds.add(id);
	}

	private ensureOutputStore(): OutputSourceStore {
		if (!this.outputStore) {
			this.outputStore = new OutputSourceStore({ root: join(getAgentDir(), "cache", "interactive-shell", "output-sources") });
		}
		if (!this.outputSweepTimer) {
			this.queueOutputSweep();
			this.outputSweepTimer = setInterval(() => this.queueOutputSweep(), ShellSessionManager.OUTPUT_SWEEP_INTERVAL_MS);
			this.outputSweepTimer.unref?.();
		}
		return this.outputStore;
	}

	private queueOutputSweep(): void {
		const store = this.outputStore;
		if (!store) return;
		this.outputSweepInFlight = this.outputSweepInFlight.then(() => store.sweep()).catch(() => {});
	}

	disposeOutputRetention(): void {
		if (this.outputSweepTimer) clearInterval(this.outputSweepTimer);
		this.outputSweepTimer = undefined;
	}

	private rememberOutputLaunch(sessionId: string, launch: { goal: string; command: string; sourceId?: string; available: boolean; status?: string; fallback?: string }): void {
		this.outputLaunches.delete(sessionId);
		this.outputLaunches.set(sessionId, launch);
		while (this.outputLaunches.size > ShellSessionManager.MAX_OUTPUT_LAUNCHES) {
			const oldest = this.outputLaunches.keys().next().value;
			if (oldest === undefined) break;
			this.outputLaunches.delete(oldest);
		}
	}

	beginOutputCapture(sessionId: string, goal: string, command: string): { capture?: OutputCapture; sourceId?: string; available: boolean } {
		try {
			const capture = this.ensureOutputStore().begin(sessionId);
			this.rememberOutputLaunch(sessionId, { goal, command: command.slice(0, 1000), sourceId: capture.ref.sourceId, available: true });
			return { capture, sourceId: capture.ref.sourceId, available: true };
		} catch {
			this.rememberOutputLaunch(sessionId, { goal, command: command.slice(0, 1000), available: false });
			return { available: false };
		}
	}

	getOutputSourceForSession(sessionId: string): { sourceId?: string; available: boolean } | undefined {
		const launch = this.outputLaunches.get(sessionId);
		return launch && { sourceId: launch.sourceId, available: launch.available };
	}

	getOutputSelectionMetadata(sourceId: string): { goal: string; command: string; status?: string; fallback?: string } | undefined {
		for (const launch of this.outputLaunches.values()) {
			if (launch.sourceId === sourceId && launch.available) return { goal: launch.goal, command: launch.command, status: launch.status, fallback: launch.fallback };
		}
		return undefined;
	}

	recordOutputCompletion(sessionId: string, completion: { exitCode: number | null; signal?: number; completionReason: string; completionOutput?: { lines: string[] } }): void {
		const launch = this.outputLaunches.get(sessionId);
		if (!launch) return;
		launch.status = `completion=${completion.completionReason}; exitCode=${completion.exitCode === null ? "unknown" : completion.exitCode}${completion.signal === undefined ? "" : `; signal=${completion.signal}`}`;
		launch.fallback = completion.completionOutput?.lines.join("\n").slice(-5120) ?? "";
	}

	outputSourceStatus(sourceId: string): OutputSourceStatus {
		try {
			return this.ensureOutputStore().status(sourceId);
		} catch {
			return { sourceId, state: "missing", length: 0, reason: "output-source-store-unavailable" };
		}
	}

	async readOutputSource(sourceId: string, start: number, end: number): Promise<OutputSourceRead> {
		return this.ensureOutputStore().read(sourceId, { start, end });
	}

	onChange(listener: () => void): () => void {
		this.changeListeners.add(listener);
		return () => { this.changeListeners.delete(listener); };
	}

	private notifyChange(): void {
		for (const listener of this.changeListeners) {
			try {
				listener();
			} catch (error) {
				console.error("interactive-shell: change listener error:", error);
			}
		}
	}

	registerActive(session: ActiveSession): void {
		const cleanupTimer = this.cleanupTimers.get(session.id);
		if (cleanupTimer) {
			clearTimeout(cleanupTimer);
			this.cleanupTimers.delete(session.id);
		}
		this.activeSessions.set(session.id, session);
	}

	unregisterActive(id: string, releaseId = false): void {
		const cleanupTimer = this.cleanupTimers.get(id);
		if (cleanupTimer) {
			clearTimeout(cleanupTimer);
			this.cleanupTimers.delete(id);
		}
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

	add(command: string, session: PtyTerminalSession, name?: string, reason?: string, options?: { id?: string; noAutoCleanup?: boolean; startedAt?: Date }): string {
		const id = options?.id ?? generateSessionId(name);
		if (options?.id) usedIds.add(id);
		const entry: BackgroundSession = {
			id,
			name: name || deriveSessionName(command),
			explicitName: Boolean(name),
			command,
			reason,
			session,
			startedAt: options?.startedAt ?? new Date(),
		};

		this.storeBackgroundEntry(entry, options?.noAutoCleanup === true);
		return id;
	}

	restore(entry: BackgroundSession, options?: { noAutoCleanup?: boolean }): void {
		usedIds.add(entry.id);
		this.storeBackgroundEntry(entry, options?.noAutoCleanup === true);
	}

	private storeBackgroundEntry(entry: BackgroundSession, noAutoCleanup: boolean): void {
		this.sessions.set(entry.id, entry);
		entry.session.setEventHandlers({});

		if (!noAutoCleanup) {
			const checkExit = setInterval(() => {
				if (entry.session.exited) {
					clearInterval(checkExit);
					this.exitWatchers.delete(entry.id);
					this.notifyChange();
					const cleanupTimer = setTimeout(() => {
						this.cleanupTimers.delete(entry.id);
						this.remove(entry.id);
					}, 30000);
					this.cleanupTimers.set(entry.id, cleanupTimer);
				}
			}, 1000);
			this.exitWatchers.set(entry.id, checkExit);
		}

		this.notifyChange();
	}

	take(id: string): BackgroundSession | undefined {
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
			this.sessions.delete(id);
			this.notifyChange();
			return session;
		}
		return undefined;
	}

	get(id: string): BackgroundSession | undefined {
		// Suspend all auto-cleanup while session is being actively used
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
		return this.sessions.get(id);
	}

	restartAutoCleanup(id: string): void {
		if (this.exitWatchers.has(id)) return;
		const entry = this.sessions.get(id);
		if (!entry) return;
		if (entry.session.exited) {
			this.scheduleCleanup(id);
			return;
		}
		const checkExit = setInterval(() => {
			if (entry.session.exited) {
				clearInterval(checkExit);
				this.exitWatchers.delete(id);
				this.notifyChange();
				this.scheduleCleanup(id);
			}
		}, 1000);
		this.exitWatchers.set(id, checkExit);
	}

	scheduleCleanup(id: string, delayMs = 30000): void {
		if (this.cleanupTimers.has(id)) return;
		const timer = setTimeout(() => {
			this.cleanupTimers.delete(id);
			const activeSession = this.activeSessions.get(id);
			if (activeSession) {
				activeSession.dispose?.();
				this.unregisterActive(id, true);
				return;
			}
			this.remove(id);
		}, delayMs);
		this.cleanupTimers.set(id, timer);
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
			this.notifyChange();
		}
	}

	list(): BackgroundSession[] {
		return Array.from(this.sessions.values());
	}

	killAll(): void {
		// Kill all active hands-free sessions
		// Collect entries first since kill() may trigger unregisterActive()
		const activeEntries = Array.from(this.activeSessions.entries());
		for (const [, session] of activeEntries) {
			session.kill();
		}

		// Active and background maps can share a PtyTerminalSession. Cancel through
		// the active owner first, then dispose background storage idempotently.
		const bgIds = Array.from(this.sessions.keys());
		for (const id of bgIds) {
			this.remove(id);
			this.unregisterActive(id, false);
		}
		// Don't clear immediately - let unregisterActive() handle cleanup as sessions exit
		// This prevents ID reuse while processes are still terminating
	}
}

const SESSION_MANAGER_KEY = "__piInteractiveShellSessionManagerV1" as const;
const runtimeGlobal = globalThis as typeof globalThis & Partial<Record<typeof SESSION_MANAGER_KEY, ShellSessionManager>>;

const retainedSessionManager = runtimeGlobal[SESSION_MANAGER_KEY];
if (retainedSessionManager) Object.setPrototypeOf(retainedSessionManager, ShellSessionManager.prototype);
export const sessionManager = runtimeGlobal[SESSION_MANAGER_KEY] ??= retainedSessionManager ?? new ShellSessionManager();
sessionManager.ensureReloadState();

export function releaseSessionManagerSingleton(manager: ShellSessionManager): void {
	if (runtimeGlobal[SESSION_MANAGER_KEY] === manager) {
		manager.disposeOutputRetention();
		Reflect.deleteProperty(runtimeGlobal, SESSION_MANAGER_KEY);
	}
}
