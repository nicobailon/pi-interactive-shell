#!/usr/bin/env node

import { existsSync, mkdirSync, cpSync, symlinkSync, unlinkSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, "..");

const EXTENSION_DIR = join(homedir(), ".pi", "agent", "extensions", "interactive-shell");
const SKILL_DIR = join(homedir(), ".pi", "agent", "skills", "interactive-shell");

function log(msg) {
	console.log(`[pi-interactive-shell] ${msg}`);
}

function main() {
	const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf-8"));
	log(`Installing version ${pkg.version}...`);

	// Create extension directory
	log(`Creating ${EXTENSION_DIR}`);
	mkdirSync(EXTENSION_DIR, { recursive: true });

	// Read files list from package.json (single source of truth)
	// Include package.json itself (npm auto-includes it but it's not in the files array)
	const files = ["package.json", ...(pkg.files || [])];

	// Copy files and directories
	for (const rawEntry of files) {
		// Normalize: remove trailing slashes for consistent handling
		const entry = rawEntry.replace(/\/+$/, "");
		const src = join(packageRoot, entry);
		const dest = join(EXTENSION_DIR, entry);

		if (!existsSync(src)) {
			continue;
		}

		try {
			const stat = statSync(src);
			if (stat.isDirectory()) {
				mkdirSync(dest, { recursive: true });
				cpSync(src, dest, { recursive: true });
				log(`Copied ${entry}/`);
			} else {
				cpSync(src, dest);
				log(`Copied ${entry}`);
			}
		} catch (error) {
			log(`Warning: Could not copy ${entry}: ${error.message}`);
		}
	}

	// Run npm install in extension directory
	log("Running npm install...");
	try {
		execSync("npm install", { cwd: EXTENSION_DIR, stdio: "inherit" });
	} catch (error) {
		log(`Warning: npm install failed: ${error.message}`);
		log("You may need to run 'npm install' manually in the extension directory.");
	}

	// Create skill symlink
	log(`Creating skill symlink at ${SKILL_DIR}`);
	mkdirSync(SKILL_DIR, { recursive: true });
	const skillLink = join(SKILL_DIR, "SKILL.md");
	const skillTarget = join(EXTENSION_DIR, "SKILL.md");

	try {
		// Remove existing entry if present (handles regular files, symlinks, and broken symlinks)
		// Note: existsSync returns false for broken symlinks, so we unconditionally try unlink
		try {
			unlinkSync(skillLink);
		} catch (e) {
			if (e.code !== "ENOENT") throw e;
		}
		symlinkSync(skillTarget, skillLink);
		log("Skill symlink created");
	} catch (error) {
		log(`Warning: Could not create skill symlink: ${error.message}`);
		log(`You can create it manually: ln -sf ${skillTarget} ${skillLink}`);
	}

	log("");
	log("Installation complete!");
	log("");
	log("Restart pi to load the extension.");
	log("");
	log("Usage:");
	log('  interactive_shell({ command: \'pi "Fix all bugs"\', mode: "hands-free" })');
	log("");
}

main();
