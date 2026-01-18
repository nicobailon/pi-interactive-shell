#!/usr/bin/env node

import { existsSync, mkdirSync, cpSync, symlinkSync, unlinkSync, readFileSync } from "node:fs";
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

	// Files to copy
	const files = [
		"package.json",
		"index.ts",
		"config.ts",
		"overlay-component.ts",
		"pty-session.ts",
		"session-manager.ts",
		"README.md",
		"SKILL.md",
		"CHANGELOG.md",
	];

	// Copy files
	for (const file of files) {
		const src = join(packageRoot, file);
		const dest = join(EXTENSION_DIR, file);
		if (existsSync(src)) {
			cpSync(src, dest);
			log(`Copied ${file}`);
		}
	}

	// Copy scripts directory
	const scriptsDir = join(packageRoot, "scripts");
	const destScriptsDir = join(EXTENSION_DIR, "scripts");
	if (existsSync(scriptsDir)) {
		mkdirSync(destScriptsDir, { recursive: true });
		cpSync(scriptsDir, destScriptsDir, { recursive: true });
		log("Copied scripts/");
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
		if (existsSync(skillLink)) {
			unlinkSync(skillLink);
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
