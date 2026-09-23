import { truncateToWidth } from "@earendil-works/pi-tui";
import { formatDuration } from "./types.ts";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { InteractiveShellCoordinator } from "./runtime-coordinator.ts";

type BackgroundWidgetContext = Pick<ExtensionContext, "hasUI"> & {
	ui: Pick<ExtensionContext["ui"], "setWidget">;
};
type BackgroundWidgetSession = {
	id: string;
	name?: string;
	explicitName?: boolean;
	command: string;
	reason?: string;
	startedAt: Date;
	session: { exited: boolean };
};
type BackgroundWidgetSessionManager = {
	onChange: (listener: () => void) => () => void;
	list: () => BackgroundWidgetSession[];
};
type BackgroundWidgetCoordinator = Pick<InteractiveShellCoordinator, "getMonitorSessionState">;

export function setupBackgroundWidget(
	ctx: BackgroundWidgetContext,
	sessionManager: BackgroundWidgetSessionManager,
	coordinator?: BackgroundWidgetCoordinator,
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
		(tui: TUI, theme: Theme) => {
			tuiRef = tui;
			return {
				render: (width: number) => {
					const sessions = sessionManager.list().filter((session) => !session.session.exited);
					if (sessions.length === 0) return [];
					const cols = width || tui.terminal?.columns || 120;
					const terminalRows = tui.terminal?.rows || 24;
					const maxRows = Math.max(2, Math.min(6, Math.floor(terminalRows * 0.2)));
					const visibleCount = sessions.length > maxRows ? maxRows - 1 : maxRows;
					const visibleSessions = sessions.slice(0, visibleCount);
					const lines: string[] = [];
					for (const s of visibleSessions) {
						const monitorState = coordinator?.getMonitorSessionState(s.id);
						const dot = monitorState ? theme.fg("accent", "◆") : theme.fg("accent", "●");
						const id = theme.fg("dim", s.id);
						const hasExplicitName = s.explicitName ?? s.name === s.id;
						const commandText = hasExplicitName ? "" : `  ${s.command.replace(/\s+/g, " ").trim()}`;
						const reasonText = s.reason?.replace(/\s+/g, " ").trim();
						const reason = reasonText ? theme.fg("dim", ` · ${reasonText}`) : "";
						const statusText = monitorState
							? `${monitorState.status === "running" ? "monitoring" : "monitor-stopped"}${monitorState.eventCount > 0 ? ` e:${monitorState.eventCount}` : ""}`
							: "running";
						const status = monitorState ? theme.fg("accent", statusText) : theme.fg("success", statusText);
						const duration = theme.fg("dim", formatDuration(Date.now() - s.startedAt.getTime()));
						const strategy = monitorState ? theme.fg("dim", ` · ${monitorState.strategy}`) : "";
						const oneLine = ` ${dot} ${id}  ${status} ${duration}${strategy}${commandText}${reason}`;
						lines.push(truncateToWidth(oneLine, cols, "…"));
					}
					if (sessions.length > visibleSessions.length) {
						const hiddenCount = sessions.length - visibleSessions.length;
						lines.push(truncateToWidth(theme.fg("dim", ` … +${hiddenCount} more running · /attach to view all`), cols, "…"));
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
