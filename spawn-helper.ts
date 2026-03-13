import { chmodSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
let spawnHelperChecked = false;

export function ensureSpawnHelperExec(): void {
	if (spawnHelperChecked) return;
	spawnHelperChecked = true;
	if (process.platform !== "darwin") return;

	let pkgPath: string;
	try {
		pkgPath = require.resolve("node-pty/package.json");
	} catch {
		return;
	}

	const base = dirname(pkgPath);
	const targets = [
		join(base, "prebuilds", "darwin-arm64", "spawn-helper"),
		join(base, "prebuilds", "darwin-x64", "spawn-helper"),
	];

	for (const target of targets) {
		try {
			const stats = statSync(target);
			const mode = stats.mode | 0o111;
			if ((stats.mode & 0o111) !== 0o111) {
				chmodSync(target, mode);
			}
		} catch {
			continue;
		}
	}
}
