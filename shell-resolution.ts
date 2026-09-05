import {
	getAgentDir,
	getShellConfig,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

/**
 * Shell configuration resolved once at a new-session launch boundary.
 *
 * Interactive PTYs append their command as an argv argument, so stdin-only
 * shell transports are intentionally rejected by resolvePiShell().
 */
export interface ResolvedShellConfig {
	readonly shell: string;
	readonly args: readonly string[];
}

/**
 * Resolve the same trusted Bash selection Pi uses for its shell tool.
 *
 * `projectCwd` must be Pi's trusted context project, not an arbitrary command
 * cwd supplied by the caller. The settings manager reads settings once here;
 * callers should pass the returned immutable config through the launch path.
 */
export function resolvePiShell(projectCwd: string, projectTrusted: boolean): ResolvedShellConfig {
	const settingsManager = SettingsManager.create(projectCwd, getAgentDir(), { projectTrusted });
	const shellConfig = getShellConfig(settingsManager.getShellPath());

	if (shellConfig.commandTransport !== undefined && shellConfig.commandTransport !== "argv") {
		throw new Error(
			`Pi selected "${shellConfig.shell}", which requires stdin command transport. `
			+ "interactive_shell PTYs require argv command transport; configure shellPath to a Git Bash executable instead.",
		);
	}
	if (!shellConfig.shell || shellConfig.args.length === 0) {
		throw new Error("Pi returned an invalid shell configuration: a shell executable and argv are required.");
	}

	return Object.freeze({
		shell: shellConfig.shell,
		args: Object.freeze([...shellConfig.args]),
	});
}
