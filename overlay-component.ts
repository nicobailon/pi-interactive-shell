import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Component, Focusable, TUI } from "@mariozechner/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { PtyTerminalSession } from "./pty-session.js";
import { sessionManager, generateSessionId } from "./session-manager.js";
import type { InteractiveShellConfig } from "./config.js";

export interface InteractiveShellResult {
	exitCode: number | null;
	signal?: number;
	backgrounded: boolean;
	backgroundId?: string;
	cancelled: boolean;
	timedOut?: boolean;
	sessionId?: string;
	userTookOver?: boolean;
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
	status: "running" | "user-takeover" | "exited";
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
	// Hands-free mode
	mode?: "interactive" | "hands-free";
	sessionId?: string; // Pre-generated sessionId for hands-free mode
	handsFreeUpdateMode?: "on-quiet" | "interval";
	handsFreeUpdateInterval?: number;
	handsFreeQuietThreshold?: number;
	handsFreeUpdateMaxChars?: number;
	handsFreeMaxTotalChars?: number;
	onHandsFreeUpdate?: (update: HandsFreeUpdate) => void;
	// Auto-kill timeout
	timeout?: number;
}

type DialogChoice = "kill" | "background" | "cancel";
type OverlayState = "running" | "exited" | "detach-dialog" | "hands-free";

function formatDuration(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}

const FOOTER_LINES = 5;
const HEADER_LINES = 4;
const CHROME_LINES = HEADER_LINES + FOOTER_LINES + 2;

export class InteractiveShellOverlay implements Component, Focusable {
	focused = false;

	private tui: TUI;
	private theme: Theme;
	private done: (result: InteractiveShellResult) => void;
	private session: PtyTerminalSession;
	private options: InteractiveShellOptions;
	private config: InteractiveShellConfig;

	private state: OverlayState = "running";
	private dialogSelection: DialogChoice = "background";
	private exitCountdown = 0;
	private lastEscapeTime = 0;
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
	private timedOut = false;
	// Prevent double done() calls
	private finished = false;
	// Budget tracking for hands-free updates
	private totalCharsSent = 0;
	private budgetExhausted = false;
	private currentUpdateInterval: number;
	private currentQuietThreshold: number;
	private updateMode: "on-quiet" | "interval";
	private lastDataTime = 0;
	private quietTimer: ReturnType<typeof setTimeout> | null = null;
	private hasUnsentData = false;

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

		this.session = new PtyTerminalSession(
			{
				command: options.command,
				cwd: options.cwd,
				cols,
				rows,
				scrollback: this.config.scrollbackLines,
				ansiReemit: this.config.ansiReemit,
			},
			{
				onData: () => {
					if (!this.session.isScrolledUp()) {
						this.session.scrollToBottom();
					}
					this.tui.requestRender();

					// Track activity for on-quiet mode
					if (this.state === "hands-free" && this.updateMode === "on-quiet") {
						this.lastDataTime = Date.now();
						this.hasUnsentData = true;
						this.resetQuietTimer();
					}
				},
				onExit: () => {
					// Guard: if already finished (e.g., timeout fired), don't process exit
					if (this.finished) return;

					// Stop timeout to prevent double done() call
					this.stopTimeout();

					// Send final update with any unsent data, then "exited" notification
					if (this.state === "hands-free" && this.options.onHandsFreeUpdate && this.sessionId) {
						// Flush any pending output before sending exited notification
						if (this.hasUnsentData || this.updateMode === "interval") {
							this.emitHandsFreeUpdate();
							this.hasUnsentData = false;
						}
						// Now send exited notification
						this.options.onHandsFreeUpdate({
							status: "exited",
							sessionId: this.sessionId,
							runtime: Date.now() - this.startTime,
							tail: [],
							tailTruncated: false,
							totalCharsSent: this.totalCharsSent,
							budgetExhausted: this.budgetExhausted,
						});
						this.unregisterActiveSession();
					}
					this.stopHandsFreeUpdates();
					this.state = "exited";
					this.exitCountdown = this.config.exitAutoCloseDelay;
					this.startExitCountdown();
					this.tui.requestRender();
				},
			},
		);

		// Initialize hands-free mode settings
		this.updateMode = options.handsFreeUpdateMode ?? config.handsFreeUpdateMode;
		this.currentUpdateInterval = options.handsFreeUpdateInterval ?? config.handsFreeUpdateInterval;
		this.currentQuietThreshold = options.handsFreeQuietThreshold ?? config.handsFreeQuietThreshold;

		// Initialize hands-free mode if requested
		if (options.mode === "hands-free") {
			this.state = "hands-free";
			// Use provided sessionId or generate one
			this.sessionId = options.sessionId ?? generateSessionId(options.name);
			sessionManager.registerActive(
				this.sessionId,
				options.command,
				(data) => this.session.write(data),
				(intervalMs) => this.setUpdateInterval(intervalMs),
				(thresholdMs) => this.setQuietThreshold(thresholdMs),
			);
			this.startHandsFreeUpdates();
		}

		// Start auto-kill timeout if specified
		if (options.timeout && options.timeout > 0) {
			this.timeoutTimer = setTimeout(() => {
				this.finishWithTimeout();
			}, options.timeout);
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

		// Fallback interval (always runs, ensures updates even during continuous output)
		this.handsFreeInterval = setInterval(() => {
			if (this.state === "hands-free") {
				// In on-quiet mode, only emit if we have unsent data (interval is fallback)
				if (this.updateMode === "on-quiet") {
					if (this.hasUnsentData) {
						this.emitHandsFreeUpdate();
						this.hasUnsentData = false;
						this.stopQuietTimer(); // Reset quiet timer since we just sent
					}
				} else {
					// In interval mode, always emit
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
			if (this.state === "hands-free" && this.hasUnsentData) {
				this.emitHandsFreeUpdate();
				this.hasUnsentData = false;
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

		// Restart the interval with new timing
		if (this.handsFreeInterval) {
			clearInterval(this.handsFreeInterval);
			this.handsFreeInterval = setInterval(() => {
				if (this.state === "hands-free") {
					if (this.updateMode === "on-quiet") {
						if (this.hasUnsentData) {
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

	private unregisterActiveSession(): void {
		if (this.sessionId && !this.sessionUnregistered) {
			sessionManager.unregisterActive(this.sessionId);
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
		// Unregister from active sessions since user took over
		this.unregisterActiveSession();
		this.state = "running";
		this.userTookOver = true;

		// Notify agent that user took over
		this.options.onHandsFreeUpdate?.({
			status: "user-takeover",
			sessionId: this.sessionId,
			runtime: Date.now() - this.startTime,
			tail: [],
			tailTruncated: false,
			userTookOver: true,
			totalCharsSent: this.totalCharsSent,
			budgetExhausted: this.budgetExhausted,
		});

		this.tui.requestRender();
	}

	private maybeBuildHandoffPreview(when: "exit" | "detach" | "kill" | "timeout"): InteractiveShellResult["handoffPreview"] | undefined {
		const enabled = this.options.handoffPreviewEnabled ?? this.config.handoffPreviewEnabled;
		if (!enabled) return undefined;

		const lines = this.options.handoffPreviewLines ?? this.config.handoffPreviewLines;
		const maxChars = this.options.handoffPreviewMaxChars ?? this.config.handoffPreviewMaxChars;
		if (lines <= 0 || maxChars <= 0) return undefined;

		// Use raw output stream instead of xterm buffer - TUI apps using alternate
		// screen buffer can have misleading content in getTailLines()
		const rawOutput = this.session.getRawStream({ stripAnsi: true });
		const outputLines = rawOutput.split("\n");

		// Get last N lines, respecting maxChars
		let tail: string[] = [];
		let charCount = 0;
		for (let i = outputLines.length - 1; i >= 0 && tail.length < lines; i--) {
			const line = outputLines[i];
			if (charCount + line.length > maxChars && tail.length > 0) break;
			tail.unshift(line);
			charCount += line.length + 1; // +1 for newline
		}

		return { type: "tail", when, lines: tail };
	}

	private maybeWriteHandoffSnapshot(when: "exit" | "detach" | "kill" | "timeout"): InteractiveShellResult["handoff"] | undefined {
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

		const tail = this.session.getTailLines({
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
			`lines: ${tail.length} (requested ${lines}, maxChars ${maxChars})`,
			"",
		].join("\n");

		writeFileSync(transcriptPath, header + tail.join("\n") + "\n", { encoding: "utf-8" });

		return { type: "snapshot", when, transcriptPath, linesWritten: tail.length };
	}

	private finishWithExit(): void {
		if (this.finished) return;
		this.finished = true;
		this.stopCountdown();
		this.stopTimeout();
		this.stopHandsFreeUpdates();
		this.unregisterActiveSession();
		const handoffPreview = this.maybeBuildHandoffPreview("exit");
		const handoff = this.maybeWriteHandoffSnapshot("exit");
		this.session.dispose();
		this.done({
			exitCode: this.session.exitCode,
			signal: this.session.signal,
			backgrounded: false,
			cancelled: false,
			sessionId: this.sessionId ?? undefined,
			userTookOver: this.userTookOver,
			handoffPreview,
			handoff,
		});
	}

	private finishWithBackground(): void {
		if (this.finished) return;
		this.finished = true;
		this.stopCountdown();
		this.stopTimeout();
		this.stopHandsFreeUpdates();
		this.unregisterActiveSession();
		const handoffPreview = this.maybeBuildHandoffPreview("detach");
		const handoff = this.maybeWriteHandoffSnapshot("detach");
		const id = sessionManager.add(this.options.command, this.session, this.options.name, this.options.reason);
		this.done({
			exitCode: null,
			backgrounded: true,
			backgroundId: id,
			cancelled: false,
			sessionId: this.sessionId ?? undefined,
			userTookOver: this.userTookOver,
			handoffPreview,
			handoff,
		});
	}

	private finishWithKill(): void {
		if (this.finished) return;
		this.finished = true;
		this.stopCountdown();
		this.stopTimeout();
		this.stopHandsFreeUpdates();
		this.unregisterActiveSession();
		const handoffPreview = this.maybeBuildHandoffPreview("kill");
		const handoff = this.maybeWriteHandoffSnapshot("kill");
		this.session.kill();
		this.session.dispose();
		this.done({
			exitCode: null,
			backgrounded: false,
			cancelled: true,
			sessionId: this.sessionId ?? undefined,
			userTookOver: this.userTookOver,
			handoffPreview,
			handoff,
		});
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
		this.unregisterActiveSession();
		this.timedOut = true;
		const handoffPreview = this.maybeBuildHandoffPreview("timeout");
		const handoff = this.maybeWriteHandoffSnapshot("timeout");
		this.session.kill();
		this.session.dispose();
		this.done({
			exitCode: null,
			backgrounded: false,
			cancelled: false,
			timedOut: true,
			sessionId: this.sessionId ?? undefined,
			userTookOver: this.userTookOver,
			handoffPreview,
			handoff,
		});
	}

	private handleDoubleEscape(): boolean {
		const now = Date.now();
		if (now - this.lastEscapeTime < this.config.doubleEscapeThreshold) {
			this.lastEscapeTime = 0;
			return true;
		}
		this.lastEscapeTime = now;
		return false;
	}

	handleInput(data: string): void {
		if (this.state === "detach-dialog") {
			this.handleDialogInput(data);
			return;
		}

		if (this.state === "exited") {
			if (data.length > 0) {
				this.finishWithExit();
			}
			return;
		}

		// Double-escape detection (works in both hands-free and running)
		if (matchesKey(data, "escape")) {
			if (this.handleDoubleEscape()) {
				// If in hands-free mode, trigger takeover first (notifies agent)
				if (this.state === "hands-free") {
					this.triggerUserTakeover();
				}
				this.state = "detach-dialog";
				this.dialogSelection = "background";
				this.tui.requestRender();
				return;
			}
			// Single escape goes to subprocess (no takeover)
			this.session.write("\u001b");
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
			const options: DialogChoice[] = ["kill", "background", "cancel"];
			const currentIdx = options.indexOf(this.dialogSelection);
			const direction = matchesKey(data, "up") ? -1 : 1;
			const newIdx = (currentIdx + direction + options.length) % options.length;
			this.dialogSelection = options[newIdx]!;
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "enter")) {
			switch (this.dialogSelection) {
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

		const title = truncateToWidth(this.options.command, innerWidth - 20, "...");
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
		if (this.state === "hands-free") {
			const elapsed = formatDuration(Date.now() - this.startTime);
			hint = `🤖 Hands-free (${elapsed}) • Type anything to take over`;
		} else if (this.userTookOver) {
			hint = this.options.reason
				? `You took over • ${this.options.reason} • Double-Escape to detach`
				: "You took over • Double-Escape to detach";
		} else {
			hint = this.options.reason
				? `Double-Escape to detach • ${this.options.reason}`
				: "Double-Escape to detach";
		}
		lines.push(row(dim(truncateToWidth(hint, innerWidth, "..."))));
		lines.push(border("├" + "─".repeat(width - 2) + "┤"));

		const overlayHeight = Math.floor((this.tui.terminal.rows * this.config.overlayHeightPercent) / 100);
		const termRows = Math.max(3, overlayHeight - CHROME_LINES);

		if (innerWidth !== this.lastWidth || termRows !== this.lastHeight) {
			this.session.resize(innerWidth, termRows);
			this.lastWidth = innerWidth;
			this.lastHeight = termRows;
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
			footerLines.push(row(accent("Detach from session:")));
			const opts: Array<{ key: DialogChoice; label: string }> = [
				{ key: "kill", label: "Kill process" },
				{ key: "background", label: "Run in background" },
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
			footerLines.push(row(dim("🤖 Agent controlling • Type to take over • Shift+Up/Down scroll")));
		} else {
			footerLines.push(row(dim("Shift+Up/Down scroll • Double-Esc detach • Ctrl+C interrupt")));
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
		// Safety cleanup in case dispose() is called without going through finishWith*
		this.unregisterActiveSession();
	}
}

export class ReattachOverlay implements Component, Focusable {
	focused = false;

	private tui: TUI;
	private theme: Theme;
	private done: (result: InteractiveShellResult) => void;
	private bgSession: { id: string; command: string; reason?: string; session: PtyTerminalSession };
	private config: InteractiveShellConfig;

	private state: OverlayState = "running";
	private dialogSelection: DialogChoice = "background";
	private exitCountdown = 0;
	private lastEscapeTime = 0;
	private countdownInterval: ReturnType<typeof setInterval> | null = null;
	private initialExitTimeout: ReturnType<typeof setTimeout> | null = null;
	private lastWidth = 0;
	private lastHeight = 0;
	private finished = false;

	constructor(
		tui: TUI,
		theme: Theme,
		bgSession: { id: string; command: string; reason?: string; session: PtyTerminalSession },
		config: InteractiveShellConfig,
		done: (result: InteractiveShellResult) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.bgSession = bgSession;
		this.config = config;
		this.done = done;

		bgSession.session.setEventHandlers({
			onData: () => {
				if (!bgSession.session.isScrolledUp()) {
					bgSession.session.scrollToBottom();
				}
				this.tui.requestRender();
			},
			onExit: () => {
				if (this.finished) return;
				this.state = "exited";
				this.exitCountdown = this.config.exitAutoCloseDelay;
				this.startExitCountdown();
				this.tui.requestRender();
			},
		});

		if (bgSession.session.exited) {
			this.state = "exited";
			this.exitCountdown = this.config.exitAutoCloseDelay;
			this.initialExitTimeout = setTimeout(() => {
				this.initialExitTimeout = null;
				this.startExitCountdown();
			}, 0);
		}

		const overlayWidth = Math.floor((tui.terminal.columns * this.config.overlayWidthPercent) / 100);
		const overlayHeight = Math.floor((tui.terminal.rows * this.config.overlayHeightPercent) / 100);
		const cols = Math.max(20, overlayWidth - 4);
		const rows = Math.max(3, overlayHeight - CHROME_LINES);
		bgSession.session.resize(cols, rows);
	}

	private get session(): PtyTerminalSession {
		return this.bgSession.session;
	}

	private startExitCountdown(): void {
		this.stopCountdown();
		this.countdownInterval = setInterval(() => {
			this.exitCountdown--;
			if (this.exitCountdown <= 0) {
				this.finishAndClose();
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

	private maybeBuildHandoffPreview(when: "exit" | "detach" | "kill"): InteractiveShellResult["handoffPreview"] | undefined {
		if (!this.config.handoffPreviewEnabled) return undefined;
		const lines = this.config.handoffPreviewLines;
		const maxChars = this.config.handoffPreviewMaxChars;
		if (lines <= 0 || maxChars <= 0) return undefined;

		// Use raw output stream instead of xterm buffer - TUI apps using alternate
		// screen buffer can have misleading content in getTailLines()
		const rawOutput = this.session.getRawStream({ stripAnsi: true });
		const outputLines = rawOutput.split("\n");

		// Get last N lines, respecting maxChars
		let tail: string[] = [];
		let charCount = 0;
		for (let i = outputLines.length - 1; i >= 0 && tail.length < lines; i--) {
			const line = outputLines[i];
			if (charCount + line.length > maxChars && tail.length > 0) break;
			tail.unshift(line);
			charCount += line.length + 1; // +1 for newline
		}

		return { type: "tail", when, lines: tail };
	}

	private maybeWriteHandoffSnapshot(when: "exit" | "detach" | "kill"): InteractiveShellResult["handoff"] | undefined {
		if (!this.config.handoffSnapshotEnabled) return undefined;
		const lines = this.config.handoffSnapshotLines;
		const maxChars = this.config.handoffSnapshotMaxChars;
		if (lines <= 0 || maxChars <= 0) return undefined;

		const baseDir = join(homedir(), ".pi", "agent", "cache", "interactive-shell");
		mkdirSync(baseDir, { recursive: true });

		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		const pid = this.session.pid;
		const filename = `snapshot-${timestamp}-pid${pid}.log`;
		const transcriptPath = join(baseDir, filename);

		const tail = this.session.getTailLines({
			lines,
			ansi: this.config.ansiReemit,
			maxChars,
		});

		const header = [
			`# interactive-shell snapshot (${when})`,
			`time: ${new Date().toISOString()}`,
			`command: ${this.bgSession.command}`,
			`pid: ${pid}`,
			`exitCode: ${this.session.exitCode ?? ""}`,
			`signal: ${this.session.signal ?? ""}`,
			`lines: ${tail.length} (requested ${lines}, maxChars ${maxChars})`,
			"",
		].join("\n");

		writeFileSync(transcriptPath, header + tail.join("\n") + "\n", { encoding: "utf-8" });

		return { type: "snapshot", when, transcriptPath, linesWritten: tail.length };
	}

	private finishAndClose(): void {
		if (this.finished) return;
		this.finished = true;
		this.stopCountdown();
		const handoffPreview = this.maybeBuildHandoffPreview("exit");
		const handoff = this.maybeWriteHandoffSnapshot("exit");
		sessionManager.remove(this.bgSession.id);
		this.done({
			exitCode: this.session.exitCode,
			signal: this.session.signal,
			backgrounded: false,
			cancelled: false,
			handoffPreview,
			handoff,
		});
	}

	private finishWithBackground(): void {
		if (this.finished) return;
		this.finished = true;
		this.stopCountdown();
		const handoffPreview = this.maybeBuildHandoffPreview("detach");
		const handoff = this.maybeWriteHandoffSnapshot("detach");
		this.session.setEventHandlers({});
		this.done({
			exitCode: null,
			backgrounded: true,
			backgroundId: this.bgSession.id,
			cancelled: false,
			handoffPreview,
			handoff,
		});
	}

	private finishWithKill(): void {
		if (this.finished) return;
		this.finished = true;
		this.stopCountdown();
		const handoffPreview = this.maybeBuildHandoffPreview("kill");
		const handoff = this.maybeWriteHandoffSnapshot("kill");
		sessionManager.remove(this.bgSession.id);
		this.done({
			exitCode: null,
			backgrounded: false,
			cancelled: true,
			handoffPreview,
			handoff,
		});
	}

	private handleDoubleEscape(): boolean {
		const now = Date.now();
		if (now - this.lastEscapeTime < this.config.doubleEscapeThreshold) {
			this.lastEscapeTime = 0;
			return true;
		}
		this.lastEscapeTime = now;
		return false;
	}

	handleInput(data: string): void {
		if (this.state === "detach-dialog") {
			this.handleDialogInput(data);
			return;
		}

		if (this.state === "exited") {
			if (data.length > 0) {
				this.finishAndClose();
			}
			return;
		}

		if (this.session.exited && this.state === "running") {
			this.state = "exited";
			this.exitCountdown = this.config.exitAutoCloseDelay;
			this.startExitCountdown();
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "escape")) {
			if (this.handleDoubleEscape()) {
				this.state = "detach-dialog";
				this.dialogSelection = "background";
				this.tui.requestRender();
				return;
			}
			this.session.write("\u001b");
			return;
		}

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

		this.session.write(data);
	}

	private handleDialogInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.state = "running";
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "up") || matchesKey(data, "down")) {
			const options: DialogChoice[] = ["kill", "background", "cancel"];
			const currentIdx = options.indexOf(this.dialogSelection);
			const direction = matchesKey(data, "up") ? -1 : 1;
			const newIdx = (currentIdx + direction + options.length) % options.length;
			this.dialogSelection = options[newIdx]!;
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "enter")) {
			switch (this.dialogSelection) {
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

		const title = truncateToWidth(this.bgSession.command, innerWidth - 30, "...");
		const idLabel = `[${this.bgSession.id}]`;
		const pid = `PID: ${this.session.pid}`;

		lines.push(border("╭" + "─".repeat(width - 2) + "╮"));
		lines.push(
			row(
				accent(title) +
					" " +
					dim(idLabel) +
					" ".repeat(
						Math.max(1, innerWidth - visibleWidth(title) - idLabel.length - pid.length - 1),
					) +
					dim(pid),
			),
		);
		const hint = this.bgSession.reason
			? `Reattached • ${this.bgSession.reason} • Double-Escape to detach`
			: "Reattached • Double-Escape to detach";
		lines.push(row(dim(truncateToWidth(hint, innerWidth, "..."))));
		lines.push(border("├" + "─".repeat(width - 2) + "┤"));

		const overlayHeight = Math.floor((this.tui.terminal.rows * this.config.overlayHeightPercent) / 100);
		const termRows = Math.max(3, overlayHeight - CHROME_LINES);

		if (innerWidth !== this.lastWidth || termRows !== this.lastHeight) {
			this.session.resize(innerWidth, termRows);
			this.lastWidth = innerWidth;
			this.lastHeight = termRows;
		}

		const viewportLines = this.session.getViewportLines({ ansi: this.config.ansiReemit });
		for (const line of viewportLines) {
			lines.push(row(truncateToWidth(line, innerWidth, "")));
		}

		if (this.session.isScrolledUp()) {
			const hintText = "── ↑ scrolled ──";
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
			footerLines.push(row(accent("Detach from session:")));
			const opts: Array<{ key: DialogChoice; label: string }> = [
				{ key: "kill", label: "Kill process" },
				{ key: "background", label: "Run in background" },
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
		} else {
			footerLines.push(row(dim("Shift+Up/Down scroll • Double-Esc detach")));
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
		if (this.initialExitTimeout) {
			clearTimeout(this.initialExitTimeout);
			this.initialExitTimeout = null;
		}
		this.stopCountdown();
		this.session.setEventHandlers({});
	}
}
