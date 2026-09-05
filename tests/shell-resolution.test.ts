import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempRoots: string[] = [];

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
	vi.doUnmock("@earendil-works/pi-coding-agent");
});

describe("trusted Pi shell resolution", () => {
	it("uses project shellPath only when the Pi context trusts the project", async () => {
		if (process.platform === "win32") return;

		const root = mkdtempSync(join(tmpdir(), "interactive-shell-resolution-"));
		tempRoots.push(root);
		const agentDir = join(root, "agent");
		const project = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(project, ".pi"), { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ shellPath: "/bin/sh" }));
		writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({ shellPath: "/bin/bash" }));

		vi.resetModules();
		vi.doMock("@earendil-works/pi-coding-agent", async () => ({
			...(await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>("@earendil-works/pi-coding-agent")),
			getAgentDir: () => agentDir,
		}));
		const { resolvePiShell } = await import("../shell-resolution.ts");

		const trusted = resolvePiShell(project, true);
		const untrusted = resolvePiShell(project, false);

		expect(trusted).toMatchObject({ shell: "/bin/bash", args: ["-c"], commandTransport: "argv" });
		expect(untrusted).toMatchObject({ shell: "/bin/sh", args: ["-c"], commandTransport: "argv" });
		expect(Object.isFrozen(trusted)).toBe(true);
		expect(Object.isFrozen(trusted.args)).toBe(true);
	});

	it("rejects Pi shell configurations that require stdin command transport", async () => {
		vi.resetModules();
		vi.doMock("@earendil-works/pi-coding-agent", () => ({
			getAgentDir: () => "/tmp/pi-agent",
			SettingsManager: { create: () => ({ getShellPath: () => "legacy-wsl-bash" }) },
			getShellConfig: () => ({ shell: "legacy-wsl-bash", args: ["-s"], commandTransport: "stdin" }),
		}));
		const { resolvePiShell } = await import("../shell-resolution.ts");

		expect(() => resolvePiShell("/tmp/project", true)).toThrow(
			/which requires stdin command transport.*configure shellPath to a Git Bash executable/,
		);
	});
});
