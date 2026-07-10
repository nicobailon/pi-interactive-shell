import { describe, expect, it, vi } from "vitest";

describe("module smoke loads", () => {
	it("loads the extension and kitty backend modules", async () => {
		vi.resetModules();
		vi.doMock("@mariozechner/pi-coding-agent", () => ({
			getAgentDir: () => "/tmp/pi-agent",
		}));
		vi.doMock("@mariozechner/pi-tui", () => ({
			truncateToWidth: (value: string) => value,
			visibleWidth: (value: string) => value.length,
		}));

		const extension = await import("../index.js");
		const client = await import("../kitty-client.js");
		const session = await import("../kitty-session.js");
		expect(typeof extension.default).toBe("function");
		expect(typeof client.KittyClient).toBe("function");
		expect(typeof session.KittyTerminalSession).toBe("function");
	});
});
