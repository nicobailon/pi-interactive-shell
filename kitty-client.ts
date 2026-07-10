import { createCipheriv, createHash, createPublicKey, diffieHellman, generateKeyPairSync, randomBytes } from "node:crypto";
import net from "node:net";
import type { InteractiveShellConfig } from "./config.js";

const DCS_PREFIX = "\x1bP@kitty-cmd";
const DCS_SUFFIX = "\x1b\\";
const DCS_RESPONSE_RE = /\x1bP@kitty-cmd([^\x1b]+)\x1b\\/s;
const PYTHON_B85_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~";
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

export type KittyVersion = [number, number, number];

export interface KittyCommand {
	cmd: string;
	version?: KittyVersion;
	no_response?: boolean;
	kitty_window_id?: number;
	payload?: unknown;
	async?: string;
	cancel_async?: boolean;
	stream?: boolean;
	stream_id?: string;
}

export interface KittyResponse<T = unknown> {
	ok: boolean;
	data?: T;
	error?: string;
	tb?: string;
	stream?: boolean;
}

type SocketTarget = { kind: "unix"; path: string } | { kind: "tcp"; host: string; port: number };

export class KittyRemoteControlError extends Error {
	readonly response?: KittyResponse;

	constructor(message: string, response?: KittyResponse) {
		super(message);
		this.name = "KittyRemoteControlError";
		this.response = response;
	}
}

export class KittyClient {
	private readonly listenOn: string;
	private readonly version: KittyVersion;
	private readonly password: string | undefined;
	private readonly publicKey: string | undefined;
	private readonly responseTimeoutMs: number;
	private readonly connectTimeoutMs: number;

	constructor(config?: Pick<InteractiveShellConfig, "kitty">) {
		const kitty = config?.kitty;
		this.listenOn = kitty?.listenOn ?? process.env.KITTY_LISTEN_ON ?? "";
		this.version = kitty?.version ?? [0, 47, 4];
		this.password = kitty?.remoteControlPassword ?? process.env.KITTY_RC_PASSWORD;
		this.publicKey = kitty?.publicKey ?? process.env.KITTY_PUBLIC_KEY;
		this.responseTimeoutMs = kitty?.responseTimeoutMs ?? 5000;
		this.connectTimeoutMs = kitty?.connectTimeoutMs ?? 5000;
	}

	async command<T = unknown>(command: KittyCommand): Promise<KittyResponse<T>> {
		if (!this.listenOn) {
			throw new KittyRemoteControlError(
				"kitty remote control socket is not configured. Set KITTY_LISTEN_ON or interactive-kitty.json kitty.listenOn.",
			);
		}

		const request: KittyCommand = {
			version: this.version,
			...command,
		};
		const wireCommand = this.password ? this.encryptCommand(request) : request;
		const payload = Buffer.from(`${DCS_PREFIX}${JSON.stringify(wireCommand)}${DCS_SUFFIX}`, "utf8");
		if (request.no_response) {
			await this.sendNoResponse(payload);
			return { ok: true } as KittyResponse<T>;
		}
		const raw = await this.sendAndReceive(payload);
		const match = DCS_RESPONSE_RE.exec(raw);
		if (!match) {
			throw new KittyRemoteControlError("kitty remote control connection closed without a command response.");
		}
		let response: KittyResponse<T>;
		try {
			response = JSON.parse(match[1]) as KittyResponse<T>;
		} catch (error) {
			const snippet = match[1].length > 200 ? `${match[1].slice(0, 200)}...` : match[1];
			throw new KittyRemoteControlError(
				`Failed to parse kitty remote control response JSON: ${error instanceof Error ? error.message : String(error)}. Payload snippet: ${snippet}`,
			);
		}
		if (!response.ok) {
			throw new KittyRemoteControlError(response.error ?? "kitty remote control command failed.", response);
		}
		return response;
	}

	async ls(options: { self?: boolean; match?: string; matchTab?: string; allEnvVars?: boolean } = {}): Promise<KittyOsWindow[]> {
		const response = await this.command<string>({
			cmd: "ls",
			payload: {
				self: options.self === true,
				match: options.match,
				match_tab: options.matchTab,
				all_env_vars: options.allEnvVars === true,
			},
		});
		if (typeof response.data !== "string") return [];
		try {
			return JSON.parse(response.data) as KittyOsWindow[];
		} catch (error) {
			const snippet = response.data.length > 200 ? `${response.data.slice(0, 200)}...` : response.data;
			throw new KittyRemoteControlError(
				`Failed to parse kitty ls response JSON: ${error instanceof Error ? error.message : String(error)}. Payload snippet: ${snippet}`,
				response,
			);
		}
	}

	async launch(payload: KittyLaunchPayload): Promise<number> {
		const response = await this.command<string>({
			cmd: "launch",
			payload,
		});
		const id = Number(response.data);
		if (!Number.isFinite(id) || id <= 0) {
			throw new KittyRemoteControlError(`kitty launch returned an invalid window id: ${String(response.data)}`);
		}
		return id;
	}

	/**
	 * Apply config overrides to the connected kitty instance (same as `kitten @ load-config -o name=value`).
	 * Overrides affect newly created windows (e.g. `scrollback_lines`); existing windows keep their buffers.
	 */
	async loadConfig(
		options: {
			paths?: string[];
			overrides?: string[];
			ignoreOverrides?: boolean;
		} = {},
	): Promise<void> {
		await this.command({
			cmd: "load-config",
			payload: {
				paths: options.paths ?? [],
				override: options.overrides ?? [],
				ignore_overrides: options.ignoreOverrides === true,
			},
		});
	}

	async getText(windowId: number, options: { extent?: "screen" | "all"; ansi?: boolean } = {}): Promise<string> {
		const response = await this.command<string>({
			cmd: "get-text",
			payload: {
				match: `id:${windowId}`,
				extent: options.extent ?? "all",
				ansi: options.ansi === true,
				cursor: false,
				wrap_markers: false,
				clear_selection: false,
				self: false,
			},
		});
		if (typeof response.data !== "string") {
			throw new KittyRemoteControlError(
				`kitty get-text returned non-string data (${typeof response.data}); refusing to overwrite snapshot baseline.`,
				response,
			);
		}
		return response.data;
	}

	async sendText(windowId: number, data: Buffer | string, options: { bracketedPaste?: "disable" | "auto" | "enable" } = {}): Promise<void> {
		const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
		const chunkSize = 1024;
		const requested = options.bracketedPaste ?? "disable";
		const totalChunks = Math.max(1, Math.ceil(bytes.length / chunkSize));
		// Bracketed-paste must wrap the whole payload atomically. When enabled across
		// multiple chunks, emit `start` on the first, `disable` on middle, `end` on
		// the last — otherwise kitty would re-wrap each chunk as a separate paste.
		for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
			const offset = chunkIndex * chunkSize;
			const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
			await this.command({
				cmd: "send-text",
				no_response: true,
				payload: {
					match: `id:${windowId}`,
					data: `base64:${chunk.toString("base64")}`,
					match_tab: undefined,
					all: false,
					exclude_active: false,
					bracketed_paste: resolveBracketedPaste(requested, chunkIndex, totalChunks),
				},
			});
		}
	}

	async sendKeys(windowId: number, keys: string[]): Promise<void> {
		if (keys.length === 0) return;
		await this.command({
			cmd: "send-key",
			no_response: true,
			payload: {
				match: `id:${windowId}`,
				keys,
				match_tab: undefined,
				all: false,
				exclude_active: false,
			},
		});
	}

	async signalChild(windowId: number, signal: string): Promise<void> {
		await this.command({
			cmd: "signal-child",
			payload: {
				match: `id:${windowId}`,
				self: false,
				signals: [signal.toUpperCase()],
			},
		});
	}

	async closeWindow(windowId: number): Promise<void> {
		await this.command({
			cmd: "close-window",
			payload: {
				match: `id:${windowId}`,
				self: false,
				ignore_no_match: true,
			},
		});
	}

	async focusWindow(windowId: number): Promise<void> {
		await this.command({
			cmd: "focus-window",
			payload: { match: `id:${windowId}` },
		});
	}

	async focusTabForWindow(windowId: number): Promise<void> {
		await this.command({
			cmd: "focus-tab",
			payload: { match: `window_id:${windowId}` },
		});
	}

	private async sendNoResponse(payload: Buffer): Promise<void> {
		const socket = await this.openSocket();
		await new Promise<void>((resolve, reject) => {
			socket.once("error", reject);
			socket.end(payload, () => resolve());
		});
		socket.destroy();
	}

	private async sendAndReceive(payload: Buffer): Promise<string> {
		const socket = await this.openSocket();
		return new Promise<string>((resolve, reject) => {
			const chunks: Buffer[] = [];
			let settled = false;
			const finish = (fn: () => void): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				socket.removeAllListeners("data");
				socket.removeAllListeners("error");
				socket.removeAllListeners("end");
				fn();
			};
			const buffered = () => Buffer.concat(chunks).toString("utf8");
			const timer = setTimeout(() => {
				finish(() => {
					socket.destroy();
					reject(new KittyRemoteControlError(`Timed out waiting for kitty remote control response after ${this.responseTimeoutMs}ms.`));
				});
			}, this.responseTimeoutMs);
			socket.on("data", (chunk: Buffer) => {
				chunks.push(chunk);
				const raw = buffered();
				if (DCS_RESPONSE_RE.test(raw)) {
					finish(() => {
						socket.destroy();
						resolve(raw);
					});
				}
			});
			socket.once("error", (error) => {
				finish(() => reject(error));
			});
			socket.once("end", () => {
				finish(() => resolve(buffered()));
			});
			socket.end(payload);
		});
	}

	private openSocket(): Promise<net.Socket> {
		const target = parseListenOn(this.listenOn);
		return new Promise<net.Socket>((resolve, reject) => {
			const socket =
				target.kind === "unix" ? net.createConnection(target.path) : net.createConnection({ host: target.host, port: target.port });
			let settled = false;
			const settle = (fn: () => void) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				fn();
			};
			const timer = setTimeout(() => {
				settle(() => {
					socket.destroy();
					reject(
						new KittyRemoteControlError(
							`Timed out connecting to kitty remote control socket ${this.listenOn} after ${this.connectTimeoutMs}ms.`,
						),
					);
				});
			}, this.connectTimeoutMs);
			socket.once("connect", () => settle(() => resolve(socket)));
			socket.once("error", (error) => {
				settle(() => {
					socket.destroy();
					reject(new KittyRemoteControlError(`Failed to connect to kitty remote control socket ${this.listenOn}: ${error.message}`));
				});
			});
		});
	}

	private encryptCommand(command: KittyCommand): Record<string, unknown> {
		if (!this.publicKey) {
			throw new KittyRemoteControlError("kitty remote control password was configured, but KITTY_PUBLIC_KEY is unavailable.");
		}
		const [protocol, encodedPublicKey] = this.publicKey.split(":", 2);
		if (protocol !== "1" || !encodedPublicKey) {
			throw new KittyRemoteControlError(`Unsupported KITTY_PUBLIC_KEY protocol: ${protocol || "(missing)"}`);
		}
		const peerPublicKeyRaw = base85Decode(encodedPublicKey);
		const peerPublicKey = createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, peerPublicKeyRaw]), format: "der", type: "spki" });
		const { privateKey, publicKey } = generateKeyPairSync("x25519");
		const publicKeyDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
		const publicKeyRaw = publicKeyDer.subarray(publicKeyDer.length - 32);
		const shared = diffieHellman({ privateKey, publicKey: peerPublicKey });
		const key = createHash("sha256").update(shared).digest();
		const iv = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", key, iv);
		const plaintext = Buffer.from(
			JSON.stringify({
				...command,
				password: this.password,
				timestamp: Date.now() * 1_000_000,
			}),
			"utf8",
		);
		const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
		const tag = cipher.getAuthTag();
		return {
			version: this.version,
			iv: base85Encode(iv),
			tag: base85Encode(tag),
			pubkey: base85Encode(publicKeyRaw),
			encrypted: base85Encode(encrypted),
		};
	}
}

function stripIpv6Brackets(host: string): string {
	if (host.startsWith("[") && host.endsWith("]")) return host.slice(1, -1);
	return host;
}

function parseTcpPort(portText: string, source: string): number {
	const port = Number(portText);
	if (!Number.isInteger(port) || port <= 0 || port > 65535) {
		throw new KittyRemoteControlError(`Invalid kitty tcp listen port: ${source}`);
	}
	return port;
}

function resolveBracketedPaste(requested: "disable" | "auto" | "enable", chunkIndex: number, totalChunks: number): string {
	if (requested !== "enable") return requested;
	if (totalChunks === 1) return "enable";
	if (chunkIndex === 0) return "start";
	if (chunkIndex === totalChunks - 1) return "end";
	return "disable";
}

/**
 * Parse KITTY_LISTEN_ON / kitty.listenOn values.
 * Supports `unix:`, `tcp:`, and `tcp6:` forms (and `tcp://` / `tcp6://` URL forms).
 * IPv6 hosts in bracket form (`tcp:[::1]:12345`, `tcp6:[::1]:12345`) yield host `"::1"` without brackets.
 */
export function parseListenOn(value: string): SocketTarget {
	if (value.startsWith("unix:")) {
		return { kind: "unix", path: value.slice("unix:".length) };
	}
	if (value.startsWith("tcp://") || value.startsWith("tcp6://")) {
		const url = new URL(value);
		// Some Node versions keep brackets on hostname for IPv6; always strip them for net.connect.
		return { kind: "tcp", host: stripIpv6Brackets(url.hostname), port: parseTcpPort(url.port, value) };
	}
	if (value.startsWith("tcp6:") || value.startsWith("tcp:")) {
		const prefix = value.startsWith("tcp6:") ? "tcp6:" : "tcp:";
		const rest = value.slice(prefix.length);
		if (rest.startsWith("[")) {
			const endBracket = rest.indexOf("]");
			if (endBracket <= 1 || !rest.slice(endBracket + 1).startsWith(":")) {
				throw new KittyRemoteControlError(`Invalid kitty tcp listen address: ${value}`);
			}
			return {
				kind: "tcp",
				host: rest.slice(1, endBracket),
				port: parseTcpPort(rest.slice(endBracket + 2), value),
			};
		}
		const idx = rest.lastIndexOf(":");
		if (idx <= 0) throw new KittyRemoteControlError(`Invalid kitty tcp listen address: ${value}`);
		return { kind: "tcp", host: rest.slice(0, idx), port: parseTcpPort(rest.slice(idx + 1), value) };
	}
	return { kind: "unix", path: value };
}

function base85Encode(input: Buffer): string {
	let out = "";
	for (let offset = 0; offset < input.length; offset += 4) {
		const chunk = input.subarray(offset, offset + 4);
		const padded = Buffer.alloc(4);
		chunk.copy(padded);
		let value = padded.readUInt32BE(0);
		const encoded = new Array<string>(5);
		for (let i = 4; i >= 0; i--) {
			encoded[i] = PYTHON_B85_ALPHABET[value % 85]!;
			value = Math.floor(value / 85);
		}
		out += encoded.slice(0, chunk.length + 1).join("");
	}
	return out;
}

function base85Decode(input: string): Buffer {
	const out: number[] = [];
	for (let offset = 0; offset < input.length; offset += 5) {
		const chunk = input.slice(offset, offset + 5);
		let value = 0;
		for (let i = 0; i < 5; i++) {
			const char = chunk[i] ?? PYTHON_B85_ALPHABET[84]!;
			const digit = PYTHON_B85_ALPHABET.indexOf(char);
			if (digit < 0) throw new KittyRemoteControlError(`Invalid base85 character in KITTY_PUBLIC_KEY: ${char}`);
			value = value * 85 + digit;
		}
		const buf = Buffer.alloc(4);
		buf.writeUInt32BE(value >>> 0, 0);
		for (let i = 0; i < chunk.length - 1; i++) {
			out.push(buf[i]!);
		}
	}
	return Buffer.from(out);
}

export interface KittyLaunchPayload {
	args: string[];
	match?: string;
	next_to?: string;
	source_window?: string;
	window_title?: string;
	cwd?: string;
	add_to_session?: string;
	env?: string[];
	var?: string[];
	tab_title?: string;
	type?: "window" | "tab" | "os-window" | "overlay" | "overlay-main" | "background";
	keep_focus?: boolean;
	hold?: boolean;
	location?: string;
	allow_remote_control?: boolean;
	self?: boolean;
	os_window_title?: string;
	os_window_name?: string;
	os_window_class?: string;
	os_window_state?: "normal" | "fullscreen" | "maximized" | "minimized";
	wait_for_child_to_exit?: boolean;
}

export interface KittyOsWindow {
	id: number;
	is_active?: boolean;
	is_focused?: boolean;
	tabs: KittyTab[];
}

export interface KittyTab {
	id: number;
	title: string;
	is_active?: boolean;
	is_focused?: boolean;
	windows: KittyWindow[];
}

export interface KittyWindow {
	id: number;
	pid: number;
	title: string;
	cwd?: string;
	cmdline?: string[];
	columns?: number;
	lines?: number;
	foreground_processes?: Array<{ pid: number; cwd?: string; cmdline?: string[] }>;
	user_vars?: Record<string, string>;
	env?: Record<string, string>;
}
