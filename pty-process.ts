import { closeSync, openSync, write } from "node:fs";
import { constants as osConstants } from "node:os";
import { spawn as spawnChild, type ChildProcess } from "node:child_process";
import type { Duplex } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { ReadStream } from "node:tty";
import { hasNative, open, spawn, type IPty } from "zigpty";

export type PtyExitEvent = { exitCode: number; signal: number };

export interface PtyProcess {
	readonly pid: number;
	readonly processExited: boolean;
	onData(listener: (data: string | Buffer) => void): { dispose(): void };
	onExit(listener: (event: PtyExitEvent) => void): { dispose(): void };
	write(data: string): void;
	resize(cols: number, rows: number): void;
	kill(signal?: NodeJS.Signals): void;
	close(): void;
}

export interface PtyProcessOptions {
	name: string;
	cols: number;
	rows: number;
	cwd: string;
	env: Record<string, string>;
}

class ZigPtyProcess implements PtyProcess {
	constructor(private readonly pty: IPty) {}

	get pid(): number {
		return this.pty.pid;
	}

	get processExited(): boolean {
		return this.pty.exitCode !== null;
	}

	onData(listener: (data: string | Buffer) => void): { dispose(): void } {
		return this.pty.onData(listener);
	}

	onExit(listener: (event: PtyExitEvent) => void): { dispose(): void } {
		return this.pty.onExit(listener);
	}

	write(data: string): void {
		this.pty.write(data);
	}

	resize(cols: number, rows: number): void {
		this.pty.resize(cols, rows);
	}

	kill(signal: NodeJS.Signals = "SIGHUP"): void {
		if (this.processExited) return;
		const groupError = process.platform !== "win32" && this.pid
			? signalProcessGroup(this.pid, signal)
			: null;
		this.pty.kill(signal);
		if (groupError !== null) throw groupError;
	}

	close(): void {
		this.pty.close();
	}
}

// The double-forked helper stays in the command's process group without becoming
// its child or retaining the PTY slave. Its control pipe pins the PGID until the
// parent has finished natural cleanup or sent the final cancellation signal.
const BOOTSTRAP = `
(
	trap '' HUP INT QUIT TERM
	(
		exec </dev/null >/dev/null 2>&1
		while IFS= read -r _ <&3; do :; done
	) &
) &
pin_launcher=$!
wait "$pin_launcher" || exit 125
exec 3<&-
exec < "$1" > "$1" 2>&1
shift
exec "$@"
`;

const UNIX_SANITIZE_KEYS = [
	"TMUX",
	"TMUX_PANE",
	"STY",
	"WINDOW",
	"WINDOWID",
	"TERMCAP",
	"COLUMNS",
	"LINES",
] as const;

function signalNumber(signal: NodeJS.Signals | null): number {
	return signal ? (osConstants.signals[signal] ?? 0) : 0;
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): unknown | null {
	try {
		process.kill(-pid, signal);
		return null;
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "ESRCH" ? null : error;
	}
}

const ignoreChildProcessError = (): void => {};

// zigpty's openpty descriptors are not close-on-exec. Keep every live raw PTY
// descriptor masked in this adapter's child spawns, including concurrent PTYs.
const rawPtyFdOwners = new Map<number, number>();

function registerRawPtyFd(fd: number): void {
	rawPtyFdOwners.set(fd, (rawPtyFdOwners.get(fd) ?? 0) + 1);
}

function unregisterRawPtyFd(fd: number): void {
	const owners = rawPtyFdOwners.get(fd);
	if (owners === undefined) return;
	if (owners === 1) rawPtyFdOwners.delete(fd);
	else rawPtyFdOwners.set(fd, owners - 1);
}

function maskedChildStdio(firstThree: [number | "ignore", number | "ignore", number | "pipe"], controlPipe: boolean): {
	stdio: Array<number | "ignore" | "pipe" | undefined>;
	nullFd: number;
} {
	const nullFd = openSync("/dev/null", "r+");
	const stdio: Array<number | "ignore" | "pipe" | undefined> = [...firstThree, controlPipe ? "pipe" : nullFd];
	for (const fd of rawPtyFdOwners.keys()) {
		if (fd > 3) stdio[fd] = nullFd;
	}
	return { stdio: Array.from(stdio), nullFd };
}

class LinuxPtyProcess implements PtyProcess {
	readonly pid: number;

	private readonly child: ChildProcess;
	private readonly master: number;
	private readonly ptyPath: string;
	private readonly reader: ReadStream;
	private readonly decoder = new StringDecoder("utf8");
	private readonly groupPin: Duplex;
	private readonly processEstablished: boolean;
	private readonly dataListeners: Array<(data: string | Buffer) => void> = [];
	private readonly exitListeners: Array<(event: PtyExitEvent) => void> = [];
	private childStatus: PtyExitEvent | null = null;
	private outputFinished = false;
	private terminationPending = false;
	private completed = false;
	private closed = false;
	private decoderFlushed = false;
	private resumeImmediate: ReturnType<typeof setImmediate> | null = null;
	private writeQueue = Promise.resolve();
	private pendingResize: { cols: number; rows: number } | null = null;
	private resizeProcess: ChildProcess | null = null;
	private readonly resizeWaiters: Array<() => void> = [];
	private readonly childErrorHandler = (error: Error): void => {
		if (this.processEstablished) {
			console.error("interactive-shell: PTY child process error:", error);
			return;
		}
		this.emitFailure("PTY process failed", error);
		if (this.childStatus === null) {
			this.childStatus = { exitCode: -1, signal: 0 };
			this.tryComplete();
		}
	};
	private readonly childExitHandler = (code: number | null, signal: NodeJS.Signals | null): void => {
		if (this.childStatus !== null) return;
		this.childStatus = {
			exitCode: code ?? 0,
			signal: signalNumber(signal),
		};
		this.tryComplete();
	};

	constructor(file: string, args: string[], options: PtyProcessOptions) {
		const opened = open({ cols: options.cols, rows: options.rows });
		registerRawPtyFd(opened.master);
		registerRawPtyFd(opened.slave);
		this.master = opened.master;
		this.ptyPath = opened.pty;
		const childEnv = { ...options.env };
		for (const key of UNIX_SANITIZE_KEYS) delete childEnv[key];

		let nullFd: number | null = null;
		try {
			const masked = maskedChildStdio([opened.slave, opened.slave, opened.slave], true);
			nullFd = masked.nullFd;
			this.child = spawnChild(
				"/bin/sh",
				["-c", BOOTSTRAP, "pty-bootstrap", opened.pty, file, ...args],
				{
					cwd: options.cwd,
					env: childEnv,
					detached: true,
					stdio: masked.stdio,
				},
			);
		} catch (error) {
			closeSync(opened.slave);
			closeSync(opened.master);
			unregisterRawPtyFd(opened.slave);
			unregisterRawPtyFd(opened.master);
			throw error;
		} finally {
			if (nullFd !== null) closeSync(nullFd);
		}

		closeSync(opened.slave);
		unregisterRawPtyFd(opened.slave);
		this.pid = this.child.pid ?? 0;
		this.processEstablished = this.pid !== 0;
		const groupPin = this.child.stdio[3];
		if (!groupPin) {
			closeSync(this.master);
			unregisterRawPtyFd(this.master);
			this.child.kill("SIGKILL");
			throw new Error("Failed to establish PTY process-group ownership");
		}
		this.groupPin = groupPin as Duplex;

		try {
			this.reader = new ReadStream(this.master, {
				onread: {
					buffer: Buffer.allocUnsafe(64 * 1024),
					callback: (bytesRead, buffer) => {
						if (!this.closed && !this.outputFinished && bytesRead > 0) {
							const data = this.decoder.write(Buffer.from(buffer.subarray(0, bytesRead)));
							this.scheduleReaderResume();
							this.emitDecoded(data);
						}
						return false;
					},
				},
			});
		} catch (error) {
			try {
				if (this.pid) process.kill(-this.pid, "SIGKILL");
				else this.child.kill("SIGKILL");
			} catch {
				this.child.kill("SIGKILL");
			}
			closeSync(this.master);
			unregisterRawPtyFd(this.master);
			throw error;
		}
		this.reader.once("close", () => unregisterRawPtyFd(this.master));
		this.reader.on("end", () => this.finishOutput());
		this.reader.on("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "EIO") {
				this.finishOutput();
				return;
			}
			this.emitFailure("PTY read failed", error);
			this.finishOutput();
		});

		this.child.once("exit", this.childExitHandler);
		this.child.on("error", this.childErrorHandler);
		this.scheduleReaderResume();
	}

	get processExited(): boolean {
		return this.childStatus !== null;
	}

	onData(listener: (data: string | Buffer) => void): { dispose(): void } {
		this.dataListeners.push(listener);
		return {
			dispose: () => {
				const index = this.dataListeners.indexOf(listener);
				if (index >= 0) this.dataListeners.splice(index, 1);
			},
		};
	}

	onExit(listener: (event: PtyExitEvent) => void): { dispose(): void } {
		this.exitListeners.push(listener);
		return {
			dispose: () => {
				const index = this.exitListeners.indexOf(listener);
				if (index >= 0) this.exitListeners.splice(index, 1);
			},
		};
	}

	write(data: string): void {
		if (this.closed || this.outputFinished) return;
		const bytes = Buffer.from(data, "utf8");
		this.writeQueue = this.writeQueue
			.then(async () => {
				await this.waitForResize();
				await this.writeAll(bytes);
			})
			.catch((error: unknown) => {
				if (!this.closed) console.error("PTY write failed:", error);
			});
	}

	resize(cols: number, rows: number): void {
		if (this.closed || this.outputFinished) return;
		this.pendingResize = { cols, rows };
		this.startNextResize();
	}

	kill(signal: NodeJS.Signals = "SIGHUP"): void {
		if (this.closed) return;
		if (signal !== "SIGKILL") this.terminationPending = true;
		const groupError = this.pid && !this.groupPin.destroyed
			? signalProcessGroup(this.pid, signal)
			: null;
		let childError: unknown | null = null;
		try {
			if (!this.processExited && !this.child.kill(signal)) {
				childError = new Error(`Direct PTY child ${signal} request was not accepted`);
			}
		} catch (error) {
			childError = error;
		}
		if (signal === "SIGKILL") {
			this.terminationPending = false;
			if (groupError === null) this.releaseGroupPin();
			this.tryComplete();
		}
		if (groupError !== null) throw groupError;
		if (childError !== null) throw childError;
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.resumeImmediate !== null) {
			clearImmediate(this.resumeImmediate);
			this.resumeImmediate = null;
		}
		this.pendingResize = null;
		this.resizeProcess?.kill("SIGKILL");
		this.resizeProcess = null;
		this.resolveResizeWaiters();
		this.releaseGroupPin();
		this.dataListeners.length = 0;
		this.exitListeners.length = 0;
		this.child.removeListener("error", this.childErrorHandler);
		this.child.removeListener("exit", this.childExitHandler);
		this.child.on("error", ignoreChildProcessError);
		this.reader.destroy();
	}

	private finishOutput(): void {
		if (this.closed || this.outputFinished) return;
		if (this.resumeImmediate !== null) {
			clearImmediate(this.resumeImmediate);
			this.resumeImmediate = null;
		}
		if (!this.decoderFlushed) {
			this.decoderFlushed = true;
			this.emitDecoded(this.decoder.end());
		}
		this.outputFinished = true;
		this.pendingResize = null;
		this.resolveResizeWaiters();
		this.tryComplete();
	}

	private emitDecoded(data: string): void {
		if (!data || this.closed || this.outputFinished) return;
		for (const listener of [...this.dataListeners]) {
			if (this.closed) break;
			listener(data);
		}
	}

	private scheduleReaderResume(): void {
		if (this.closed || this.outputFinished || this.reader.destroyed || this.resumeImmediate !== null) return;
		this.resumeImmediate = setImmediate(() => {
			this.resumeImmediate = null;
			if (!this.closed && !this.outputFinished && !this.reader.destroyed) this.reader.resume();
		});
	}

	private emitFailure(label: string, error: Error): void {
		if (this.closed) return;
		const message = `\n[${label}: ${error.message}]\n`;
		for (const listener of [...this.dataListeners]) listener(message);
	}

	private tryComplete(): void {
		if (this.closed || this.completed || this.terminationPending || !this.outputFinished || this.childStatus === null) return;
		this.completed = true;
		this.releaseGroupPin();
		const status = this.childStatus;
		const listeners = [...this.exitListeners];
		this.dataListeners.length = 0;
		this.exitListeners.length = 0;
		for (const listener of listeners) listener(status);
	}

	private writeAll(bytes: Buffer): Promise<void> {
		return new Promise((resolve, reject) => {
			let offset = 0;
			const next = (): void => {
				if (this.closed || this.outputFinished) {
					resolve();
					return;
				}
				write(this.master, bytes, offset, bytes.length - offset, null, (error, written) => {
					if (error) {
						if (error.code === "EAGAIN" || error.code === "EWOULDBLOCK") {
							setImmediate(next);
							return;
						}
						reject(error);
						return;
					}
					offset += written;
					if (offset === bytes.length) resolve();
					else setImmediate(next);
				});
			};
			next();
		});
	}

	private startNextResize(): void {
		if (this.closed || this.outputFinished || this.resizeProcess !== null || this.pendingResize === null) return;
		const { cols, rows } = this.pendingResize;
		this.pendingResize = null;
		let stderr = "";
		let settled = false;
		try {
			const masked = maskedChildStdio(["ignore", "ignore", "pipe"], false);
			let child: ChildProcess;
			try {
				child = spawnChild(
					"/usr/bin/stty",
					["-F", this.ptyPath, "rows", String(rows), "cols", String(cols)],
					{ stdio: masked.stdio },
				);
			} finally {
				closeSync(masked.nullFd);
			}
			this.resizeProcess = child;
			child.stderr?.setEncoding("utf8");
			child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
			child.once("error", (error) => {
				if (settled) return;
				settled = true;
				this.finishResize(error);
			});
			child.once("close", (code) => {
				if (settled) return;
				settled = true;
				this.finishResize(code === 0 ? null : new Error(stderr.trim() || `stty exited with code ${code}`));
			});
		} catch (error) {
			this.finishResize(error instanceof Error ? error : new Error(String(error)));
		}
	}

	private finishResize(error: Error | null): void {
		this.resizeProcess = null;
		if (error && !this.closed) console.error("interactive-shell: PTY resize failed:", error);
		if (this.pendingResize !== null && !this.closed) this.startNextResize();
		else this.resolveResizeWaiters();
	}

	private waitForResize(): Promise<void> {
		if (this.resizeProcess === null && this.pendingResize === null) return Promise.resolve();
		return new Promise((resolve) => this.resizeWaiters.push(resolve));
	}

	private resolveResizeWaiters(): void {
		for (const resolve of this.resizeWaiters.splice(0)) resolve();
	}

	private releaseGroupPin(): void {
		if (this.groupPin.destroyed) return;
		this.groupPin.destroy();
	}
}

export function createPtyProcess(file: string, args: string[], options: PtyProcessOptions): PtyProcess {
	if (process.platform === "linux") {
		if (!hasNative) {
			throw new Error("Linux interactive sessions require zigpty native PTY bindings; reinstall zigpty for this platform or provide a compatible native build.");
		}
		return new LinuxPtyProcess(file, args, options);
	}
	return new ZigPtyProcess(spawn(file, args, options));
}
