import { describe, expect, it, vi } from "vitest";

describe("module smoke loads", () => {
	it("loads the extension and overlay modules", async () => {
		vi.resetModules();
		vi.doMock("@mariozechner/pi-coding-agent", () => ({
			getAgentDir: () => "/tmp/pi-agent",
		}));
		vi.doMock("@mariozechner/pi-tui", () => ({
			matchesKey: () => false,
			truncateToWidth: (value: string) => value,
			visibleWidth: (value: string) => value.length,
		}));

		const extension = await import("../index.js");
		const overlay = await import("../overlay-component.js");
		const reattach = await import("../reattach-overlay.js");
		expect(typeof extension.default).toBe("function");
		expect(typeof overlay.InteractiveShellOverlay).toBe("function");
		expect(typeof reattach.ReattachOverlay).toBe("function");
	});
});
