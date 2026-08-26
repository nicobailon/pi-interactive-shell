import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatDuration } from "./types.ts";
import type { ShellSessionManager } from "./session-manager.ts";
import type { InteractiveShellCoordinator } from "./runtime-coordinator.ts";

export function setupBackgroundWidget(
	ctx: { ui: { setWidget: Function }; hasUI?: boolean },
	sessionManager: ShellSessionManager,
	coordinator?: InteractiveShellCoordinator,
): (() => void) | null {
	if (!ctx.hasUI) return null;

	let durationTimer: ReturnType<typeof setInterval> | null = null;
	let tuiRef: { requestRender: () => void } | null = null;

	const requestRender = () => tuiRef?.requestRender();
	const unsubscribe = sessionManager.onChange(() => {
		manageDurationTimer();
		requestRender();
	});

	function manageDurationTimer() {
		const sessions = sessionManager.list();
		const hasRunning = sessions.some((s) => !s.session.exited);
		if (hasRunning && !durationTimer) {
			durationTimer = setInterval(requestRender, 10_000);
		} else if (!hasRunning && durationTimer) {
			clearInterval(durationTimer);
			durationTimer = null;
		}
	}

	ctx.ui.setWidget(
		"bg-sessions",
		(tui: any, theme: any) => {
			tuiRef = tui;
			return {
				render: (width: number) => {
					const sessions = sessionManager.list();
					if (sessions.length === 0) return [];
					const cols = width || tui.terminal?.columns || 120;
					const lines: string[] = [];
					for (const s of sessions) {
						const monitorState = coordinator?.getMonitorSessionState(s.id);
						const exited = s.session.exited;
						const dot = exited
							? theme.fg("dim", "○")
							: monitorState
								? theme.fg("accent", "◆")
								: theme.fg("accent", "●");
						const id = theme.fg("dim", s.id);
						const cmd = s.command.replace(/\s+/g, " ").trim();
						const truncCmd = cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd;
						const reason = s.reason ? theme.fg("dim", ` · ${s.reason}`) : "";
						const statusText = monitorState
							? `${monitorState.status === "running" ? "monitoring" : "monitor-stopped"}${monitorState.eventCount > 0 ? ` e:${monitorState.eventCount}` : ""}`
							: exited
								? "exited"
								: "running";
						const status = exited ? theme.fg("dim", statusText) : monitorState ? theme.fg("accent", statusText) : theme.fg("success", statusText);
						const duration = theme.fg("dim", formatDuration(Date.now() - s.startedAt.getTime()));
						const strategy = monitorState ? theme.fg("dim", ` · ${monitorState.strategy}`) : "";
						const oneLine = ` ${dot} ${id}  ${truncCmd}${reason}${strategy}  ${status} ${duration}`;
						if (visibleWidth(oneLine) <= cols) {
							lines.push(oneLine);
						} else {
							lines.push(truncateToWidth(` ${dot} ${id}  ${cmd}`, cols, "…"));
							lines.push(truncateToWidth(`   ${status} ${duration}${reason}`, cols, "…"));
						}
					}
					return lines;
				},
				invalidate: () => {},
			};
		},
		{ placement: "belowEditor" },
	);

	manageDurationTimer();

	return () => {
		unsubscribe();
		if (durationTimer) {
			clearInterval(durationTimer);
			durationTimer = null;
		}
		try {
			ctx.ui.setWidget("bg-sessions", undefined);
		} catch {
			// The session ctx can be stale during replacement. Local cleanup is already done.
		}
	};
}
