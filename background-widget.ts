import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { formatDuration } from "./types.js";
import type { ShellSessionManager } from "./session-manager.js";

export function setupBackgroundWidget(
	ctx: { ui: { setWidget: Function }; hasUI?: boolean },
	sessionManager: ShellSessionManager,
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
						const exited = s.session.exited;
						const dot = exited ? theme.fg("dim", "○") : theme.fg("accent", "●");
						const id = theme.fg("dim", s.id);
						const cmd = s.command.replace(/\s+/g, " ").trim();
						const truncCmd = cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd;
						const reason = s.reason ? theme.fg("dim", ` · ${s.reason}`) : "";
						const status = exited ? theme.fg("dim", "exited") : theme.fg("success", "running");
						const duration = theme.fg("dim", formatDuration(Date.now() - s.startedAt.getTime()));
						const oneLine = ` ${dot} ${id}  ${truncCmd}${reason}  ${status} ${duration}`;
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
		ctx.ui.setWidget("bg-sessions", undefined);
	};
}
