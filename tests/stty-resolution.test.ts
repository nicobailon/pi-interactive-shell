import { describe, expect, it } from "vitest";
import { resolveSttyPath } from "../pty-process.ts";

describe("stty used for PTY resize", () => {
	it("prefers the first stty on PATH", () => {
		const present = new Set(["/run/current-system/sw/bin/stty", "/usr/bin/stty"]);
		expect(
			resolveSttyPath({ PATH: "/home/u/bin:/run/current-system/sw/bin:/usr/bin" }, (path) => present.has(path)),
		).toBe("/run/current-system/sw/bin/stty");
	});

	it("finds stty when /usr/bin has none, as on NixOS", () => {
		const present = new Set(["/run/current-system/sw/bin/stty"]);
		expect(resolveSttyPath({ PATH: "/run/current-system/sw/bin" }, (path) => present.has(path))).toBe(
			"/run/current-system/sw/bin/stty",
		);
	});

	it("falls back to the usual locations without a usable PATH", () => {
		expect(resolveSttyPath({ PATH: "relative/bin:" }, (path) => path === "/bin/stty")).toBe("/bin/stty");
		expect(resolveSttyPath({}, () => false)).toBe("/usr/bin/stty");
	});
});
