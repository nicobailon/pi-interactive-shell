import { stripVTControlCharacters } from "node:util";
import type { PtyTerminalSession } from "./pty-session.js";
import type { InteractiveShellConfig } from "./config.js";

/** Output line that matched a monitor filter. */
export interface MonitorMatchInfo {
	line: string;
	matchedText: string;
}

/** Runtime options for monitoring a headless dispatch session. */
export interface HeadlessMonitorOptions {
	autoExitOnQuiet: boolean;
	quietThreshold: number;
	gracePeriod?: number;
	timeout?: number;
	monitorFilter?: RegExp;
	onMonitorEvent?: (event: MonitorMatchInfo) => void;
	/** Original session start time in ms since epoch, preserved when a foreground session moves headless. */
	startedAt?: number;
}

/** Completion payload emitted when a headless dispatch session finishes. */
export interface HeadlessCompletionInfo {
	exitCode: number | null;
	signal?: number;
	timedOut?: boolean;
	cancelled?: boolean;
	completionOutput?: {
		lines: string[];
		totalLines: number;
		truncated: boolean;
	};
}

export class HeadlessDispatchMonitor {
	readonly startTime: number;
	private _disposed = false;
	private quietTimer: ReturnType<typeof setTimeout> | null = null;
	private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
	private result: HeadlessCompletionInfo | undefined;
	private completeCallbacks: Array<() => void> = [];
	private unsubData: (() => void) | null = null;
	private unsubExit: (() => void) | null = null;
	private monitorLineBuffer = "";
	private emittedMonitorLines = new Set<string>();

	get disposed(): boolean { return this._disposed; }

	constructor(
		private session: PtyTerminalSession,
		private config: InteractiveShellConfig,
		private options: HeadlessMonitorOptions,
		private onComplete: (info: HeadlessCompletionInfo) => void,
	) {
		this.startTime = options.startedAt ?? Date.now();
		this.subscribe();

		if (options.autoExitOnQuiet) {
			this.resetQuietTimer();
		}

		if (options.timeout && options.timeout > 0) {
			this.timeoutTimer = setTimeout(() => {
				this.handleCompletion(null, undefined, true);
			}, options.timeout);
		}

		if (session.exited) {
			queueMicrotask(() => {
				if (!this._disposed) {
					this.handleCompletion(session.exitCode, session.signal);
				}
			});
		}
	}

	private subscribe(): void {
		this.unsubscribe();
		this.unsubData = this.session.addDataListener((data) => {
			const visible = stripVTControlCharacters(data);
			if (this.options.autoExitOnQuiet && visible.trim().length > 0) {
				this.resetQuietTimer();
			}
			if (this.options.monitorFilter && this.options.onMonitorEvent) {
				this.processMonitorData(visible, false);
			}
		});
		this.unsubExit = this.session.addExitListener((exitCode, signal) => {
			if (!this._disposed) {
				this.handleCompletion(exitCode, signal);
			}
		});
	}

	private unsubscribe(): void {
		this.unsubData?.();
		this.unsubData = null;
		this.unsubExit?.();
		this.unsubExit = null;
	}

	private processMonitorData(visible: string, flushTrailing: boolean): void {
		if (!visible && !flushTrailing) return;
		const combined = this.monitorLineBuffer + visible;
		const parts = combined.split(/\r\n|\n|\r/g);
		if (flushTrailing) {
			this.monitorLineBuffer = "";
		} else {
			this.monitorLineBuffer = parts.pop() ?? "";
		}

		for (const line of parts) {
			if (!line) continue;
			const pattern = this.options.monitorFilter;
			if (!pattern) continue;
			pattern.lastIndex = 0;
			const match = pattern.exec(line);
			if (!match) continue;
			if (this.emittedMonitorLines.has(line)) continue;
			this.emittedMonitorLines.add(line);
			try {
				this.options.onMonitorEvent?.({
					line,
					matchedText: match[0],
				});
			} catch (error) {
				console.error("interactive-shell: monitor event callback error:", error);
			}
		}
	}

	private resetQuietTimer(): void {
		this.stopQuietTimer();
		this.quietTimer = setTimeout(() => {
			this.quietTimer = null;
			if (!this._disposed && this.options.autoExitOnQuiet) {
				const gracePeriod = this.options.gracePeriod ?? this.config.autoExitGracePeriod;
				if (Date.now() - this.startTime < gracePeriod) {
					this.resetQuietTimer();
					return;
				}
				this.session.kill();
				this.handleCompletion(null, undefined, false, true);
			}
		}, this.options.quietThreshold);
	}

	private stopQuietTimer(): void {
		if (this.quietTimer) {
			clearTimeout(this.quietTimer);
			this.quietTimer = null;
		}
	}

	private captureOutput(): HeadlessCompletionInfo["completionOutput"] {
		try {
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
		} catch {
			// Session terminal may already be disposed during completion — safe to return empty
			return { lines: [], totalLines: 0, truncated: false };
		}
	}

	private handleCompletion(exitCode: number | null, signal?: number, timedOut?: boolean, cancelled?: boolean): void {
		if (this._disposed) return;
		if (this.options.monitorFilter && this.options.onMonitorEvent) {
			this.processMonitorData("", true);
		}
		this._disposed = true;
		this.stopQuietTimer();
		if (this.timeoutTimer) { clearTimeout(this.timeoutTimer); this.timeoutTimer = null; }
		this.unsubscribe();

		if (timedOut) {
			this.session.kill();
		}

		const completionOutput = this.captureOutput();
		const info: HeadlessCompletionInfo = { exitCode, signal, timedOut, cancelled, completionOutput };
		this.result = info;
		this.triggerCompleteCallbacks();
		this.onComplete(info);
	}

	handleExternalCompletion(exitCode: number | null, signal?: number, completionOutput?: HeadlessCompletionInfo["completionOutput"]): void {
		if (this._disposed) return;
		if (this.options.monitorFilter && this.options.onMonitorEvent) {
			this.processMonitorData("", true);
		}
		this._disposed = true;
		this.stopQuietTimer();
		if (this.timeoutTimer) { clearTimeout(this.timeoutTimer); this.timeoutTimer = null; }
		this.unsubscribe();

		const output = completionOutput ?? this.captureOutput();
		const info: HeadlessCompletionInfo = { exitCode, signal, completionOutput: output };
		this.result = info;
		this.triggerCompleteCallbacks();
		this.onComplete(info);
	}

	getResult(): HeadlessCompletionInfo | undefined {
		return this.result;
	}

	registerCompleteCallback(callback: () => void): void {
		if (this.result) {
			callback();
			return;
		}
		this.completeCallbacks.push(callback);
	}

	private triggerCompleteCallbacks(): void {
		for (const cb of this.completeCallbacks) {
			try {
				cb();
			} catch (error) {
				console.error("interactive-shell: headless completion callback error:", error);
			}
		}
		this.completeCallbacks = [];
	}

	dispose(): void {
		if (this._disposed) return;
		this._disposed = true;
		this.stopQuietTimer();
		if (this.timeoutTimer) { clearTimeout(this.timeoutTimer); this.timeoutTimer = null; }
		this.unsubscribe();
	}
}
