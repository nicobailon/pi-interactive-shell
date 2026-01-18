#!/usr/bin/env node

import { existsSync, mkdirSync, cpSync, symlinkSync, unlinkSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, "..");

const EXTENSION_DIR = join(homedir(), ".pi", "agent", "extensions", "interactive-shell");
const SKILLS_BASE_DIR = join(homedir(), ".pi", "agent", "skills");

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

	// Copy skills directory (contains foreground-chains skill)
	const skillsDir = join(packageRoot, "skills");
	const destSkillsDir = join(EXTENSION_DIR, "skills");
	if (existsSync(skillsDir)) {
		mkdirSync(destSkillsDir, { recursive: true });
		cpSync(skillsDir, destSkillsDir, { recursive: true });
		log("Copied skills/");
	}

	// Run npm install in extension directory
	log("Running npm install...");
	try {
		execSync("npm install", { cwd: EXTENSION_DIR, stdio: "inherit" });
	} catch (error) {
		log(`Warning: npm install failed: ${error.message}`);
		log("You may need to run 'npm install' manually in the extension directory.");
	}

	// Create skill symlinks
	const skills = [
		{ name: "interactive-shell", target: join(EXTENSION_DIR, "SKILL.md") },
		{ name: "foreground-chains", target: join(EXTENSION_DIR, "skills", "foreground-chains", "SKILL.md") },
	];

	for (const skill of skills) {
		const skillDir = join(SKILLS_BASE_DIR, skill.name);
		const skillLink = join(skillDir, "SKILL.md");

		log(`Creating skill symlink: ${skill.name}`);
		mkdirSync(skillDir, { recursive: true });

		try {
			if (existsSync(skillLink)) {
				unlinkSync(skillLink);
			}
			symlinkSync(skill.target, skillLink);
			log(`  -> ${skillLink}`);
		} catch (error) {
			log(`  Warning: Could not create symlink: ${error.message}`);
			log(`  You can create it manually: ln -sf ${skill.target} ${skillLink}`);
		}
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
