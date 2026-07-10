export interface TerminalSessionOptions {
	id?: string;
	command: string;
	shell?: string;
	cwd?: string;
	env?: Record<string, string | undefined>;
	cols?: number;
	rows?: number;
	scrollback?: number;
	ansiReemit?: boolean;
	title?: string;
	reason?: string;
	focus?: boolean;
}

export interface TerminalSessionEvents {
	onData?: (data: string) => void;
	onExit?: (exitCode: number | null, signal?: number) => void;
}

export interface TerminalSession {
	readonly ready: Promise<void>;
	readonly exited: boolean;
	readonly exitCode: number | null;
	readonly signal: number | undefined;
	readonly pid: number;
	readonly cols: number;
	readonly rows: number;
	setEventHandlers(events: TerminalSessionEvents): void;
	addDataListener(cb: (data: string) => void): () => void;
	addExitListener(cb: (exitCode: number | null, signal?: number) => void): () => void;
	write(data: string): void;
	sendText?(text: string): void;
	sendKeys?(keys: string[]): void;
	paste?(text: string): void;
	writeAsync?(data: string): Promise<void>;
	sendKeysAsync?(keys: string[]): Promise<void>;
	pasteAsync?(text: string): Promise<void>;
	focus?(): Promise<void>;
	resize(cols: number, rows: number): void;
	/** Live kitty get-text (viewport). Falls back to last successful fetch if the window is gone. */
	getViewportLines(options?: { ansi?: boolean }): Promise<string[]>;
	/** Live kitty get-text (tail). Falls back to last successful fetch if the window is gone. */
	getTailLines(options: { lines: number; ansi?: boolean; maxChars?: number }): Promise<{
		lines: string[];
		totalLinesInBuffer: number;
		truncatedByChars: boolean;
	}>;
	/** Append-only local stream (poll deltas / data listeners). Not a full scrollback source. */
	getRawStream(options?: { sinceLast?: boolean; stripAnsi?: boolean }): string;
	/** Live kitty get-text log slice. Falls back to last successful fetch if the window is gone. */
	getLogSlice(options?: { offset?: number; limit?: number; stripAnsi?: boolean }): Promise<{
		slice: string;
		totalLines: number;
		totalChars: number;
		sliceLineCount: number;
	}>;
	scrollUp(lines: number): void;
	scrollDown(lines: number): void;
	scrollToBottom(): void;
	isScrolledUp(): boolean;
	kill(signal?: string): void;
	dispose(): void;
}
