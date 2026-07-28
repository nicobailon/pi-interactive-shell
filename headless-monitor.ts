import { stripVTControlCharacters } from "node:util";
import type { PtyTerminalSession } from "./pty-session.ts";
import type { InteractiveShellConfig } from "./config.ts";

export interface MonitorMatchInfo {
	strategy: "stream" | "poll-diff" | "file-watch";
	triggerId: string;
	eventType: string;
	matchedText: string;
	lineOrDiff: string;
	stream: "pty";
}

export interface MonitorTriggerMatcher {
	id: string;
	cooldownMs?: number;
	match: (input: string) => string | undefined;
}

export interface MonitorRuntimeConfig {
	strategy: "stream" | "poll-diff" | "file-watch";
	triggers: MonitorTriggerMatcher[];
	pollIntervalMs: number;
	dedupeExactLine: boolean;
	cooldownMs?: number;
}

/** Runtime options for monitoring a headless dispatch session. */
export interface HeadlessMonitorOptions {
	autoExitOnQuiet: boolean;
	quietThreshold: number;
	gracePeriod?: number;
	timeout?: number;
	monitor?: MonitorRuntimeConfig;
	onMonitorEvent?: (event: MonitorMatchInfo) => void | Promise<void>;
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
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private pollInFlight = false;
	private pollInitialized = false;
	private lastPollSnapshot = "";
	private pollReadOffset = 0;
	private result: HeadlessCompletionInfo | undefined;
	private completeCallbacks: Array<() => void> = [];
	private unsubData: (() => void) | null = null;
	private unsubExit: (() => void) | null = null;
	private monitorLineBuffer = "";
	private emittedMonitorKeys = new Set<string>();
	private triggerLastEmitAt = new Map<string, number>();

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

		if (options.monitor?.strategy === "poll-diff") {
			this.startPollTimer();
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
			if (this.options.monitor?.strategy !== "poll-diff" && this.options.onMonitorEvent) {
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
			this.emitStreamMatches(line);
		}
	}

	private emitStreamMatches(line: string): void {
		const monitor = this.options.monitor;
		if (!monitor || monitor.strategy === "poll-diff") return;
		for (const trigger of monitor.triggers) {
			const matchedText = trigger.match(line);
			if (!matchedText) continue;
			if (!this.canEmitTrigger(trigger.id, trigger.cooldownMs)) continue;
			if (!this.shouldEmitUnique(trigger.id, line)) continue;
			this.emitMonitorEvent({
				strategy: monitor.strategy,
				triggerId: trigger.id,
				eventType: trigger.id,
				matchedText,
				lineOrDiff: line,
				stream: "pty",
			});
		}
	}

	private startPollTimer(): void {
		const monitor = this.options.monitor;
		if (!monitor || monitor.strategy !== "poll-diff") return;
		const intervalMs = Math.max(250, Math.trunc(monitor.pollIntervalMs || 5000));
		this.pollTimer = setInterval(() => {
			void this.processPollTick();
		}, intervalMs);
	}

	private stopPollTimer(): void {
		if (!this.pollTimer) return;
		clearInterval(this.pollTimer);
		this.pollTimer = null;
	}

	private async processPollTick(): Promise<void> {
		if (this._disposed || this.pollInFlight) return;
		const monitor = this.options.monitor;
		if (!monitor || monitor.strategy !== "poll-diff") return;
		this.pollInFlight = true;
		try {
			const raw = this.session.getRawStream({ sinceLast: false, stripAnsi: true });
			if (this.pollReadOffset > raw.length) {
				this.pollReadOffset = raw.length;
			}
			const sample = normalizeMonitorSnapshot(raw.slice(this.pollReadOffset));
			this.pollReadOffset = raw.length;
			if (!this.pollInitialized) {
				this.lastPollSnapshot = sample;
				this.pollInitialized = true;
				return;
			}
			if (sample === this.lastPollSnapshot) return;
			const previous = this.lastPollSnapshot;
			this.lastPollSnapshot = sample;
			const diffSummary = summarizeDiff(previous, sample);

			for (const trigger of monitor.triggers) {
				const matchedText = trigger.match(sample);
				if (!matchedText) continue;
				if (!this.canEmitTrigger(trigger.id, trigger.cooldownMs)) continue;
				if (!this.shouldEmitUnique(trigger.id, diffSummary)) continue;
				this.emitMonitorEvent({
					strategy: "poll-diff",
					triggerId: trigger.id,
					eventType: trigger.id,
					matchedText,
					lineOrDiff: diffSummary,
					stream: "pty",
				});
			}
		} catch (error) {
			console.error("interactive-shell: poll-diff tick error:", error);
		} finally {
			this.pollInFlight = false;
		}
	}

	private shouldEmitUnique(triggerId: string, lineOrDiff: string): boolean {
		const monitor = this.options.monitor;
		if (!monitor || monitor.dedupeExactLine === false) return true;
		const key = `${triggerId}\u0000${lineOrDiff}`;
		if (this.emittedMonitorKeys.has(key)) return false;
		this.emittedMonitorKeys.add(key);
		return true;
	}

	private canEmitTrigger(triggerId: string, triggerCooldownMs?: number): boolean {
		const monitor = this.options.monitor;
		if (!monitor) return true;
		const cooldown = triggerCooldownMs ?? monitor.cooldownMs;
		if (!cooldown || cooldown <= 0) return true;
		const now = Date.now();
		const last = this.triggerLastEmitAt.get(triggerId) ?? 0;
		if (now - last < cooldown) return false;
		this.triggerLastEmitAt.set(triggerId, now);
		return true;
	}

	private emitMonitorEvent(event: MonitorMatchInfo): void {
		try {
			const maybePromise = this.options.onMonitorEvent?.(event);
			if (maybePromise && typeof (maybePromise as Promise<unknown>).then === "function") {
				void (maybePromise as Promise<unknown>).catch((error) => {
					console.error("interactive-shell: monitor event callback error:", error);
				});
			}
		} catch (error) {
			console.error("interactive-shell: monitor event callback error:", error);
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
		if (this.options.monitor?.strategy !== "poll-diff" && this.options.onMonitorEvent) {
			this.processMonitorData("", true);
		}
		this._disposed = true;
		this.stopQuietTimer();
		this.stopPollTimer();
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
		if (this.options.monitor?.strategy !== "poll-diff" && this.options.onMonitorEvent) {
			this.processMonitorData("", true);
		}
		this._disposed = true;
		this.stopQuietTimer();
		this.stopPollTimer();
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
		this.stopPollTimer();
		if (this.timeoutTimer) { clearTimeout(this.timeoutTimer); this.timeoutTimer = null; }
		this.unsubscribe();
	}
}

function normalizeMonitorSnapshot(raw: string): string {
	if (!raw) return "";
	const normalizedLineEndings = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	return normalizedLineEndings
		.replace(/[\t ]+$/gm, "")
		.trimEnd();
}

function summarizeDiff(previous: string, current: string): string {
	if (previous === current) return "No change";
	if (!previous && current) return `Output changed: now has content (${current.length} chars)`;
	if (previous && !current) return "Output changed: now empty";

	const prevLines = previous.split("\n");
	const nextLines = current.split("\n");
	const max = Math.max(prevLines.length, nextLines.length);
	for (let i = 0; i < max; i++) {
		const before = prevLines[i] ?? "";
		const after = nextLines[i] ?? "";
		if (before === after) continue;
		const left = before.length > 120 ? `${before.slice(0, 117)}...` : before;
		const right = after.length > 120 ? `${after.slice(0, 117)}...` : after;
		return `Output changed at line ${i + 1}: "${left}" -> "${right}"`;
	}

	return `Output changed (${previous.length} chars -> ${current.length} chars)`;
}
