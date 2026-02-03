import type { PtyTerminalSession } from "./pty-session.js";
import type { InteractiveShellConfig } from "./config.js";

export interface HeadlessMonitorOptions {
	autoExitOnQuiet: boolean;
	quietThreshold: number;
	timeout?: number;
}

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
	readonly startTime = Date.now();
	private _disposed = false;
	private quietTimer: ReturnType<typeof setTimeout> | null = null;
	private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
	private result: HeadlessCompletionInfo | undefined;
	private completeCallbacks: Array<() => void> = [];
	private unsubData: (() => void) | null = null;
	private unsubExit: (() => void) | null = null;

	get disposed(): boolean { return this._disposed; }

	constructor(
		private session: PtyTerminalSession,
		private config: InteractiveShellConfig,
		private options: HeadlessMonitorOptions,
		private onComplete: (info: HeadlessCompletionInfo) => void,
	) {
		this.subscribe();

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
		this.unsubData = this.session.addDataListener(() => {
			if (this.options.autoExitOnQuiet) {
				this.resetQuietTimer();
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

	private resetQuietTimer(): void {
		this.stopQuietTimer();
		this.quietTimer = setTimeout(() => {
			this.quietTimer = null;
			if (!this._disposed && this.options.autoExitOnQuiet) {
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
			return { lines: [], totalLines: 0, truncated: false };
		}
	}

	private handleCompletion(exitCode: number | null, signal?: number, timedOut?: boolean, cancelled?: boolean): void {
		if (this._disposed) return;
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
			try { cb(); } catch { /* ignore */ }
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
