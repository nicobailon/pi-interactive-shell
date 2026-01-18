const fs = require("node:fs");
const path = require("node:path");

function ensureExecutable(filePath) {
	try {
		const stats = fs.statSync(filePath);
		const mode = stats.mode | 0o111;
		if ((stats.mode & 0o111) !== 0o111) {
			fs.chmodSync(filePath, mode);
			process.stdout.write(`chmod +x ${filePath}\n`);
		}
	} catch (error) {
		process.stdout.write(`skip ${filePath}: ${String(error)}\n`);
	}
}

function main() {
	let pkgPath;
	try {
		pkgPath = require.resolve("node-pty/package.json", { paths: [process.cwd()] });
	} catch (error) {
		process.stdout.write(`node-pty not found: ${String(error)}\n`);
		return;
	}

	const base = path.dirname(pkgPath);
	const targets = [
		path.join(base, "prebuilds", "darwin-arm64", "spawn-helper"),
		path.join(base, "prebuilds", "darwin-x64", "spawn-helper"),
	];

	for (const target of targets) {
		ensureExecutable(target);
	}
}

main();
