import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { KittyRemoteControlError, parseListenOn } from "../kitty-client.js";

describe("parseListenOn", () => {
	it("parses unix sockets", () => {
		expect(parseListenOn("unix:/tmp/kitty.sock")).toEqual({ kind: "unix", path: "/tmp/kitty.sock" });
		expect(parseListenOn("/tmp/kitty.sock")).toEqual({ kind: "unix", path: "/tmp/kitty.sock" });
	});

	it("parses IPv4 and hostname tcp addresses", () => {
		expect(parseListenOn("tcp:127.0.0.1:2501")).toEqual({ kind: "tcp", host: "127.0.0.1", port: 2501 });
		expect(parseListenOn("tcp:localhost:2501")).toEqual({ kind: "tcp", host: "localhost", port: 2501 });
		expect(parseListenOn("tcp://127.0.0.1:2501")).toEqual({ kind: "tcp", host: "127.0.0.1", port: 2501 });
	});

	it("strips brackets from IPv6 hosts", () => {
		expect(parseListenOn("tcp:[::1]:12345")).toEqual({ kind: "tcp", host: "::1", port: 12345 });
		expect(parseListenOn("tcp://[::1]:12345")).toEqual({ kind: "tcp", host: "::1", port: 12345 });
		expect(parseListenOn("tcp:[2001:db8::1]:9999")).toEqual({ kind: "tcp", host: "2001:db8::1", port: 9999 });
		expect(parseListenOn("tcp://[2001:db8::1]:9999")).toEqual({ kind: "tcp", host: "2001:db8::1", port: 9999 });
	});

	it("parses tcp6 listen addresses as TCP targets", () => {
		expect(parseListenOn("tcp6:[::1]:1234")).toEqual({ kind: "tcp", host: "::1", port: 1234 });
		expect(parseListenOn("tcp6://[::1]:1234")).toEqual({ kind: "tcp", host: "::1", port: 1234 });
		expect(parseListenOn("tcp6:[2001:db8::1]:9999")).toEqual({ kind: "tcp", host: "2001:db8::1", port: 9999 });
		expect(parseListenOn("tcp6://[2001:db8::1]:9999")).toEqual({ kind: "tcp", host: "2001:db8::1", port: 9999 });
		// Must not fall through to unix path treatment
		expect(parseListenOn("tcp6:[::1]:1234")).not.toEqual({ kind: "unix", path: "tcp6:[::1]:1234" });
	});

	it("rejects invalid ports and malformed IPv6 forms", () => {
		expect(() => parseListenOn("tcp:[::1]")).toThrow(KittyRemoteControlError);
		expect(() => parseListenOn("tcp6:[::1]")).toThrow(KittyRemoteControlError);
		expect(() => parseListenOn("tcp:127.0.0.1:notaport")).toThrow(KittyRemoteControlError);
		expect(() => parseListenOn("tcp://127.0.0.1")).toThrow(KittyRemoteControlError);
		expect(() => parseListenOn("tcp6://[::1]")).toThrow(KittyRemoteControlError);
	});

	it("rejects ports above 65535", () => {
		// Non-URL forms: parseTcpPort enforces the upper bound.
		expect(() => parseListenOn("tcp:127.0.0.1:65536")).toThrow(KittyRemoteControlError);
		expect(() => parseListenOn("tcp:[::1]:70000")).toThrow(KittyRemoteControlError);
		expect(() => parseListenOn("tcp6:[::1]:65536")).toThrow(KittyRemoteControlError);
		// URL forms are pre-rejected by URL parsing before parseTcpPort runs; still throws.
		expect(() => parseListenOn("tcp://127.0.0.1:99999")).toThrow();
		// Boundary: 65535 is still valid
		expect(parseListenOn("tcp:127.0.0.1:65535")).toEqual({ kind: "tcp", host: "127.0.0.1", port: 65535 });
	});
});

describe("KittyClient response handling", () => {
	it("wraps malformed ls payload JSON in KittyRemoteControlError", async () => {
		const { KittyClient } = await import("../kitty-client.js");
		const client = new KittyClient();
		const response = { ok: true, data: "{not-json" };
		(client as any).command = async () => response;

		await expect(client.ls()).rejects.toMatchObject({
			name: "KittyRemoteControlError",
			response,
		});
	});

	it("resolves as soon as a complete DCS response is received", async () => {
		const { KittyClient } = await import("../kitty-client.js");
		const client = new KittyClient({ kitty: { responseTimeoutMs: 5000 } } as any);
		const rawResponse = '\x1bP@kitty-cmd{"ok":true}\x1b\\';
		class FakeSocket extends EventEmitter {
			destroy = vi.fn();
			end = vi.fn(() => {
				queueMicrotask(() => this.emit("data", Buffer.from(rawResponse)));
			});
		}
		const socket = new FakeSocket();
		(client as any).openSocket = async () => socket;

		await expect((client as any).sendAndReceive(Buffer.from("request"))).resolves.toBe(rawResponse);
		expect(socket.destroy).toHaveBeenCalledTimes(1);
	});

	it("getText throws when kitty returns non-string data so the snapshot baseline is not corrupted", async () => {
		const { KittyClient } = await import("../kitty-client.js");
		const client = new KittyClient({ kitty: { responseTimeoutMs: 5000 } } as any);
		(client as any).command = async () => ({ ok: true, data: null });
		await expect(client.getText(1)).rejects.toBeInstanceOf(KittyRemoteControlError);
	});
});

describe("KittyClient.sendText bracketed paste chunking", () => {
	const DCS_PREFIX = "\x1bP@kitty-cmd";
	const DCS_SUFFIX = "\x1b\\";

	const createClient = async () => {
		const { KittyClient } = await import("../kitty-client.js");
		return new KittyClient({
			kitty: { listenOn: "unix:/tmp/pi-interactive-kitty-test.sock", responseTimeoutMs: 5000 },
		} as any);
	};

	/** Capture framed no-response batches and decode each DCS JSON command. */
	const captureSendText = async (client: any, data: Buffer | string, options?: { bracketedPaste?: "disable" | "auto" | "enable" }) => {
		const batches: Buffer[][] = [];
		client.sendNoResponseBatch = async (payloads: Buffer[]) => {
			batches.push(payloads.map((p) => Buffer.from(p)));
		};
		await client.sendText(1, data, options);
		expect(batches.length).toBe(1);
		const frames = batches[0]!;
		const commands = frames.map((frame) => {
			const raw = frame.toString("utf8");
			expect(raw.startsWith(DCS_PREFIX)).toBe(true);
			expect(raw.endsWith(DCS_SUFFIX)).toBe(true);
			return JSON.parse(raw.slice(DCS_PREFIX.length, -DCS_SUFFIX.length));
		});
		const chunks = commands.map((cmd) => {
			expect(cmd.cmd).toBe("send-text");
			expect(cmd.no_response).toBe(true);
			const dataField: string = cmd.payload.data;
			expect(dataField.startsWith("base64:")).toBe(true);
			return Buffer.from(dataField.slice("base64:".length), "base64");
		});
		return { commands, chunks, wire: Buffer.concat(chunks), frames, batches };
	};

	it("wraps a single-chunk paste with a single enable directive", async () => {
		const client = await createClient();
		const { commands, wire } = await captureSendText(client, "short paste", { bracketedPaste: "enable" });
		expect(commands.length).toBe(1);
		// Single chunk: use kitty's supported enable so it wraps + sanitizes.
		expect(commands[0].payload.bracketed_paste).toBe("enable");
		expect(wire.toString("utf8")).toBe("short paste");
	});

	it("keeps exactly 1024 bytes as one native enable command", async () => {
		const client = await createClient();
		const payload = "x".repeat(1024);
		const { commands, wire } = await captureSendText(client, payload, { bracketedPaste: "enable" });
		expect(commands.length).toBe(1);
		expect(commands[0].payload.bracketed_paste).toBe("enable");
		expect(wire.toString("utf8")).toBe(payload);
	});

	it("self-wraps multi-chunk enable pastes with supported disable values only", async () => {
		const client = await createClient();
		// >1024 bytes forces multi-chunk; kitty has no start/end bracketed_paste values.
		const big = "x".repeat(2148);
		const { commands, wire, batches } = await captureSendText(client, big, { bracketedPaste: "enable" });
		expect(commands.length).toBeGreaterThan(1);
		// One batch = one socket; only protocol-legal values; multi-chunk enable injects ESC markers itself.
		expect(batches.length).toBe(1);
		expect(commands.map((c) => c.payload.bracketed_paste)).toEqual(Array(commands.length).fill("disable"));
		expect(wire.subarray(0, 6).toString("utf8")).toBe("\x1b[200~");
		expect(wire.subarray(-6).toString("utf8")).toBe("\x1b[201~");
		expect(wire.subarray(6, -6).toString("utf8")).toBe(big);
	});

	it("self-wraps when raw length exceeds 1024 even if sanitize shrinks below the limit", async () => {
		const client = await createClient();
		// 1019 + 6 terminator = 1025 raw bytes; after sanitize body is 1019 (<=1024) but must still self-wrap.
		const payload = Buffer.concat([Buffer.from("a".repeat(1019)), Buffer.from("\x1b[201~")]);
		const { commands, wire } = await captureSendText(client, payload, { bracketedPaste: "enable" });
		expect(commands.length).toBeGreaterThan(1);
		expect(commands.every((c) => c.payload.bracketed_paste === "disable")).toBe(true);
		expect(wire.subarray(0, 6).toString("utf8")).toBe("\x1b[200~");
		expect(wire.subarray(-6).toString("utf8")).toBe("\x1b[201~");
		expect(wire.subarray(6, -6).toString("utf8")).toBe("a".repeat(1019));
	});

	it("strips embedded paste-end sequences before multi-chunk self-wrap", async () => {
		const client = await createClient();
		// Force multi-chunk and embed a terminator that must not close the paste early.
		const payload = Buffer.concat([Buffer.from("a".repeat(1020)), Buffer.from("\x1b[201~"), Buffer.from("b".repeat(20))]);
		const { commands, wire } = await captureSendText(client, payload, { bracketedPaste: "enable" });
		expect(commands.every((c) => c.payload.bracketed_paste === "disable")).toBe(true);
		expect(wire.subarray(0, 6).toString("utf8")).toBe("\x1b[200~");
		expect(wire.subarray(-6).toString("utf8")).toBe("\x1b[201~");
		const body = wire.subarray(6, -6);
		expect(body.includes(Buffer.from("\x1b[201~"))).toBe(false);
		expect(body.toString("utf8")).toBe("a".repeat(1020) + "b".repeat(20));
	});

	it("reconstructs multi-byte UTF-8 that straddles a chunk boundary", async () => {
		const client = await createClient();
		// U+1F600 is 4 UTF-8 bytes; place it across the 1024-byte boundary.
		const emoji = Buffer.from("😀", "utf8");
		expect(emoji.length).toBe(4);
		const payload = Buffer.concat([Buffer.from("x".repeat(1022)), emoji, Buffer.from("y".repeat(10))]);
		const { wire, commands } = await captureSendText(client, payload, { bracketedPaste: "enable" });
		expect(commands.length).toBeGreaterThan(1);
		expect(wire.subarray(6, -6).equals(payload)).toBe(true);
		expect(wire.subarray(6, -6).toString("utf8")).toBe("x".repeat(1022) + "😀" + "y".repeat(10));
	});

	it("propagates the requested bracketed_paste value unchanged when not enable", async () => {
		const client = await createClient();
		const { commands, wire } = await captureSendText(client, "x".repeat(1500), { bracketedPaste: "disable" });
		expect(commands.length).toBe(2);
		expect(commands.map((c) => c.payload.bracketed_paste)).toEqual(["disable", "disable"]);
		expect(wire.toString("utf8")).toBe("x".repeat(1500));
	});

	it("sends multi-chunk frames on one socket in order", async () => {
		const client = await createClient();
		const written: Buffer[] = [];
		class FakeSocket extends EventEmitter {
			write = vi.fn((chunk: Buffer) => {
				written.push(Buffer.from(chunk));
				return true;
			});
			end = vi.fn((cb?: () => void) => {
				queueMicrotask(() => cb?.());
				return this;
			});
			destroy = vi.fn();
		}
		const socket = new FakeSocket();
		(client as any).openSocket = async () => socket;

		await client.sendText(1, "z".repeat(1500), { bracketedPaste: "disable" });
		expect(socket.write).toHaveBeenCalledTimes(2);
		expect(socket.end).toHaveBeenCalledTimes(1);
		expect(socket.destroy).toHaveBeenCalledTimes(1);
		// Frames arrived in order on the same socket.
		const frames = written;
		expect(frames.length).toBe(2);
		const chunks = frames.map((frame) => {
			const raw = frame.toString("utf8");
			const cmd = JSON.parse(raw.slice(DCS_PREFIX.length, -DCS_SUFFIX.length));
			return Buffer.from(cmd.payload.data.slice("base64:".length), "base64");
		});
		expect(Buffer.concat(chunks).toString("utf8")).toBe("z".repeat(1500));
	});

	it("sanitizeForBracketedPaste removes CSI and 8-bit paste-end sequences", async () => {
		const { sanitizeForBracketedPaste } = await import("../kitty-client.js");
		// latin1 so 0x9b stays a single C1 byte (UTF-8 would expand U+009B to C2 9B).
		const input = Buffer.from("hello\x1b[201~world\x9b201~!", "latin1");
		expect(sanitizeForBracketedPaste(input).toString("latin1")).toBe("helloworld!");
	});

	it("sanitizeForBracketedPaste loops until nested paste-end sequences are gone", async () => {
		const { sanitizeForBracketedPaste } = await import("../kitty-client.js");
		// Nested/overlapping form that needs a second replacement pass (kitty fixed-point).
		const input = Buffer.from("\x1b[201\x1b[201~~", "latin1");
		expect(sanitizeForBracketedPaste(input).toString("latin1")).toBe("");
	});
});

describe("KittyClient.openSocket connect timeout", () => {
	it("rejects with a timeout error when the connect never completes", async () => {
		const { KittyClient } = await import("../kitty-client.js");
		// 192.0.2.0/24 is TEST-NET-1 (RFC 5737): reserved for documentation, no host will respond.
		// A short connectTimeoutMs proves the timer fires even when the OS never returns.
		const client = new KittyClient({
			kitty: { listenOn: "tcp:192.0.2.1:1", connectTimeoutMs: 200 },
		} as any);
		await expect((client as any).openSocket()).rejects.toMatchObject({
			name: "KittyRemoteControlError",
			message: expect.stringMatching(/Timed out connecting/),
		});
	}, 5000);
});
