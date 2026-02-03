import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Component, Focusable, TUI } from "@mariozechner/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { PtyTerminalSession } from "./pty-session.js";
import { sessionManager, generateSessionId } from "./session-manager.js";
import type { InteractiveShellConfig } from "./config.js";
import {
	type InteractiveShellResult,
	type HandsFreeUpdate,
	type InteractiveShellOptions,
	type DialogChoice,
	type OverlayState,
	CHROME_LINES,
	FOOTER_LINES,
	formatDuration,
} from "./types.js";

export class InteractiveShellOverlay implements Component, Focusable {
	focused = false;

	private tui: TUI;
	private theme: Theme;
	private done: (result: InteractiveShellResult) => void;
	private session: PtyTerminalSession;
	private options: InteractiveShellOptions;
	private config: InteractiveShellConfig;

	private state: OverlayState = "running";
	private dialogSelection: DialogChoice = "transfer";
	private exitCountdown = 0;
	private countdownInterval: ReturnType<typeof setInterval> | null = null;
	private lastWidth = 0;
	private lastHeight = 0;
	// Hands-free mode
	private userTookOver = false;
	private handsFreeInterval: ReturnType<typeof setInterval> | null = null;
	private handsFreeInitialTimeout: ReturnType<typeof setTimeout> | null = null;
	private startTime = Date.now();
	private sessionId: string | null = null;
	private sessionUnregistered = false;
	// Timeout
	private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
	// Prevent double done() calls
	private finished = false;
	// Budget tracking for hands-free updates
	private totalCharsSent = 0;
	private budgetExhausted = false;
	private currentUpdateInterval: number;
	private currentQuietThreshold: number;
	private updateMode: "on-quiet" | "interval";
	private quietTimer: ReturnType<typeof setTimeout> | null = null;
	private hasUnsentData = false;
	// Non-blocking mode: track status for agent queries
	private completionResult: InteractiveShellResult | undefined;
	// Rate limiting for queries
	private lastQueryTime = 0;
	// Incremental read position (for incremental: true queries)
	private incrementalReadPosition = 0;
	// Completion callbacks for waiters
	private completeCallbacks: Array<() => void> = [];
	// Simple render throttle to reduce flicker
	private renderTimeout: ReturnType<typeof setTimeout> | null = null;

	constructor(
		tui: TUI,
		theme: Theme,
		options: InteractiveShellOptions,
		config: InteractiveShellConfig,
		done: (result: InteractiveShellResult) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.options = options;
		this.config = config;
		this.done = done;

		const overlayWidth = Math.floor((tui.terminal.columns * this.config.overlayWidthPercent) / 100);
		const overlayHeight = Math.floor((tui.terminal.rows * this.config.overlayHeightPercent) / 100);
		const cols = Math.max(20, overlayWidth - 4);
		const rows = Math.max(3, overlayHeight - CHROME_LINES);

		const ptyEvents = {
			onData: () => {
				this.debouncedRender();
				if (this.state === "hands-free" && this.updateMode === "on-quiet") {
					this.hasUnsentData = true;
					this.resetQuietTimer();
				}
			},
			onExit: () => {
				if (this.finished) return;
				this.stopTimeout();

				if (this.state === "hands-free" && this.sessionId) {
					if (this.hasUnsentData || this.updateMode === "interval") {
						this.emitHandsFreeUpdate();
						this.hasUnsentData = false;
					}
					if (this.options.onHandsFreeUpdate) {
						this.options.onHandsFreeUpdate({
							status: "exited",
							sessionId: this.sessionId,
							runtime: Date.now() - this.startTime,
							tail: [],
							tailTruncated: false,
							totalCharsSent: this.totalCharsSent,
							budgetExhausted: this.budgetExhausted,
						});
					}
					this.finishWithExit();
					return;
				}

				this.stopHandsFreeUpdates();
				this.state = "exited";
				this.exitCountdown = this.config.exitAutoCloseDelay;
				this.startExitCountdown();
				this.tui.requestRender();
			},
		};

		if (options.existingSession) {
			this.session = options.existingSession;
			this.session.setEventHandlers(ptyEvents);
			this.session.resize(cols, rows);
		} else {
			this.session = new PtyTerminalSession(
				{
					command: options.command,
					cwd: options.cwd,
					cols,
					rows,
					scrollback: this.config.scrollbackLines,
					ansiReemit: this.config.ansiReemit,
				},
				ptyEvents,
			);
		}

		// Initialize hands-free mode settings
		this.updateMode = options.handsFreeUpdateMode ?? config.handsFreeUpdateMode;
		this.currentUpdateInterval = options.handsFreeUpdateInterval ?? config.handsFreeUpdateInterval;
		this.currentQuietThreshold = options.handsFreeQuietThreshold ?? config.handsFreeQuietThreshold;

		if (options.mode === "hands-free" || options.mode === "dispatch") {
			this.state = "hands-free";
			this.sessionId = options.sessionId ?? generateSessionId(options.name);
			sessionManager.registerActive({
				id: this.sessionId,
				command: options.command,
				reason: options.reason,
				write: (data) => this.session.write(data),
				kill: () => this.killSession(),
				background: () => this.backgroundSession(),
				getOutput: (options) => this.getOutputSinceLastCheck(options),
				getStatus: () => this.getSessionStatus(),
				getRuntime: () => this.getRuntime(),
				getResult: () => this.getCompletionResult(),
				setUpdateInterval: (intervalMs) => this.setUpdateInterval(intervalMs),
				setQuietThreshold: (thresholdMs) => this.setQuietThreshold(thresholdMs),
				onComplete: (callback) => this.registerCompleteCallback(callback),
			});
			this.startHandsFreeUpdates();
		}

		if (options.timeout && options.timeout > 0) {
			this.timeoutTimer = setTimeout(() => {
				this.finishWithTimeout();
			}, options.timeout);
		}

		if (options.existingSession && options.existingSession.exited) {
			queueMicrotask(() => {
				if (this.finished) return;
				this.stopTimeout();
				if (this.state === "hands-free" && this.sessionId) {
					if (this.options.onHandsFreeUpdate) {
						this.options.onHandsFreeUpdate({
							status: "exited",
							sessionId: this.sessionId,
							runtime: Date.now() - this.startTime,
							tail: [],
							tailTruncated: false,
							totalCharsSent: this.totalCharsSent,
							budgetExhausted: this.budgetExhausted,
						});
					}
					this.finishWithExit();
				} else {
					this.stopHandsFreeUpdates();
					this.state = "exited";
					this.exitCountdown = this.config.exitAutoCloseDelay;
					this.startExitCountdown();
					this.tui.requestRender();
				}
			});
		}
	}

	// Public methods for non-blocking mode (agent queries)

	// Default output limits per status query
	private static readonly DEFAULT_STATUS_OUTPUT = 5 * 1024; // 5KB
	private static readonly DEFAULT_STATUS_LINES = 20;
	private static readonly MAX_STATUS_OUTPUT = 50 * 1024; // 50KB max
	private static readonly MAX_STATUS_LINES = 200; // 200 lines max

	/** Get rendered terminal output (last N lines, truncated if too large) */
	getOutputSinceLastCheck(options: { skipRateLimit?: boolean; lines?: number; maxChars?: number; offset?: number; drain?: boolean; incremental?: boolean } | boolean = false): { output: string; truncated: boolean; totalBytes: number; totalLines?: number; hasMore?: boolean; rateLimited?: boolean; waitSeconds?: number } {
		if (this.finished) {
			if (this.completionResult?.completionOutput) {
				const lines = this.completionResult.completionOutput.lines;
				const output = lines.join("\n");
				return {
					output,
					truncated: this.completionResult.completionOutput.truncated,
					totalBytes: output.length,
					totalLines: this.completionResult.completionOutput.totalLines,
				};
			}
			return { output: "", truncated: false, totalBytes: 0 };
		}

		// Handle legacy boolean parameter
		const opts = typeof options === "boolean" ? { skipRateLimit: options } : options;
		const skipRateLimit = opts.skipRateLimit ?? false;
		// Clamp lines and maxChars to valid ranges (1 to MAX)
		const requestedLines = Math.max(1, Math.min(
			opts.lines ?? InteractiveShellOverlay.DEFAULT_STATUS_LINES,
			InteractiveShellOverlay.MAX_STATUS_LINES
		));
		const requestedMaxChars = Math.max(1, Math.min(
			opts.maxChars ?? InteractiveShellOverlay.DEFAULT_STATUS_OUTPUT,
			InteractiveShellOverlay.MAX_STATUS_OUTPUT
		));

		// Check rate limiting (unless skipped, e.g., for completed sessions)
		if (!skipRateLimit) {
			const now = Date.now();
			const minIntervalMs = this.config.minQueryIntervalSeconds * 1000;
			const elapsed = now - this.lastQueryTime;

			if (this.lastQueryTime > 0 && elapsed < minIntervalMs) {
				const waitSeconds = Math.ceil((minIntervalMs - elapsed) / 1000);
				return {
					output: "",
					truncated: false,
					totalBytes: 0,
					rateLimited: true,
					waitSeconds,
				};
			}

			// Update last query time
			this.lastQueryTime = now;
		}

		// Incremental mode: return next N lines agent hasn't seen yet
		// Server tracks position - agent just keeps calling with incremental: true
		if (opts.incremental) {
			const result = this.session.getLogSlice({
				offset: this.incrementalReadPosition,
				limit: requestedLines,
				stripAnsi: true,
			});
			// Use sliceLineCount directly - handles empty lines correctly
			// (counting newlines in slice fails for empty lines like "")
			const linesFromSlice = result.sliceLineCount;
			// Apply maxChars limit (may truncate mid-line, but we still advance past it)
			const truncatedByChars = result.slice.length > requestedMaxChars;
			const output = truncatedByChars ? result.slice.slice(0, requestedMaxChars) : result.slice;
			// Update position for next incremental read
			this.incrementalReadPosition += linesFromSlice;
			const hasMore = this.incrementalReadPosition < result.totalLines;
			return {
				output,
				truncated: truncatedByChars,
				totalBytes: output.length,
				totalLines: result.totalLines,
				hasMore,
			};
		}

		// Drain mode: return only NEW output since last query (raw stream, not lines)
		// This is more token-efficient than re-reading the tail each time
		if (opts.drain) {
			const newOutput = this.session.getRawStream({ sinceLast: true, stripAnsi: true });
			// Truncate if exceeds maxChars
			const truncated = newOutput.length > requestedMaxChars;
			const output = truncated ? newOutput.slice(-requestedMaxChars) : newOutput;
			return {
				output,
				truncated,
				totalBytes: output.length,
			};
		}

		// Offset mode: use getLogSlice for pagination through full output
		if (opts.offset !== undefined) {
			const result = this.session.getLogSlice({
				offset: opts.offset,
				limit: requestedLines,
				stripAnsi: true,
			});
			// Apply maxChars limit
			const truncatedByChars = result.slice.length > requestedMaxChars;
			const output = truncatedByChars ? result.slice.slice(0, requestedMaxChars) : result.slice;
			// Calculate hasMore based on whether there are more lines after this slice
			const hasMore = (opts.offset + result.sliceLineCount) < result.totalLines;
			return {
				output,
				truncated: truncatedByChars || result.sliceLineCount >= requestedLines,
				totalBytes: output.length,
				totalLines: result.totalLines,
				hasMore,
			};
		}

		// Default: Use rendered terminal output (tail)
		// This gives clean, readable content without TUI animation garbage
		const tailResult = this.session.getTailLines({
			lines: requestedLines,
			ansi: false,
			maxChars: requestedMaxChars,
		});

		const output = tailResult.lines.join("\n");
		const totalBytes = output.length;
		const truncated = tailResult.lines.length >= requestedLines || tailResult.truncatedByChars;

		return { output, truncated, totalBytes, totalLines: tailResult.totalLinesInBuffer };
	}

	/** Get current session status */
	getSessionStatus(): "running" | "user-takeover" | "exited" | "killed" | "backgrounded" {
		if (this.completionResult) {
			if (this.completionResult.cancelled) return "killed";
			if (this.completionResult.backgrounded) return "backgrounded";
			if (this.userTookOver) return "user-takeover";
			return "exited";
		}
		if (this.userTookOver) return "user-takeover";
		if (this.state === "exited") return "exited";
		return "running";
	}

	/** Get runtime in milliseconds */
	getRuntime(): number {
		return Date.now() - this.startTime;
	}

	/** Get completion result (if session has ended) */
	getCompletionResult(): InteractiveShellResult | undefined {
		return this.completionResult;
	}

	/** Register a callback to be called when session completes */
	registerCompleteCallback(callback: () => void): void {
		// If already completed, call immediately
		if (this.completionResult) {
			callback();
			return;
		}
		this.completeCallbacks.push(callback);
	}

	/** Trigger all completion callbacks */
	private triggerCompleteCallbacks(): void {
		for (const callback of this.completeCallbacks) {
			try {
				callback();
			} catch {
				// Ignore errors in callbacks
			}
		}
		this.completeCallbacks = [];
	}

	/** Debounced render - waits for data to settle before rendering */
	private debouncedRender(): void {
		if (this.renderTimeout) {
			clearTimeout(this.renderTimeout);
		}
		// Wait 16ms for more data before rendering
		this.renderTimeout = setTimeout(() => {
			this.renderTimeout = null;
			this.tui.requestRender();
		}, 16);
	}

	/** Kill the session programmatically */
	killSession(): void {
		if (!this.finished) {
			this.finishWithKill();
		}
	}

	private startExitCountdown(): void {
		this.stopCountdown();
		this.countdownInterval = setInterval(() => {
			this.exitCountdown--;
			if (this.exitCountdown <= 0) {
				this.finishWithExit();
			} else {
				this.tui.requestRender();
			}
		}, 1000);
	}

	private stopCountdown(): void {
		if (this.countdownInterval) {
			clearInterval(this.countdownInterval);
			this.countdownInterval = null;
		}
	}

	private startHandsFreeUpdates(): void {
		// Send initial update after a short delay (let process start)
		this.handsFreeInitialTimeout = setTimeout(() => {
			this.handsFreeInitialTimeout = null;
			if (this.state === "hands-free") {
				this.emitHandsFreeUpdate();
			}
		}, 2000);

		this.handsFreeInterval = setInterval(() => {
			if (this.state === "hands-free") {
				if (this.updateMode === "on-quiet") {
					if (this.hasUnsentData && this.options.onHandsFreeUpdate) {
						this.emitHandsFreeUpdate();
						this.hasUnsentData = false;
						this.stopQuietTimer();
					}
				} else {
					this.emitHandsFreeUpdate();
				}
			}
		}, this.currentUpdateInterval);
	}

	/** Reset the quiet timer - called on each data event in on-quiet mode */
	private resetQuietTimer(): void {
		this.stopQuietTimer();
		this.quietTimer = setTimeout(() => {
			this.quietTimer = null;
			if (this.state === "hands-free") {
				// Auto-exit on quiet: kill session when output stops (agent likely finished task)
				if (this.options.autoExitOnQuiet) {
					// Emit final update with any pending output
					if (this.hasUnsentData) {
						this.emitHandsFreeUpdate();
						this.hasUnsentData = false;
					}
					// Send completion notification and auto-close
					// Use "killed" status since we're forcibly terminating (matches finishWithKill's cancelled=true)
					if (this.options.onHandsFreeUpdate && this.sessionId) {
						this.options.onHandsFreeUpdate({
							status: "killed",
							sessionId: this.sessionId,
							runtime: Date.now() - this.startTime,
							tail: [],
							tailTruncated: false,
							totalCharsSent: this.totalCharsSent,
							budgetExhausted: this.budgetExhausted,
						});
					}
					this.finishWithKill();
					return;
				}
				// Normal behavior: just emit update
				if (this.hasUnsentData) {
					this.emitHandsFreeUpdate();
					this.hasUnsentData = false;
				}
			}
		}, this.currentQuietThreshold);
	}

	private stopQuietTimer(): void {
		if (this.quietTimer) {
			clearTimeout(this.quietTimer);
			this.quietTimer = null;
		}
	}

	/** Update the hands-free update interval dynamically */
	setUpdateInterval(intervalMs: number): void {
		const clamped = Math.max(5000, Math.min(300000, intervalMs));
		if (clamped === this.currentUpdateInterval) return;
		this.currentUpdateInterval = clamped;

		if (this.handsFreeInterval) {
			clearInterval(this.handsFreeInterval);
			this.handsFreeInterval = setInterval(() => {
				if (this.state === "hands-free") {
					if (this.updateMode === "on-quiet") {
						if (this.hasUnsentData && this.options.onHandsFreeUpdate) {
							this.emitHandsFreeUpdate();
							this.hasUnsentData = false;
							this.stopQuietTimer();
						}
					} else {
						this.emitHandsFreeUpdate();
					}
				}
			}, this.currentUpdateInterval);
		}
	}

	/** Update the quiet threshold dynamically */
	setQuietThreshold(thresholdMs: number): void {
		const clamped = Math.max(1000, Math.min(30000, thresholdMs));
		if (clamped === this.currentQuietThreshold) return;
		this.currentQuietThreshold = clamped;

		// If a quiet timer is active, restart it with the new threshold
		// Use resetQuietTimer to ensure autoExitOnQuiet logic is included
		if (this.quietTimer && this.updateMode === "on-quiet") {
			this.resetQuietTimer();
		}
	}

	private stopHandsFreeUpdates(): void {
		if (this.handsFreeInitialTimeout) {
			clearTimeout(this.handsFreeInitialTimeout);
			this.handsFreeInitialTimeout = null;
		}
		if (this.handsFreeInterval) {
			clearInterval(this.handsFreeInterval);
			this.handsFreeInterval = null;
		}
		this.stopQuietTimer();
	}

	private stopTimeout(): void {
		if (this.timeoutTimer) {
			clearTimeout(this.timeoutTimer);
			this.timeoutTimer = null;
		}
	}

	private unregisterActiveSession(releaseId = false): void {
		if (this.sessionId && !this.sessionUnregistered) {
			sessionManager.unregisterActive(this.sessionId, releaseId);
			this.sessionUnregistered = true;
		}
	}

	private emitHandsFreeUpdate(): void {
		if (!this.options.onHandsFreeUpdate || !this.sessionId) return;

		const maxChars = this.options.handsFreeUpdateMaxChars ?? this.config.handsFreeUpdateMaxChars;
		const maxTotalChars = this.options.handsFreeMaxTotalChars ?? this.config.handsFreeMaxTotalChars;

		let tail: string[] = [];
		let truncated = false;

		// Only include content if budget not exhausted
		if (!this.budgetExhausted) {
			// Get incremental output since last update
			let newOutput = this.session.getRawStream({ sinceLast: true, stripAnsi: true });

			// Truncate if exceeds per-update limit
			if (newOutput.length > maxChars) {
				newOutput = newOutput.slice(-maxChars);
				truncated = true;
			}

			// Check total budget
			if (this.totalCharsSent + newOutput.length > maxTotalChars) {
				// Truncate to fit remaining budget
				const remaining = maxTotalChars - this.totalCharsSent;
				if (remaining > 0) {
					newOutput = newOutput.slice(-remaining);
					truncated = true;
				} else {
					newOutput = "";
				}
				this.budgetExhausted = true;
			}

			if (newOutput.length > 0) {
				this.totalCharsSent += newOutput.length;
				// Split into lines for the tail array
				tail = newOutput.split("\n");
			}
		}

		this.options.onHandsFreeUpdate({
			status: "running",
			sessionId: this.sessionId,
			runtime: Date.now() - this.startTime,
			tail,
			tailTruncated: truncated,
			totalCharsSent: this.totalCharsSent,
			budgetExhausted: this.budgetExhausted,
		});
	}

	private triggerUserTakeover(): void {
		if (this.state !== "hands-free" || !this.sessionId) return;

		// Flush any pending output before stopping updates
		// In interval mode, hasUnsentData is not tracked, so always flush
		if (this.hasUnsentData || this.updateMode === "interval") {
			this.emitHandsFreeUpdate();
			this.hasUnsentData = false;
		}

		this.stopHandsFreeUpdates();
		this.state = "running";
		this.userTookOver = true;

		// Notify agent that user took over (streaming mode)
		// In non-blocking mode, keep session registered so agent can query status
		if (this.options.onHandsFreeUpdate) {
			this.options.onHandsFreeUpdate({
				status: "user-takeover",
				sessionId: this.sessionId,
				runtime: Date.now() - this.startTime,
				tail: [],
				tailTruncated: false,
				userTookOver: true,
				totalCharsSent: this.totalCharsSent,
				budgetExhausted: this.budgetExhausted,
			});
			// Unregister and release ID in streaming mode - agent got notified, won't query
			this.unregisterActiveSession(true);
		}
		// In non-blocking mode (no onHandsFreeUpdate), keep session registered
		// so agent can query and see "user-takeover" status

		this.tui.requestRender();
	}

	/** Capture output for dispatch completion notifications */
	private captureCompletionOutput(): InteractiveShellResult["completionOutput"] {
		const result = this.session.getTailLines({
			lines: this.config.completionNotifyLines,
			ansi: false,
			maxChars: this.config.completionNotifyMaxChars,
		});
		return {
			lines: result.lines,
			totalLines: result.totalLinesInBuffer,
			truncated: result.lines.length < result.totalLinesInBuffer || result.truncatedByChars,
		};
	}

	/** Capture output for transfer action (Ctrl+T or dialog) */
	private captureTransferOutput(): InteractiveShellResult["transferred"] {
		const maxLines = this.config.transferLines;
		const maxChars = this.config.transferMaxChars;

		const result = this.session.getTailLines({
			lines: maxLines,
			ansi: false,
			maxChars,
		});

		const truncated = result.lines.length < result.totalLinesInBuffer || result.truncatedByChars;

		return {
			lines: result.lines,
			totalLines: result.totalLinesInBuffer,
			truncated,
		};
	}

	private maybeBuildHandoffPreview(when: "exit" | "detach" | "kill" | "timeout" | "transfer"): InteractiveShellResult["handoffPreview"] | undefined {
		const enabled = this.options.handoffPreviewEnabled ?? this.config.handoffPreviewEnabled;
		if (!enabled) return undefined;

		const lines = this.options.handoffPreviewLines ?? this.config.handoffPreviewLines;
		const maxChars = this.options.handoffPreviewMaxChars ?? this.config.handoffPreviewMaxChars;
		if (lines <= 0 || maxChars <= 0) return undefined;

		const result = this.session.getTailLines({
			lines,
			ansi: false,
			maxChars,
		});

		return { type: "tail", when, lines: result.lines };
	}

	private maybeWriteHandoffSnapshot(when: "exit" | "detach" | "kill" | "timeout" | "transfer"): InteractiveShellResult["handoff"] | undefined {
		const enabled = this.options.handoffSnapshotEnabled ?? this.config.handoffSnapshotEnabled;
		if (!enabled) return undefined;

		const lines = this.options.handoffSnapshotLines ?? this.config.handoffSnapshotLines;
		const maxChars = this.options.handoffSnapshotMaxChars ?? this.config.handoffSnapshotMaxChars;
		if (lines <= 0 || maxChars <= 0) return undefined;

		const baseDir = join(homedir(), ".pi", "agent", "cache", "interactive-shell");
		mkdirSync(baseDir, { recursive: true });

		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		const pid = this.session.pid;
		const filename = `snapshot-${timestamp}-pid${pid}.log`;
		const transcriptPath = join(baseDir, filename);

		const tailResult = this.session.getTailLines({
			lines,
			ansi: this.config.ansiReemit,
			maxChars,
		});

		const header = [
			`# interactive-shell snapshot (${when})`,
			`time: ${new Date().toISOString()}`,
			`command: ${this.options.command}`,
			`cwd: ${this.options.cwd ?? ""}`,
			`pid: ${pid}`,
			`exitCode: ${this.session.exitCode ?? ""}`,
			`signal: ${this.session.signal ?? ""}`,
			`lines: ${tailResult.lines.length} (requested ${lines}, maxChars ${maxChars})`,
			"",
		].join("\n");

		writeFileSync(transcriptPath, header + tailResult.lines.join("\n") + "\n", { encoding: "utf-8" });

		return { type: "snapshot", when, transcriptPath, linesWritten: tailResult.lines.length };
	}

	private finishWithExit(): void {
		if (this.finished) return;
		this.finished = true;
		this.stopCountdown();
		this.stopTimeout();
		this.stopHandsFreeUpdates();

		const handoffPreview = this.maybeBuildHandoffPreview("exit");
		const handoff = this.maybeWriteHandoffSnapshot("exit");
		const completionOutput = this.captureCompletionOutput();
		this.session.dispose();
		const result: InteractiveShellResult = {
			exitCode: this.session.exitCode,
			signal: this.session.signal,
			backgrounded: false,
			cancelled: false,
			sessionId: this.sessionId ?? undefined,
			userTookOver: this.userTookOver,
			completionOutput,
			handoffPreview,
			handoff,
		};
		this.completionResult = result;
		this.triggerCompleteCallbacks();

		// In non-blocking mode (no onHandsFreeUpdate), keep session registered
		// so agent can query completion result. Agent's query will unregister.
		// In streaming mode, unregister now since agent got final update.
		if (this.options.onHandsFreeUpdate) {
			this.unregisterActiveSession(true);
		}

		this.done(result);
	}

	backgroundSession(): void {
		this.finishWithBackground();
	}

	private finishWithBackground(): void {
		if (this.finished) return;
		this.finished = true;
		this.stopCountdown();
		this.stopTimeout();
		this.stopHandsFreeUpdates();

		const handoffPreview = this.maybeBuildHandoffPreview("detach");
		const handoff = this.maybeWriteHandoffSnapshot("detach");
		const addOptions = this.sessionId
			? { id: this.sessionId, noAutoCleanup: this.options.mode === "dispatch" }
			: undefined;
		const id = sessionManager.add(this.options.command, this.session, this.options.name, this.options.reason, addOptions);
		const result: InteractiveShellResult = {
			exitCode: null,
			backgrounded: true,
			backgroundId: id,
			cancelled: false,
			sessionId: this.sessionId ?? undefined,
			userTookOver: this.userTookOver,
			handoffPreview,
			handoff,
		};
		this.completionResult = result;
		this.triggerCompleteCallbacks();

		// In non-blocking mode (no onHandsFreeUpdate), keep session registered
		// so agent can query completion result. Agent's query will unregister.
		// Use releaseId=false because the background session now owns the ID.
		if (this.options.onHandsFreeUpdate) {
			this.unregisterActiveSession(false);
		}

		this.done(result);
	}

	private finishWithKill(): void {
		if (this.finished) return;
		this.finished = true;
		this.stopCountdown();
		this.stopTimeout();
		this.stopHandsFreeUpdates();

		const handoffPreview = this.maybeBuildHandoffPreview("kill");
		const handoff = this.maybeWriteHandoffSnapshot("kill");
		const completionOutput = this.captureCompletionOutput();
		this.session.kill();
		this.session.dispose();
		const result: InteractiveShellResult = {
			exitCode: null,
			backgrounded: false,
			cancelled: true,
			sessionId: this.sessionId ?? undefined,
			userTookOver: this.userTookOver,
			completionOutput,
			handoffPreview,
			handoff,
		};
		this.completionResult = result;
		this.triggerCompleteCallbacks();

		// In non-blocking mode (no onHandsFreeUpdate), keep session registered
		// so agent can query completion result. Agent's query will unregister.
		if (this.options.onHandsFreeUpdate) {
			this.unregisterActiveSession(true);
		}

		this.done(result);
	}

	private finishWithTransfer(): void {
		if (this.finished) return;
		this.finished = true;
		this.stopCountdown();
		this.stopTimeout();
		this.stopHandsFreeUpdates();

		// Capture output BEFORE killing the session
		const transferred = this.captureTransferOutput();
		const completionOutput = this.captureCompletionOutput();
		const handoffPreview = this.maybeBuildHandoffPreview("transfer");
		const handoff = this.maybeWriteHandoffSnapshot("transfer");

		this.session.kill();
		this.session.dispose();
		const result: InteractiveShellResult = {
			exitCode: this.session.exitCode,
			signal: this.session.signal,
			backgrounded: false,
			cancelled: false,
			sessionId: this.sessionId ?? undefined,
			userTookOver: this.userTookOver,
			transferred,
			completionOutput,
			handoffPreview,
			handoff,
		};
		this.completionResult = result;
		this.triggerCompleteCallbacks();

		// In non-blocking mode (no onHandsFreeUpdate), keep session registered
		// so agent can query completion result. Agent's query will unregister.
		if (this.options.onHandsFreeUpdate) {
			this.unregisterActiveSession(true);
		}

		this.done(result);
	}

	private finishWithTimeout(): void {
		if (this.finished) return;
		this.finished = true;
		this.stopCountdown();
		this.stopTimeout();

		// Send final update with any unsent data, then "exited" notification (for timeout)
		if (this.state === "hands-free" && this.options.onHandsFreeUpdate && this.sessionId) {
			// Flush any pending output before sending exited notification
			if (this.hasUnsentData || this.updateMode === "interval") {
				this.emitHandsFreeUpdate();
				this.hasUnsentData = false;
			}
			// Now send exited notification (timedOut is indicated in final tool result)
			this.options.onHandsFreeUpdate({
				status: "exited",
				sessionId: this.sessionId,
				runtime: Date.now() - this.startTime,
				tail: [],
				tailTruncated: false,
				totalCharsSent: this.totalCharsSent,
				budgetExhausted: this.budgetExhausted,
			});
		}

		this.stopHandsFreeUpdates();
		const handoffPreview = this.maybeBuildHandoffPreview("timeout");
		const handoff = this.maybeWriteHandoffSnapshot("timeout");
		const completionOutput = this.captureCompletionOutput();
		this.session.kill();
		this.session.dispose();
		const result: InteractiveShellResult = {
			exitCode: null,
			backgrounded: false,
			cancelled: false,
			timedOut: true,
			sessionId: this.sessionId ?? undefined,
			userTookOver: this.userTookOver,
			completionOutput,
			handoffPreview,
			handoff,
		};
		this.completionResult = result;
		this.triggerCompleteCallbacks();

		// In non-blocking mode (no onHandsFreeUpdate), keep session registered
		// so agent can query completion result. Agent's query will unregister.
		if (this.options.onHandsFreeUpdate) {
			this.unregisterActiveSession(true);
		}

		this.done(result);
	}

	handleInput(data: string): void {
		if (this.state === "detach-dialog") {
			this.handleDialogInput(data);
			return;
		}

		// Ctrl+T: Quick transfer - capture output and close (works in all states including "exited")
		if (matchesKey(data, "ctrl+t")) {
			// If in hands-free mode, trigger takeover first (notifies agent)
			if (this.state === "hands-free") {
				this.triggerUserTakeover();
			}
			this.finishWithTransfer();
			return;
		}

		// Ctrl+B: Quick background - dismiss overlay, keep process running
		if (matchesKey(data, "ctrl+b") && !this.session.exited) {
			if (this.state === "hands-free") {
				this.triggerUserTakeover();
			}
			this.finishWithBackground();
			return;
		}

		if (this.state === "exited") {
			if (data.length > 0) {
				this.finishWithExit();
			}
			return;
		}

		// Ctrl+Q opens detach dialog (works in both hands-free and running)
		if (matchesKey(data, "ctrl+q")) {
			// If in hands-free mode, trigger takeover first (notifies agent)
			if (this.state === "hands-free") {
				this.triggerUserTakeover();
			}
			this.state = "detach-dialog";
			this.dialogSelection = "transfer";
			this.tui.requestRender();
			return;
		}

		// Scroll does NOT trigger takeover
		if (matchesKey(data, "shift+up")) {
			this.session.scrollUp(Math.max(1, this.session.rows - 2));
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "shift+down")) {
			this.session.scrollDown(Math.max(1, this.session.rows - 2));
			this.tui.requestRender();
			return;
		}

		// Any other input in hands-free mode triggers user takeover
		if (this.state === "hands-free") {
			this.triggerUserTakeover();
			// Fall through to send the input to subprocess
		}

		this.session.write(data);
	}

	private handleDialogInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.state = "running";
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "up") || matchesKey(data, "down")) {
			const options: DialogChoice[] = ["transfer", "background", "kill", "cancel"];
			const currentIdx = options.indexOf(this.dialogSelection);
			const direction = matchesKey(data, "up") ? -1 : 1;
			const newIdx = (currentIdx + direction + options.length) % options.length;
			this.dialogSelection = options[newIdx]!;
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "enter")) {
			switch (this.dialogSelection) {
				case "transfer":
					this.finishWithTransfer();
					break;
				case "kill":
					this.finishWithKill();
					break;
				case "background":
					this.finishWithBackground();
					break;
				case "cancel":
					this.state = "running";
					this.tui.requestRender();
					break;
			}
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const border = (s: string) => th.fg("border", s);
		const accent = (s: string) => th.fg("accent", s);
		const dim = (s: string) => th.fg("dim", s);
		const warning = (s: string) => th.fg("warning", s);

		const innerWidth = width - 4;
		const pad = (s: string, w: number) => {
			const vis = visibleWidth(s);
			return s + " ".repeat(Math.max(0, w - vis));
		};
		const row = (content: string) => border("│ ") + pad(content, innerWidth) + border(" │");
		const emptyRow = () => row("");

		const lines: string[] = [];

		// Sanitize command: collapse newlines and whitespace to single spaces for display
		const sanitizedCommand = this.options.command.replace(/\s+/g, " ").trim();
		const title = truncateToWidth(sanitizedCommand, innerWidth - 20, "...");
		const pid = `PID: ${this.session.pid}`;
		lines.push(border("╭" + "─".repeat(width - 2) + "╮"));
		lines.push(
			row(
				accent(title) +
					" ".repeat(Math.max(1, innerWidth - visibleWidth(title) - pid.length)) +
					dim(pid),
			),
		);
		let hint: string;
		// Sanitize reason: collapse newlines and whitespace to single spaces for display
		const sanitizedReason = this.options.reason?.replace(/\s+/g, " ").trim();
		if (this.state === "hands-free") {
			const elapsed = formatDuration(Date.now() - this.startTime);
			hint = `🤖 Hands-free (${elapsed}) • Type anything to take over`;
		} else if (this.userTookOver) {
			hint = sanitizedReason
				? `You took over • ${sanitizedReason} • Ctrl+B background`
				: "You took over • Ctrl+B background";
		} else {
			hint = sanitizedReason
				? `Ctrl+B background • ${sanitizedReason}`
				: "Ctrl+B background";
		}
		lines.push(row(dim(truncateToWidth(hint, innerWidth, "..."))));
		lines.push(border("├" + "─".repeat(width - 2) + "┤"));

		const overlayHeight = Math.floor((this.tui.terminal.rows * this.config.overlayHeightPercent) / 100);
		const termRows = Math.max(3, overlayHeight - CHROME_LINES);

		if (innerWidth !== this.lastWidth || termRows !== this.lastHeight) {
			this.session.resize(innerWidth, termRows);
			this.lastWidth = innerWidth;
			this.lastHeight = termRows;
			// After resize, ensure we're at the bottom to prevent flash to top
			this.session.scrollToBottom();
		}

		const viewportLines = this.session.getViewportLines({ ansi: this.config.ansiReemit });
		for (const line of viewportLines) {
			lines.push(row(truncateToWidth(line, innerWidth, "")));
		}

		if (this.session.isScrolledUp()) {
			const hintText = "── ↑ scrolled (Shift+Down) ──";
			const padLen = Math.max(0, Math.floor((width - 2 - visibleWidth(hintText)) / 2));
			lines.push(
				border("├") +
					dim(
						" ".repeat(padLen) +
							hintText +
							" ".repeat(width - 2 - padLen - visibleWidth(hintText)),
					) +
					border("┤"),
			);
		} else {
			lines.push(border("├" + "─".repeat(width - 2) + "┤"));
		}

		const footerLines: string[] = [];

		if (this.state === "detach-dialog") {
			footerLines.push(row(accent("Session actions:")));
			const opts: Array<{ key: DialogChoice; label: string }> = [
				{ key: "transfer", label: "Transfer output to agent" },
				{ key: "background", label: "Run in background" },
				{ key: "kill", label: "Kill process" },
				{ key: "cancel", label: "Cancel (return to session)" },
			];
			for (const opt of opts) {
				const sel = this.dialogSelection === opt.key;
				footerLines.push(row((sel ? accent("▶ ") : "  ") + (sel ? accent(opt.label) : opt.label)));
			}
			footerLines.push(row(dim("↑↓ select • Enter confirm • Esc cancel")));
		} else if (this.state === "exited") {
			const exitMsg =
				this.session.exitCode === 0
					? th.fg("success", "✓ Exited successfully")
					: warning(`✗ Exited with code ${this.session.exitCode}`);
			footerLines.push(row(exitMsg));
			footerLines.push(row(dim(`Closing in ${this.exitCountdown}s... (any key to close)`)));
		} else if (this.state === "hands-free") {
			footerLines.push(row(dim("🤖 Agent controlling • Type to take over • Ctrl+T transfer • Ctrl+B background")));
		} else {
			footerLines.push(row(dim("Ctrl+T transfer • Ctrl+B background • Ctrl+Q menu • Shift+Up/Down scroll")));
		}

		while (footerLines.length < FOOTER_LINES) {
			footerLines.push(emptyRow());
		}
		lines.push(...footerLines);

		lines.push(border("╰" + "─".repeat(width - 2) + "╯"));

		return lines;
	}

	invalidate(): void {
		this.lastWidth = 0;
		this.lastHeight = 0;
	}

	dispose(): void {
		this.stopCountdown();
		this.stopTimeout();
		this.stopHandsFreeUpdates();
		if (this.renderTimeout) {
			clearTimeout(this.renderTimeout);
			this.renderTimeout = null;
		}
		// Safety cleanup in case dispose() is called without going through finishWith*
		// If session hasn't completed yet, kill it to prevent orphaned processes
		if (!this.completionResult) {
			this.session.kill();
			this.session.dispose();
			// Release ID since session is dead and agent can't query anymore
			this.unregisterActiveSession(true);
		} else if (this.options.onHandsFreeUpdate) {
			// Streaming mode already delivered result, safe to unregister and release
			this.unregisterActiveSession(true);
		}
		// Non-blocking mode with completion: keep registered so agent can query
	}
}
