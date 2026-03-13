import { stripVTControlCharacters } from "node:util";
import * as pty from "node-pty";
import type { IBufferCell, Terminal as XtermTerminal } from "@xterm/headless";
import xterm from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { sliceLogOutput, trimRawOutput } from "./pty-log.js";
import { splitAroundDsr, buildCursorPositionResponse } from "./pty-protocol.js";
import { ensureSpawnHelperExec } from "./spawn-helper.js";

const Terminal = xterm.Terminal;

// Regex patterns for sanitizing terminal output (used by sanitizeLine for viewport rendering)
const OSC_REGEX = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
const APC_REGEX = /\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)/g;
const DCS_REGEX = /\x1bP[^\x07\x1b]*(?:\x07|\x1b\\)/g;
const CSI_REGEX = /\x1b\[[0-9;?]*[A-Za-z]/g;
const ESC_SINGLE_REGEX = /\x1b[@-_]/g;
const CONTROL_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1A\x1C-\x1F\x7F]/g;


function sanitizeLine(line: string): string {
	let out = line;
	if (out.includes("\u001b")) {
		out = out.replace(OSC_REGEX, "");
		out = out.replace(APC_REGEX, "");
		out = out.replace(DCS_REGEX, "");
		out = out.replace(CSI_REGEX, (match) => (match.endsWith("m") ? match : ""));
		out = out.replace(ESC_SINGLE_REGEX, "");
	}
	if (out.includes("\t")) {
		out = out.replace(/\t/g, "   ");
	}
	if (out.includes("\r")) {
		out = out.replace(/\r/g, "");
	}
	out = out.replace(CONTROL_REGEX, "");
	return out;
}

type CellStyle = {
	bold: boolean;
	dim: boolean;
	italic: boolean;
	underline: boolean;
	inverse: boolean;
	invisible: boolean;
	strikethrough: boolean;
	fgMode: "default" | "palette" | "rgb";
	fg: number;
	bgMode: "default" | "palette" | "rgb";
	bg: number;
};

function styleKey(style: CellStyle): string {
	return [
		style.bold ? "b" : "-",
		style.dim ? "d" : "-",
		style.italic ? "i" : "-",
		style.underline ? "u" : "-",
		style.inverse ? "v" : "-",
		style.invisible ? "x" : "-",
		style.strikethrough ? "s" : "-",
		`fg:${style.fgMode}:${style.fg}`,
		`bg:${style.bgMode}:${style.bg}`,
	].join("");
}

function rgbToSgr(isFg: boolean, hex: number): string {
	const r = (hex >> 16) & 0xff;
	const g = (hex >> 8) & 0xff;
	const b = hex & 0xff;
	return isFg ? `38;2;${r};${g};${b}` : `48;2;${r};${g};${b}`;
}

function paletteToSgr(isFg: boolean, idx: number): string {
	return isFg ? `38;5;${idx}` : `48;5;${idx}`;
}

function sgrForStyle(style: CellStyle): string {
	const parts: string[] = ["0"];
	if (style.bold) parts.push("1");
	if (style.dim) parts.push("2");
	if (style.italic) parts.push("3");
	if (style.underline) parts.push("4");
	if (style.inverse) parts.push("7");
	if (style.invisible) parts.push("8");
	if (style.strikethrough) parts.push("9");

	if (style.fgMode === "rgb") parts.push(rgbToSgr(true, style.fg));
	else if (style.fgMode === "palette") parts.push(paletteToSgr(true, style.fg));

	if (style.bgMode === "rgb") parts.push(rgbToSgr(false, style.bg));
	else if (style.bgMode === "palette") parts.push(paletteToSgr(false, style.bg));

	return `\u001b[${parts.join(";")}m`;
}

function normalizePaletteColor(mode: "default" | "palette" | "rgb", value: number): { mode: "default" | "palette" | "rgb"; value: number } {
	if (mode !== "palette") return { mode, value };
	// xterm uses special palette values (>= 256) to represent defaults/specials; do not emit invalid 38;5;N codes.
	if (value < 0 || value > 255) {
		return { mode: "default", value: 0 };
	}
	return { mode: "palette", value };
}

export interface PtySessionOptions {
	command: string;
	shell?: string;
	cwd?: string;
	env?: Record<string, string | undefined>;
	cols?: number;
	rows?: number;
	scrollback?: number;
	ansiReemit?: boolean;
}

export interface PtySessionEvents {
	onData?: (data: string) => void;
	onExit?: (exitCode: number, signal?: number) => void;
}

// Simple write queue to ensure ordered writes to terminal
class WriteQueue {
	private queue = Promise.resolve();

	enqueue(fn: () => Promise<void> | void): void {
		this.queue = this.queue.then(() => fn()).catch((err) => {
			console.error("WriteQueue error:", err);
		});
	}

	async drain(): Promise<void> {
		await this.queue;
	}
}

export class PtyTerminalSession {
	private ptyProcess: pty.IPty;
	private xterm: XtermTerminal;
	private serializer: SerializeAddon | null = null;
	private _exited = false;
	private _exitCode: number | null = null;
	private _signal: number | undefined;
	private scrollOffset = 0;
	private followBottom = true; // Auto-scroll to bottom when new data arrives

	// Raw output buffer for incremental streaming
	private rawOutput = "";
	private lastStreamPosition = 0;

	// Write queue for ordered terminal writes
	private writeQueue = new WriteQueue();

	private dataHandler: ((data: string) => void) | undefined;
	private exitHandler: ((exitCode: number, signal?: number) => void) | undefined;
	private additionalDataListeners: Array<(data: string) => void> = [];
	private additionalExitListeners: Array<(exitCode: number, signal?: number) => void> = [];

	// Trim raw output buffer if it exceeds max size
	private trimRawOutputIfNeeded(): void {
		const trimmed = trimRawOutput(this.rawOutput, this.lastStreamPosition);
		this.rawOutput = trimmed.rawOutput;
		this.lastStreamPosition = trimmed.lastStreamPosition;
	}

	constructor(options: PtySessionOptions, events: PtySessionEvents = {}) {
		const {
			command,
			cwd = process.cwd(),
			env,
			cols = 80,
			rows = 24,
			scrollback = 5000,
			ansiReemit = true,
		} = options;

		this.dataHandler = events.onData;
		this.exitHandler = events.onExit;

		this.xterm = new Terminal({ cols, rows, scrollback, allowProposedApi: true, convertEol: true });
		if (ansiReemit) {
			this.serializer = new SerializeAddon();
			this.xterm.loadAddon(this.serializer);
		}

		const shell =
			options.shell ??
			(process.platform === "win32"
				? process.env.COMSPEC || "cmd.exe"
				: process.env.SHELL || "/bin/sh");
		const shellArgs = process.platform === "win32" ? ["/c", command] : ["-c", command];

		const mergedEnv = env ? { ...process.env, ...env } : { ...process.env };
		if (!mergedEnv.TERM) mergedEnv.TERM = "xterm-256color";

		ensureSpawnHelperExec();

		this.ptyProcess = pty.spawn(shell, shellArgs, {
			name: "xterm-256color",
			cols,
			rows,
			cwd,
			env: mergedEnv,
		});

		this.ptyProcess.onData((data) => {
			// Handle DSR (Device Status Report) cursor position queries
			// TUI apps send ESC[6n or ESC[?6n expecting ESC[row;colR response
			// We must process in order: write text to xterm, THEN respond to DSR
			const { segments, hasDsr } = splitAroundDsr(data);

			if (!hasDsr) {
				// Fast path: no DSR in data
				this.writeQueue.enqueue(async () => {
					this.rawOutput += data;
					this.trimRawOutputIfNeeded();
					await new Promise<void>((resolve) => {
						this.xterm.write(data, () => resolve());
					});
					this.notifyDataListeners(data);
				});
			} else {
				// Process each segment in order, responding to DSR after writing preceding text
				for (const segment of segments) {
					this.writeQueue.enqueue(async () => {
						if (segment.text) {
							this.rawOutput += segment.text;
							this.trimRawOutputIfNeeded();
							await new Promise<void>((resolve) => {
								this.xterm.write(segment.text, () => resolve());
							});
							this.notifyDataListeners(segment.text);
						}
						// If there was a DSR after this segment, respond with current cursor position
						if (segment.dsrAfter) {
							const buffer = this.xterm.buffer.active;
							const response = buildCursorPositionResponse(buffer.cursorY + 1, buffer.cursorX + 1);
							this.ptyProcess.write(response);
						}
					});
				}
			}
		});

		this.ptyProcess.onExit(({ exitCode, signal }) => {
			this._exited = true;
			this._exitCode = exitCode;
			this._signal = signal;

			// Append exit message to terminal buffer, then notify handler after queue drains
			const exitMsg = `\n[Process exited with code ${exitCode}${signal ? ` (signal: ${signal})` : ""}]\n`;
			this.writeQueue.enqueue(async () => {
				this.rawOutput += exitMsg;
				await new Promise<void>((resolve) => {
					this.xterm.write(exitMsg, () => resolve());
				});
			});

			// Wait for writeQueue to drain before calling exit listeners
			// This ensures exit message is in rawOutput and xterm buffer
			this.writeQueue.drain().then(() => {
				this.notifyExitListeners(exitCode, signal);
			});
		});
	}

	setEventHandlers(events: PtySessionEvents): void {
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

	addExitListener(cb: (exitCode: number, signal?: number) => void): () => void {
		this.additionalExitListeners.push(cb);
		return () => {
			const idx = this.additionalExitListeners.indexOf(cb);
			if (idx >= 0) this.additionalExitListeners.splice(idx, 1);
		};
	}

	private notifyDataListeners(data: string): void {
		this.dataHandler?.(data);
		// Copy array to avoid issues if a listener unsubscribes during iteration
		for (const listener of [...this.additionalDataListeners]) {
			listener(data);
		}
	}

	private notifyExitListeners(exitCode: number, signal?: number): void {
		this.exitHandler?.(exitCode, signal);
		// Copy array to avoid issues if a listener unsubscribes during iteration
		for (const listener of [...this.additionalExitListeners]) {
			listener(exitCode, signal);
		}
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
		return this.ptyProcess.pid;
	}
	get cols(): number {
		return this.xterm.cols;
	}
	get rows(): number {
		return this.xterm.rows;
	}

	write(data: string): void {
		if (!this._exited) {
			this.ptyProcess.write(data);
		}
	}

	resize(cols: number, rows: number): void {
		if (cols === this.xterm.cols && rows === this.xterm.rows) return;
		if (cols < 1 || rows < 1) return;
		this.xterm.resize(cols, rows);
		if (!this._exited) {
			this.ptyProcess.resize(cols, rows);
		}
	}

	private renderLineFromCells(lineIndex: number, cols: number): string {
		const buffer = this.xterm.buffer.active;
		const line = buffer.getLine(lineIndex);

		let currentStyle: CellStyle = {
			bold: false,
			dim: false,
			italic: false,
			underline: false,
			inverse: false,
			invisible: false,
			strikethrough: false,
			fgMode: "default",
			fg: 0,
			bgMode: "default",
			bg: 0,
		};
		let currentKey = styleKey(currentStyle);

		let out = sgrForStyle(currentStyle);

		for (let x = 0; x < cols; x++) {
			const cell: IBufferCell | undefined = line?.getCell(x);
			const width = cell?.getWidth() ?? 1;
			if (width === 0) continue;

			const chars = cell?.getChars() ?? " ";
			const cellChars = chars.length === 0 ? " " : chars;

			const rawFgMode: CellStyle["fgMode"] = cell?.isFgDefault()
				? "default"
				: cell?.isFgRGB()
					? "rgb"
					: cell?.isFgPalette()
						? "palette"
						: "default";
			const rawBgMode: CellStyle["bgMode"] = cell?.isBgDefault()
				? "default"
				: cell?.isBgRGB()
					? "rgb"
					: cell?.isBgPalette()
						? "palette"
						: "default";

			const fg = normalizePaletteColor(rawFgMode, cell?.getFgColor() ?? 0);
			const bg = normalizePaletteColor(rawBgMode, cell?.getBgColor() ?? 0);

			const nextStyle: CellStyle = {
				bold: !!cell?.isBold(),
				dim: !!cell?.isDim(),
				italic: !!cell?.isItalic(),
				underline: !!cell?.isUnderline(),
				inverse: !!cell?.isInverse(),
				invisible: !!cell?.isInvisible(),
				strikethrough: !!cell?.isStrikethrough(),
				fgMode: fg.mode,
				fg: fg.value,
				bgMode: bg.mode,
				bg: bg.value,
			};
			const nextKey = styleKey(nextStyle);
			if (nextKey !== currentKey) {
				currentStyle = nextStyle;
				currentKey = nextKey;
				out += sgrForStyle(currentStyle);
			}

			out += cellChars;
		}

		return out + "\u001b[0m";
	}

	getViewportLines(options: { ansi?: boolean } = {}): string[] {
		const buffer = this.xterm.buffer.active;
		const lines: string[] = [];

		const totalLines = buffer.length;
		// If following bottom, reset scroll offset at render time (not on each data event)
		// This prevents flickering from scroll position racing with buffer updates
		if (this.followBottom) {
			this.scrollOffset = 0;
		}
		const viewportStart = Math.max(0, totalLines - this.xterm.rows - this.scrollOffset);

		const useAnsi = !!options.ansi;
		if (useAnsi) {
			for (let i = 0; i < this.xterm.rows; i++) {
				const lineIndex = viewportStart + i;
				const rendered = this.renderLineFromCells(lineIndex, this.xterm.cols);

				// Safety fallback: if our cell->SGR renderer produces no visible non-space content
				// but the buffer line contains text, fall back to plain translation. This prevents
				// “blank screen” regressions on terminals that use special color encodings.
				const plain = buffer.getLine(lineIndex)?.translateToString(true) ?? "";
				const renderedPlain = rendered
					.replace(/\x1b\[[0-9;]*m/g, "")
					.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "");
				if (plain.trim().length > 0 && renderedPlain.trim().length === 0) {
					lines.push(sanitizeLine(plain) + "\u001b[0m");
				} else {
					lines.push(rendered);
				}
			}
			return lines;
		}

		for (let i = 0; i < this.xterm.rows; i++) {
			const lineIndex = viewportStart + i;
			if (lineIndex < totalLines) {
				const line = buffer.getLine(lineIndex);
				lines.push(sanitizeLine(line?.translateToString(true) ?? ""));
			} else {
				lines.push("");
			}
		}

		return lines;
	}

	getTailLines(options: { lines: number; ansi?: boolean; maxChars?: number }): {
		lines: string[];
		totalLinesInBuffer: number;
		truncatedByChars: boolean;
	} {
		const requested = Math.max(0, Math.trunc(options.lines));
		const maxChars = options.maxChars !== undefined ? Math.max(0, Math.trunc(options.maxChars)) : undefined;
		
		const buffer = this.xterm.buffer.active;
		const totalLinesInBuffer = buffer.length;
		
		if (requested === 0) {
			return { lines: [], totalLinesInBuffer, truncatedByChars: false };
		}

		const start = Math.max(0, totalLinesInBuffer - requested);
		const out: string[] = [];
		let remainingChars = maxChars;
		let truncatedByChars = false;

		const useAnsi = options.ansi && this.serializer;
		if (useAnsi) {
			const serialized = this.serializer!.serialize();
			const serializedLines = serialized.split(/\r?\n/);
			if (serializedLines.length >= totalLinesInBuffer) {
				for (let i = start; i < totalLinesInBuffer; i++) {
					const raw = serializedLines[i] ?? "";
					const line = sanitizeLine(raw) + "\u001b[0m";
					if (remainingChars !== undefined) {
						if (remainingChars <= 0) {
							truncatedByChars = true;
							break;
						}
						remainingChars -= line.length;
					}
					out.push(line);
				}
				return { lines: out, totalLinesInBuffer, truncatedByChars };
			}
		}

		for (let i = start; i < totalLinesInBuffer; i++) {
			const lineObj = buffer.getLine(i);
			const line = sanitizeLine(lineObj?.translateToString(true) ?? "");
			if (remainingChars !== undefined) {
				if (remainingChars <= 0) {
					truncatedByChars = true;
					break;
				}
				remainingChars -= line.length;
			}
			out.push(line);
		}

		return { lines: out, totalLinesInBuffer, truncatedByChars };
	}

	/**
	 * Get raw output stream with optional incremental reading.
	 * @param options.sinceLast - If true, only return output since last call
	 * @param options.stripAnsi - If true, strip ANSI escape codes (default: true)
	 */
	getRawStream(options: { sinceLast?: boolean; stripAnsi?: boolean } = {}): string {
		let output: string;

		if (options.sinceLast) {
			output = this.rawOutput.substring(this.lastStreamPosition);
			this.lastStreamPosition = this.rawOutput.length;
		} else {
			output = this.rawOutput;
		}

		// Strip ANSI codes and control characters by default using Node.js built-in
		if (options.stripAnsi !== false && output) {
			output = stripVTControlCharacters(output);
		}

		return output;
	}

	/**
	 * Get a slice of log output with offset/limit pagination.
	 * Similar to Clawdbot's sliceLogLines - enables reading specific ranges of output.
	 * @param options.offset - Line number to start from (0-indexed). If omitted with limit, returns tail.
	 * @param options.limit - Max number of lines to return
	 * @param options.stripAnsi - If true, strip ANSI escape codes (default: true)
	 */
	getLogSlice(options: { offset?: number; limit?: number; stripAnsi?: boolean } = {}): {
		slice: string;
		totalLines: number;
		totalChars: number;
		sliceLineCount: number;
	} {
		return sliceLogOutput(this.rawOutput, options);
	}

	scrollUp(lines: number): void {
		const buffer = this.xterm.buffer.active;
		const maxScroll = Math.max(0, buffer.length - this.xterm.rows);
		this.scrollOffset = Math.min(this.scrollOffset + lines, maxScroll);
		this.followBottom = false; // User scrolled up, stop auto-following
	}

	scrollDown(lines: number): void {
		this.scrollOffset = Math.max(0, this.scrollOffset - lines);
		// If scrolled to bottom, resume auto-following
		if (this.scrollOffset === 0) {
			this.followBottom = true;
		}
	}

	scrollToBottom(): void {
		this.scrollOffset = 0;
		this.followBottom = true;
	}

	isScrolledUp(): boolean {
		return this.scrollOffset > 0;
	}

	kill(signal: string = "SIGTERM"): void {
		if (this._exited) return;

		const pid = this.ptyProcess.pid;

		// Try to kill the entire process tree (prevents orphan child processes)
		if (process.platform !== "win32" && pid) {
			try {
				// Kill process group (negative PID)
				process.kill(-pid, signal as NodeJS.Signals);
				return;
			} catch {
				// Fall through to direct kill
			}
		}

		// Direct kill as fallback
		try {
			this.ptyProcess.kill(signal);
		} catch {
			// Process may already be dead
		}
	}

	dispose(): void {
		this.kill();
		this.xterm.dispose();
	}
}
