import { describe, expect, it, vi } from "vitest";

describe("module smoke loads", () => {
	it("loads the extension and overlay modules", async () => {
		vi.resetModules();
		vi.doMock("@earendil-works/pi-coding-agent", () => ({
			getAgentDir: () => "/tmp/pi-agent",
		}));
		vi.doMock("@earendil-works/pi-tui", () => ({
			matchesKey: () => false,
			truncateToWidth: (value: string) => value,
			visibleWidth: (value: string) => value.length,
		}));

		const extension = await import("../index.ts");
		const overlay = await import("../overlay-component.ts");
		const reattach = await import("../reattach-overlay.ts");
		expect(typeof extension.default).toBe("function");
		expect(typeof overlay.InteractiveShellOverlay).toBe("function");
		expect(typeof reattach.ReattachOverlay).toBe("function");
	});
});
