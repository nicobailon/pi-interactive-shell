import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import type { InteractiveShellConfig } from "./config.js";
import { KittyClient, type KittyWindow } from "./kitty-client.js";
import { computeSnapshotDelta } from "./kitty-snapshot.js";
import { sliceLogOutput, trimRawOutput } from "./session-log.js";
import type { TerminalSession, TerminalSessionEvents, TerminalSessionOptions } from "./terminal-session.js";

export { computeSnapshotDelta } from "./kitty-snapshot.js";

const MANAGED_VAR = "pi_interactive_kitty=1";
const SESSION_VAR_PREFIX = "pi_interactive_kitty_session_id=";
const OS_WINDOW_VAR = "pi_interactive_kitty_os_window=1";
/** Consecutive RC poll failures before treating the session as exited (when exit file is absent). */
const MAX_CONSECUTIVE_POLL_FAILURES = 5;
const EXIT_BANNER_RE = /\[Process exited with code /;

class AsyncQueue {
	private queue = Promise.resolve();

	enqueue(fn: () => Promise<void> | void): Promise<void> {
		const run = this.queue.then(() => fn());
		this.queue = run.catch(() => undefined);
		return run;
	}
}

/** Serialize first-window discovery + launch across concurrent session starts. */
let launchLock: Promise<void> = Promise.resolve();

function withLaunchLock<T>(fn: () => Promise<T>): Promise<T> {
	const run = launchLock.then(fn, fn);
	launchLock = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

/** Last scrollback_lines value pushed to the controlled kitty via load-config -o. */
let appliedKittyScrollbackLines: number | undefined;

/**
 * Ensure the kitty instance creates new windows with the desired scrollback.
 * Implemented as `kitten @ load-config -o scrollback_lines=N` (CLI override form).
 * Cached so we do not reload config on every tab launch when the value is unchanged.
 */
async function ensureKittyScrollbackLines(client: KittyClient, lines: number): Promise<void> {
	const target = Math.trunc(lines);
	if (!Number.isFinite(target) || target === 0) return;
	if (appliedKittyScrollbackLines === target) return;
	await client.loadConfig({ overrides: [`scrollback_lines=${target}`] });
	appliedKittyScrollbackLines = target;
}

/** Test-only: reset process-local scrollback override cache. */
export function __resetKittyScrollbackCacheForTests(): void {
	appliedKittyScrollbackLines = undefined;
}

export class KittyTerminalSession implements TerminalSession {
	private client: KittyClient;
	private config: InteractiveShellConfig;
	private windowId = 0;
	private _pid = 0;
	private _cols: number;
	private _rows: number;
	private _exited = false;
	private _exitCode: number | null = null;
	private _signal: number | undefined;
	private dataHandler: ((data: string) => void) | undefined;
	private exitHandler: ((exitCode: number | null, signal?: number) => void) | undefined;
	private additionalDataListeners: Array<(data: string) => void> = [];
	private additionalExitListeners: Array<(exitCode: number | null, signal?: number) => void> = [];
	/** Cumulative stream for getRawStream / data listeners (append-only deltas only). */
	private rawOutput = "";
	/** Previous full get-text used solely for stream delta / rewrite detection. */
	private previousSnapshot = "";
	/** Last successful full get-text (fallback when the window is closed / RC fails). */
	private lastKittyText = "";
	private lastStreamPosition = 0;
	private scrollOffset = 0;
	private followBottom = true;
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private pollInFlight = false;
	private consecutivePollFailures = 0;
	private exitFile: string;
	private wrapperPath: string;
	private disposed = false;
	private launched = false;
	private queue = new AsyncQueue();
	/** Kitty scrollback_lines applied at launch (from options.scrollback or config.scrollbackLines). */
	private scrollbackLines: number;
	readonly ready: Promise<void>;

	constructor(options: TerminalSessionOptions, config: InteractiveShellConfig, events: TerminalSessionEvents = {}) {
		this.config = config;
		this.client = new KittyClient(config);
		this.dataHandler = events.onData;
		this.exitHandler = events.onExit;
		this._cols = options.cols ?? 120;
		this._rows = options.rows ?? 40;
		// Tail/viewport/log re-fetch from kitty; this value is pushed to kitty as
		// `scrollback_lines` via load-config -o so new windows keep enough history.
		this.scrollbackLines = options.scrollback ?? config.scrollbackLines;

		const sessionId = options.id ?? `session-${Date.now().toString(36)}`;
		const sessionDir = join(getAgentDir(), "cache", "interactive-kitty", "kitty", sanitizePathSegment(sessionId));
		mkdirSync(sessionDir, { recursive: true });
		this.exitFile = join(sessionDir, "exit-code.txt");
		this.wrapperPath = join(sessionDir, "runner.mjs");
		rmSync(this.exitFile, { force: true });
		writeFileSync(this.wrapperPath, buildRunnerScript(options.command, this.exitFile, options.shell), "utf8");

		this.ready = this.launch(options, sessionId).catch((error) => {
			if (!this._exited) {
				this.markExited(null);
			}
			throw error;
		});
	}

	get exited(): boolean {
		return this._exited;
	}

	get exitCode(): number | null {
		return this._exitCode;
	}

	get signal(): number | undefined {
		return this._signal;
	}

	get pid(): number {
		return this._pid;
	}

	get cols(): number {
		return this._cols;
	}

	get rows(): number {
		return this._rows;
	}

	setEventHandlers(events: TerminalSessionEvents): void {
		this.dataHandler = events.onData;
		this.exitHandler = events.onExit;
	}

	addDataListener(cb: (data: string) => void): () => void {
		this.additionalDataListeners.push(cb);
		return () => {
			const idx = this.additionalDataListeners.indexOf(cb);
			if (idx >= 0) this.additionalDataListeners.splice(idx, 1);
		};
	}

	addExitListener(cb: (exitCode: number | null, signal?: number) => void): () => void {
		this.additionalExitListeners.push(cb);
		return () => {
			const idx = this.additionalExitListeners.indexOf(cb);
			if (idx >= 0) this.additionalExitListeners.splice(idx, 1);
		};
	}

	write(data: string): void {
		void this.writeAsync(data).catch((error) => {
			console.error("interactive-shell: failed to write to kitty session:", error);
		});
	}

	async writeAsync(data: string): Promise<void> {
		if (!data) return;
		if (this._exited) throw new Error("session has exited");
		await this.queue.enqueue(async () => {
			await this.ready;
			if (this._exited) throw new Error("session has exited");
			await this.client.sendText(this.windowId, data);
		});
	}

	sendText(text: string): void {
		this.write(text);
	}

	sendKeys(keys: string[]): void {
		void this.sendKeysAsync(keys).catch((error) => {
			console.error("interactive-shell: failed to send keys to kitty session:", error);
		});
	}

	async sendKeysAsync(keys: string[]): Promise<void> {
		if (keys.length === 0) return;
		if (this._exited) throw new Error("session has exited");
		await this.queue.enqueue(async () => {
			await this.ready;
			if (this._exited) throw new Error("session has exited");
			await this.client.sendKeys(this.windowId, keys);
		});
	}

	paste(text: string): void {
		void this.pasteAsync(text).catch((error) => {
			console.error("interactive-shell: failed to paste into kitty session:", error);
		});
	}

	async pasteAsync(text: string): Promise<void> {
		if (this._exited) throw new Error("session has exited");
		await this.queue.enqueue(async () => {
			await this.ready;
			if (this._exited) throw new Error("session has exited");
			await this.client.sendText(this.windowId, text, { bracketedPaste: "enable" });
		});
	}

	async focus(): Promise<void> {
		await this.ready;
		await this.client.focusTabForWindow(this.windowId);
		await this.client.focusWindow(this.windowId);
	}

	/**
	 * Updates local cols/rows only. Kitty remote control does not resize the
	 * window from this path; values are also refreshed from `ls` metadata while polling.
	 */
	resize(cols: number, rows: number): void {
		if (cols < 1 || rows < 1) return;
		this._cols = cols;
		this._rows = rows;
	}

	async getViewportLines(options: { ansi?: boolean } = {}): Promise<string[]> {
		const all = await this.getAllLinesFromKitty(options.ansi === true);
		if (this.followBottom) {
			this.scrollOffset = 0;
		}
		const start = Math.max(0, all.length - this._rows - this.scrollOffset);
		const lines = all.slice(start, start + this._rows);
		while (lines.length < this._rows) lines.push("");
		return lines;
	}

	async getTailLines(options: { lines: number; ansi?: boolean; maxChars?: number }): Promise<{
		lines: string[];
		totalLinesInBuffer: number;
		truncatedByChars: boolean;
	}> {
		const lines = await this.getAllLinesFromKitty(options.ansi === true);
		const requested = Math.max(0, Math.trunc(options.lines));
		const start = Math.max(0, lines.length - requested);
		const out: string[] = [];
		let remaining = options.maxChars === undefined ? undefined : Math.max(0, Math.trunc(options.maxChars));
		let truncatedByChars = false;
		for (const line of lines.slice(start)) {
			if (remaining !== undefined) {
				if (remaining <= 0) {
					truncatedByChars = true;
					break;
				}
				remaining -= line.length;
			}
			out.push(line);
		}
		return {
			lines: out,
			totalLinesInBuffer: lines.length,
			truncatedByChars,
		};
	}

	getRawStream(options: { sinceLast?: boolean; stripAnsi?: boolean } = {}): string {
		const sinceLast = options.sinceLast === true;
		let output = sinceLast ? this.rawOutput.slice(this.lastStreamPosition) : this.rawOutput;
		if (sinceLast) this.lastStreamPosition = this.rawOutput.length;
		if (options.stripAnsi !== false && output) {
			output = stripVTControlCharacters(output);
		}
		return output;
	}

	async getLogSlice(options: { offset?: number; limit?: number; stripAnsi?: boolean } = {}) {
		const keepAnsi = options.stripAnsi === false;
		const source = await this.fetchKittyText({ ansi: true });
		return sliceLogOutput(keepAnsi ? source : stripVTControlCharacters(source), {
			...options,
			// Already stripped when needed; avoid double-strip.
			stripAnsi: false,
		});
	}

	scrollUp(lines: number): void {
		// Approximate from last known kitty text (sync path for scroll keys).
		const totalLines = this.linesFromText(this.lastKittyText || this.rawOutput, false).length;
		const maxScroll = Math.max(0, totalLines - this._rows);
		this.scrollOffset = Math.min(this.scrollOffset + lines, maxScroll);
		this.followBottom = false;
	}

	scrollDown(lines: number): void {
		this.scrollOffset = Math.max(0, this.scrollOffset - lines);
		if (this.scrollOffset === 0) this.followBottom = true;
	}

	scrollToBottom(): void {
		this.scrollOffset = 0;
		this.followBottom = true;
	}

	isScrolledUp(): boolean {
		return this.scrollOffset > 0;
	}

	kill(signal = "SIGTERM"): void {
		if (this._exited && this.disposed) return;
		// Send the signal through the queue so it can't be reordered with pending writes,
		// but run the exit-file wait/force-close OUTSIDE the queue so it doesn't block
		// other IO (writeAsync/pasteAsync) for up to killGraceMs while the child drains.
		const signalPromise = this.queue.enqueue(async () => {
			try {
				await this.ready;
				await this.client.signalChild(this.windowId, signal);
			} catch (error) {
				console.error("interactive-shell: failed to signal kitty child:", error);
			}
		});
		void (async () => {
			await signalPromise;
			// Wait up to killGraceMs for the runner to write the exit file (default 5s).
			// This preserves the real exit code/signal for callers that graceful-shutdown
			// slower than 1s (databases, servers with drain, agents flushing state).
			// Only force-close the window as a last resort when the runner is unresponsive.
			const graceMs = this.config.kitty?.killGraceMs ?? 5000;
			const deadline = Date.now() + graceMs;
			while (!this.disposed && !this._exited && Date.now() < deadline) {
				if (await this.tryFinalizeFromExitFile()) return;
				await this.sleep(100);
			}
			if (this.disposed || this._exited) return;
			// One last chance in case the file appeared during the sleep.
			if (await this.tryFinalizeFromExitFile()) return;
			void this.client.closeWindow(this.windowId).catch(() => {});
			this.markExited(null);
		})();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.stopPolling();
		if (this.windowId > 0) {
			void this.client.closeWindow(this.windowId).catch(() => {});
		}
		// Fire exit listeners so waiters (interactive tool calls, hands-free monitors)
		// don't hang when the session is dismissed while still running.
		if (!this._exited) {
			this.markExited(null);
		}
	}

	private async launch(options: TerminalSessionOptions, sessionId: string): Promise<void> {
		try {
			await withLaunchLock(async () => {
				// Apply scrollback_lines before creating the window so kitty allocates
				// history for this session (equivalent to `kitty -o scrollback_lines=N`
				// / `kitten @ load-config -o scrollback_lines=N`).
				await ensureKittyScrollbackLines(this.client, this.scrollbackLines).catch((error) => {
					const message = error instanceof Error ? error.message : String(error);
					console.error(
						`interactive-shell: failed to set kitty scrollback_lines=${this.scrollbackLines} (continuing with kitty default):`,
						message,
					);
				});
				const managed = await findManagedWindow(this.client);
				const isFirst = !managed;
				const title = options.title ?? `${this.config.kitty?.tabTitlePrefix ?? "pi-shell"}: ${sessionId}`;
				const payload = {
					args: [process.execPath, this.wrapperPath],
					type: isFirst ? ("os-window" as const) : ("tab" as const),
					match: managed ? `window_id:${managed.id}` : undefined,
					window_title: title,
					tab_title: title,
					os_window_title: isFirst ? (this.config.kitty?.osWindowTitle ?? "Pi Interactive Kitty") : undefined,
					cwd: options.cwd,
					keep_focus: !(options.focus ?? this.config.kitty?.focusNewSessions ?? true),
					var: [MANAGED_VAR, `${SESSION_VAR_PREFIX}${sessionId}`, ...(isFirst ? [OS_WINDOW_VAR] : [])],
					env: buildEnv(options.env),
				};
				this.windowId = await this.client.launch(payload);
				this.launched = true;
			});
			await this.refreshMetadata();
			this.startPolling();
			if (options.focus ?? this.config.kitty?.focusNewSessions ?? true) {
				await this.focus().catch(() => {});
			}
		} catch (error) {
			if (this.windowId > 0) {
				const orphanId = this.windowId;
				this.windowId = 0;
				this.launched = false;
				await this.client.closeWindow(orphanId).catch((closeError) => {
					console.error("interactive-shell: failed to close orphan kitty window after launch failure:", closeError);
				});
			}
			throw error;
		}
	}

	private startPolling(): void {
		this.stopPolling();
		this.pollTimer = setInterval(() => {
			void this.poll();
		}, this.config.kitty?.pollIntervalMs ?? 500);
		void this.poll();
	}

	private stopPolling(): void {
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
	}

	private async poll(): Promise<void> {
		if (this.disposed || !this.launched || this._exited || this.pollInFlight) return;
		this.pollInFlight = true;
		try {
			if (await this.tryFinalizeFromExitFile()) return;

			const text = await this.client.getText(this.windowId, { extent: "all", ansi: true });
			this.ingestSnapshot(text);
			const windowPresent = await this.refreshMetadata();
			if (!windowPresent) {
				if (await this.tryFinalizeFromExitFile()) return;
				this.consecutivePollFailures++;
				if (this.consecutivePollFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
					this.markExited(null);
				}
				return;
			}
			this.consecutivePollFailures = 0;
			await this.tryFinalizeFromExitFile();
		} catch (error) {
			if (this._exited || this.disposed) return;
			if (await this.tryFinalizeFromExitFile()) return;

			this.consecutivePollFailures++;
			const message = error instanceof Error ? error.message : String(error);
			console.error(
				`interactive-shell: kitty poll transient failure (${this.consecutivePollFailures}/${MAX_CONSECUTIVE_POLL_FAILURES}):`,
				message,
			);

			if (this.consecutivePollFailures < MAX_CONSECUTIVE_POLL_FAILURES) {
				return;
			}

			// Threshold reached: only mark exited if the window is gone or ls also fails.
			try {
				const all = await this.client.ls({ match: `id:${this.windowId}` });
				const window = flattenWindows(all).find((candidate) => candidate.id === this.windowId);
				if (!window) {
					this.markExited(null);
				} else {
					// Window still exists — keep retrying, but do not reset the counter fully
					// so sustained errors still eventually re-check.
					this.consecutivePollFailures = Math.max(0, MAX_CONSECUTIVE_POLL_FAILURES - 2);
				}
			} catch {
				this.markExited(null);
			}
		} finally {
			this.pollInFlight = false;
		}
	}

	/** If the runner exit file is present, capture a final snapshot and mark exited. */
	private async tryFinalizeFromExitFile(): Promise<boolean> {
		const exitStatus = this.readExitStatus();
		if (!exitStatus) return false;
		await this.captureFinalSnapshot();
		this.markExited(exitStatus.exitCode, exitStatus.signal);
		return true;
	}

	/**
	 * Ingest a full kitty get-text snapshot for the *stream* path only:
	 * compute append deltas / rewrite activity pulses into rawOutput + listeners.
	 * Tail/viewport/log do not read from these buffers — they re-fetch via get-text.
	 */
	private ingestSnapshot(snapshot: string): void {
		const next = snapshot.replace(/\r\n/g, "\n");
		const previous = this.previousSnapshot;
		if (next === previous) return;

		const { delta, rewrite } = computeSnapshotDelta(previous, next);
		this.previousSnapshot = next;
		this.lastKittyText = next;

		if (rewrite) {
			// Do not re-append full text to the stream on TUI rewrite / scrollback roll-off.
			if (!this.rawOutput) {
				this.rawOutput = next;
			}
			this.trimStreamBuffer();
			// Pulse activity listeners (quiet timers) without polluting the append-only stream.
			// ZWNJ is non-whitespace for trim() but invisible in tails/logs.
			if (stripVTControlCharacters(next).trim().length > 0) {
				this.notifyDataListeners("\u200c");
			}
			return;
		}

		if (!delta) return;
		this.rawOutput += delta;
		this.trimStreamBuffer();
		this.notifyDataListeners(delta);
	}

	/** Byte-cap the append-only stream only (not used as scrollback source of truth). */
	private trimStreamBuffer(): void {
		const trimmed = trimRawOutput(this.rawOutput, this.lastStreamPosition);
		this.rawOutput = trimmed.rawOutput;
		this.lastStreamPosition = trimmed.lastStreamPosition;
	}

	/**
	 * Live get-text for view APIs. Updates lastKittyText on success; falls back when
	 * the window is disposed/closed or RC fails.
	 */
	private async fetchKittyText(options: { ansi?: boolean } = {}): Promise<string> {
		const wantAnsi = options.ansi !== false;
		if (this.windowId > 0 && this.launched && !this.disposed) {
			try {
				const text = await this.client.getText(this.windowId, { extent: "all", ansi: true });
				const normalized = text.replace(/\r\n/g, "\n");
				this.lastKittyText = normalized;
				// Keep stream comparison baseline fresh when views outpace the poll loop.
				if (!this.previousSnapshot) {
					this.previousSnapshot = normalized;
				}
				return wantAnsi ? normalized : stripVTControlCharacters(normalized);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error("interactive-shell: live kitty get-text failed, using last snapshot:", message);
			}
		}
		const fallback = this.lastKittyText || this.rawOutput;
		return wantAnsi ? fallback : stripVTControlCharacters(fallback);
	}

	private async getAllLinesFromKitty(ansi: boolean): Promise<string[]> {
		const sourceText = await this.fetchKittyText({ ansi: true });
		return this.linesFromText(sourceText, ansi);
	}

	private linesFromText(sourceText: string, ansi: boolean): string[] {
		const source = ansi ? sourceText : stripVTControlCharacters(sourceText);
		const lines = source.replace(/\r\n/g, "\n").split("\n");
		if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
		return lines;
	}

	/** @returns true when the window was found and metadata updated */
	private async refreshMetadata(): Promise<boolean> {
		const all = await this.client.ls({ match: `id:${this.windowId}` });
		const window = flattenWindows(all).find((candidate) => candidate.id === this.windowId);
		if (!window) return false;
		this._pid = window.foreground_processes?.[0]?.pid ?? window.pid ?? this._pid;
		this._cols = window.columns ?? this._cols;
		this._rows = window.lines ?? this._rows;
		return true;
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	/**
	 * Capture get-text after the exit file appears. The runner writes the exit file
	 * before printing the exit banner, so we briefly wait and retry to avoid missing
	 * the last lines of output.
	 */
	private async captureFinalSnapshot(): Promise<void> {
		if (this.windowId <= 0) return;
		for (let attempt = 0; attempt < 2; attempt++) {
			await this.sleep(50);
			if (this.disposed || this.windowId <= 0 || this._exited) return;
			try {
				const text = await this.client.getText(this.windowId, { extent: "all", ansi: true });
				this.ingestSnapshot(text);
				if (EXIT_BANNER_RE.test(this.lastKittyText)) {
					return;
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error("interactive-shell: failed to capture final kitty snapshot:", message);
			}
		}
	}

	private readExitStatus(): { exitCode: number | null; signal?: number } | undefined {
		if (!existsSync(this.exitFile) || this._exited) return undefined;
		const raw = readFileSync(this.exitFile, "utf8").trim();
		const parts = raw.split(/\s+/).filter(Boolean);
		const code = Number(parts[0]);
		const signal = parts[1] !== undefined ? parseExitSignal(parts[1]) : undefined;
		return { exitCode: Number.isFinite(code) ? code : null, signal };
	}

	private markExited(exitCode: number | null, signal?: number): void {
		if (this._exited) return;
		this._exited = true;
		this._exitCode = exitCode;
		this._signal = signal;
		this.stopPolling();
		// Runner already prints an exit banner into the kitty tab; avoid a second marker
		// in the local stream unless nothing was captured yet. Tail APIs re-fetch from kitty
		// (or lastKittyText) and will see the real banner when present.
		const known = this.lastKittyText || this.rawOutput;
		if (!EXIT_BANNER_RE.test(known)) {
			const exitMsg = `\n[Process exited with code ${exitCode ?? "unknown"}${signal ? ` (signal: ${signal})` : ""}]\n`;
			this.rawOutput += exitMsg;
			this.lastKittyText = this.lastKittyText ? this.lastKittyText + exitMsg : this.rawOutput;
			this.previousSnapshot = this.lastKittyText;
			this.notifyDataListeners(exitMsg);
		}
		this.notifyExitListeners(exitCode, signal);
	}

	private notifyDataListeners(data: string): void {
		this.dataHandler?.(data);
		for (const listener of [...this.additionalDataListeners]) {
			listener(data);
		}
	}

	private notifyExitListeners(exitCode: number | null, signal?: number): void {
		this.exitHandler?.(exitCode, signal);
		for (const listener of [...this.additionalExitListeners]) {
			listener(exitCode, signal);
		}
	}
}

async function findManagedWindow(client: KittyClient): Promise<KittyWindow | undefined> {
	const all = await client.ls();
	const windows = flattenWindows(all);
	return (
		windows.find((window) => window.user_vars?.pi_interactive_kitty_os_window === "1") ??
		windows.find((window) => window.user_vars?.pi_interactive_kitty === "1")
	);
}

function flattenWindows(osWindows: Awaited<ReturnType<KittyClient["ls"]>>): KittyWindow[] {
	return osWindows.flatMap((osWindow) => osWindow.tabs.flatMap((tab) => tab.windows));
}

export function buildEnv(env?: Record<string, string | undefined>): string[] {
	const merged: Record<string, string | undefined> = { ...process.env, ...env };
	// Managed kitty children need kitty's terminfo. Do not inherit the parent shell's
	// TERM (often xterm-256color); only honor an explicit per-session override.
	merged.TERM = env?.TERM ?? "xterm-kitty";
	return Object.entries(merged)
		.filter((entry): entry is [string, string] => entry[1] !== undefined)
		.map(([key, value]) => `${key}=${value}`);
}

function sanitizePathSegment(value: string): string {
	return value.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80) || "session";
}

function buildRunnerScript(command: string, exitFile: string, shell?: string): string {
	const resolvedShell = shell ?? (process.platform === "win32" ? process.env.COMSPEC || "cmd.exe" : process.env.SHELL || "/bin/sh");
	const shellArgs = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];
	return `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const child = spawn(${JSON.stringify(resolvedShell)}, ${JSON.stringify(shellArgs)}, {
  stdio: "inherit",
  env: process.env,
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}

child.on("exit", (code, signal) => {
  const exitCode = code ?? (signal ? 128 : 1);
  // Format: "<code>" or "<code> <signalName>" — session poller parses both.
  try { writeFileSync(${JSON.stringify(exitFile)}, signal ? (exitCode + " " + signal) : String(exitCode)); } catch {}
  console.log("");
  console.log("[Process exited with code " + exitCode + (signal ? " (signal: " + signal + ")" : "") + "]");
  process.stdin.resume();
});
`;
}

const SIGNAL_NUMBERS: Record<string, number> = {
	SIGHUP: 1,
	SIGINT: 2,
	SIGQUIT: 3,
	SIGKILL: 9,
	SIGTERM: 15,
};

function parseExitSignal(token: string): number | undefined {
	const asNumber = Number(token);
	if (Number.isFinite(asNumber)) return asNumber;
	return SIGNAL_NUMBERS[token.toUpperCase()];
}
