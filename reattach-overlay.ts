import type { Component, Focusable, TUI } from "@mariozechner/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { PtyTerminalSession } from "./pty-session.js";
import { sessionManager } from "./session-manager.js";
import type { InteractiveShellConfig } from "./config.js";
import {
	type InteractiveShellResult,
	type DialogChoice,
	type OverlayState,
	HEADER_LINES,
	FOOTER_LINES_COMPACT,
	FOOTER_LINES_DIALOG,
} from "./types.js";
import { captureCompletionOutput, captureTransferOutput, maybeBuildHandoffPreview, maybeWriteHandoffSnapshot } from "./handoff-utils.js";

export class ReattachOverlay implements Component, Focusable {
	focused = false;

	private tui: TUI;
	private theme: Theme;
	private done: (result: InteractiveShellResult) => void;
	private bgSession: { id: string; command: string; reason?: string; session: PtyTerminalSession };
	private config: InteractiveShellConfig;

	private state: OverlayState = "running";
	private dialogSelection: DialogChoice = "transfer";
	private exitCountdown = 0;
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
		const rows = Math.max(3, overlayHeight - (HEADER_LINES + FOOTER_LINES_COMPACT + 2));
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

	private captureCompletionOutput(): InteractiveShellResult["completionOutput"] {
		return captureCompletionOutput(this.session, this.config);
	}

	/** Capture output for transfer action (Ctrl+T or dialog) */
	private captureTransferOutput(): InteractiveShellResult["transferred"] {
		return captureTransferOutput(this.session, this.config);
	}

	private maybeBuildHandoffPreview(when: "exit" | "detach" | "kill" | "transfer"): InteractiveShellResult["handoffPreview"] | undefined {
		return maybeBuildHandoffPreview(this.session, when, this.config);
	}

	private maybeWriteHandoffSnapshot(when: "exit" | "detach" | "kill" | "transfer"): InteractiveShellResult["handoff"] | undefined {
		return maybeWriteHandoffSnapshot(this.session, when, this.config, { command: this.bgSession.command });
	}

	private finishAndClose(): void {
		if (this.finished) return;
		this.finished = true;
		this.stopCountdown();
		const handoffPreview = this.maybeBuildHandoffPreview("exit");
		const handoff = this.maybeWriteHandoffSnapshot("exit");
		const completionOutput = this.captureCompletionOutput();
		sessionManager.remove(this.bgSession.id);
		this.done({
			exitCode: this.session.exitCode,
			signal: this.session.signal,
			backgrounded: false,
			cancelled: false,
			completionOutput,
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
		if (this.session.exited) {
			sessionManager.scheduleCleanup(this.bgSession.id);
		}
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
		const completionOutput = this.captureCompletionOutput();
		sessionManager.remove(this.bgSession.id);
		this.done({
			exitCode: null,
			backgrounded: false,
			cancelled: true,
			completionOutput,
			handoffPreview,
			handoff,
		});
	}

	private finishWithTransfer(): void {
		if (this.finished) return;
		this.finished = true;
		this.stopCountdown();

		const transferred = this.captureTransferOutput();
		const handoffPreview = this.maybeBuildHandoffPreview("transfer");
		const handoff = this.maybeWriteHandoffSnapshot("transfer");
		const completionOutput = this.captureCompletionOutput();

		sessionManager.remove(this.bgSession.id);
		this.done({
			exitCode: this.session.exitCode,
			signal: this.session.signal,
			backgrounded: false,
			cancelled: false,
			transferred,
			completionOutput,
			handoffPreview,
			handoff,
		});
	}

	handleInput(data: string): void {
		if (this.state === "detach-dialog") {
			this.handleDialogInput(data);
			return;
		}

		// Ctrl+T: Quick transfer - capture output and close (works in all states including "exited")
		if (matchesKey(data, "ctrl+t")) {
			this.finishWithTransfer();
			return;
		}

		// Ctrl+B: Quick background - dismiss overlay, keep process running
		if (matchesKey(data, "ctrl+b") && !this.session.exited) {
			this.finishWithBackground();
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

		// Ctrl+Q opens detach dialog
		if (matchesKey(data, "ctrl+q")) {
			this.state = "detach-dialog";
			this.dialogSelection = "transfer";
			this.tui.requestRender();
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
		width = Math.max(4, width);
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
		const sanitizedCommand = this.bgSession.command.replace(/\s+/g, " ").trim();
		const title = truncateToWidth(sanitizedCommand, innerWidth - 30, "...");
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
		// Sanitize reason: collapse newlines and whitespace to single spaces for display
		const sanitizedReason = this.bgSession.reason?.replace(/\s+/g, " ").trim();
		const hint = sanitizedReason
			? `Reattached • ${sanitizedReason} • Ctrl+B background`
			: "Reattached • Ctrl+B background";
		lines.push(row(dim(truncateToWidth(hint, innerWidth, "..."))));
		lines.push(border("├" + "─".repeat(width - 2) + "┤"));

		const overlayHeight = Math.floor((this.tui.terminal.rows * this.config.overlayHeightPercent) / 100);
		const footerHeight = this.state === "detach-dialog" ? FOOTER_LINES_DIALOG : FOOTER_LINES_COMPACT;
		const chrome = HEADER_LINES + footerHeight + 2;
		const termRows = Math.max(3, overlayHeight - chrome);

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
		} else {
			footerLines.push(row(dim("Ctrl+T transfer • Ctrl+B background • Ctrl+Q menu • Shift+Up/Down scroll")));
		}

		while (footerLines.length < footerHeight) {
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
