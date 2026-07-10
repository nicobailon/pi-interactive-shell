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
	it("wraps a single-chunk paste with a single enable directive", async () => {
		const { KittyClient } = await import("../kitty-client.js");
		const client = new KittyClient({ kitty: { responseTimeoutMs: 5000 } } as any);
		const commands: any[] = [];
		(client as any).command = async (cmd: any) => {
			commands.push(cmd);
			return { ok: true };
		};
		await client.sendText(1, "short paste", { bracketedPaste: "enable" });
		expect(commands.length).toBe(1);
		expect(commands[0].payload.bracketed_paste).toBe("enable");
	});

	it("emits start/disable*/end so a multi-chunk paste is one bracketed-paste event", async () => {
		const { KittyClient } = await import("../kitty-client.js");
		const client = new KittyClient({ kitty: { responseTimeoutMs: 5000 } } as any);
		const commands: any[] = [];
		(client as any).command = async (cmd: any) => {
			commands.push(cmd);
			return { ok: true };
		};
		// 3 chunks: 1024 + 1024 + 100 bytes
		const big = "x".repeat(2148);
		await client.sendText(1, big, { bracketedPaste: "enable" });
		expect(commands.length).toBe(3);
		expect(commands[0].payload.bracketed_paste).toBe("start");
		expect(commands[1].payload.bracketed_paste).toBe("disable");
		expect(commands[2].payload.bracketed_paste).toBe("end");
	});

	it("propagates the requested bracketed_paste value unchanged when not enable", async () => {
		const { KittyClient } = await import("../kitty-client.js");
		const client = new KittyClient({ kitty: { responseTimeoutMs: 5000 } } as any);
		const commands: any[] = [];
		(client as any).command = async (cmd: any) => {
			commands.push(cmd);
			return { ok: true };
		};
		await client.sendText(1, "x".repeat(1500), { bracketedPaste: "disable" });
		expect(commands.length).toBe(2);
		expect(commands.map((c) => c.payload.bracketed_paste)).toEqual(["disable", "disable"]);
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
