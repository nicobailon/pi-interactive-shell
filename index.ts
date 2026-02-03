import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { InteractiveShellOverlay } from "./overlay-component.js";
import { ReattachOverlay } from "./reattach-overlay.js";
import { PtyTerminalSession } from "./pty-session.js";
import type { InteractiveShellResult } from "./types.js";
import { sessionManager, generateSessionId, releaseSessionId } from "./session-manager.js";
import type { OutputOptions, OutputResult } from "./session-manager.js";
import { loadConfig } from "./config.js";
import type { InteractiveShellConfig } from "./config.js";
import { translateInput } from "./key-encoding.js";
import { TOOL_NAME, TOOL_LABEL, TOOL_DESCRIPTION, toolParameters, type ToolParams } from "./tool-schema.js";
import { formatDuration, formatDurationMs } from "./types.js";
import { HeadlessDispatchMonitor } from "./headless-monitor.js";
import type { HeadlessCompletionInfo } from "./headless-monitor.js";

let overlayOpen = false;
let agentHandledCompletion = false;
const headlessMonitors = new Map<string, HeadlessDispatchMonitor>();

function getHeadlessOutput(session: PtyTerminalSession, opts?: OutputOptions | boolean): OutputResult {
	const options = typeof opts === "boolean" ? {} : (opts ?? {});
	const lines = options.lines ?? 20;
	const maxChars = options.maxChars ?? 5 * 1024;
	try {
		const result = session.getTailLines({ lines, ansi: false, maxChars });
		const output = result.lines.join("\n");
		return {
			output,
			truncated: result.lines.length < result.totalLinesInBuffer || result.truncatedByChars,
			totalBytes: output.length,
			totalLines: result.totalLinesInBuffer,
		};
	} catch {
		return { output: "", truncated: false, totalBytes: 0 };
	}
}

const BRIEF_TAIL_LINES = 5;

function buildDispatchNotification(sessionId: string, info: HeadlessCompletionInfo, duration: string): string {
	const parts: string[] = [];
	if (info.timedOut) {
		parts.push(`Session ${sessionId} timed out (${duration}).`);
	} else if (info.cancelled) {
		parts.push(`Session ${sessionId} completed (${duration}).`);
	} else if (info.exitCode === 0) {
		parts.push(`Session ${sessionId} completed successfully (${duration}).`);
	} else {
		parts.push(`Session ${sessionId} exited with code ${info.exitCode} (${duration}).`);
	}
	if (info.completionOutput && info.completionOutput.totalLines > 0) {
		parts.push(` ${info.completionOutput.totalLines} lines of output.`);
	}
	if (info.completionOutput && info.completionOutput.lines.length > 0) {
		const allLines = info.completionOutput.lines;
		let end = allLines.length;
		while (end > 0 && allLines[end - 1].trim() === "") end--;
		const tail = allLines.slice(Math.max(0, end - BRIEF_TAIL_LINES), end);
		if (tail.length > 0) {
			parts.push(`\n\n${tail.join("\n")}`);
		}
	}
	parts.push(`\n\nAttach to review full output: interactive_shell({ attach: "${sessionId}" })`);
	return parts.join("");
}

function buildResultNotification(sessionId: string, result: InteractiveShellResult): string {
	const parts: string[] = [];
	if (result.timedOut) {
		parts.push(`Session ${sessionId} timed out.`);
	} else if (result.cancelled) {
		parts.push(`Session ${sessionId} was killed.`);
	} else if (result.exitCode === 0) {
		parts.push(`Session ${sessionId} completed successfully.`);
	} else {
		parts.push(`Session ${sessionId} exited with code ${result.exitCode}.`);
	}
	if (result.completionOutput && result.completionOutput.lines.length > 0) {
		const truncNote = result.completionOutput.truncated
			? ` (truncated from ${result.completionOutput.totalLines} total lines)`
			: "";
		parts.push(`\nOutput (${result.completionOutput.lines.length} lines${truncNote}):\n\n${result.completionOutput.lines.join("\n")}`);
	}
	return parts.join("");
}

function makeMonitorCompletionCallback(
	pi: ExtensionAPI,
	id: string,
	startTime: number,
): (info: HeadlessCompletionInfo) => void {
	return (info) => {
		const duration = formatDuration(Date.now() - startTime);
		const content = buildDispatchNotification(id, info, duration);
		pi.sendMessage({
			customType: "interactive-shell-transfer",
			content,
			display: true,
			details: { sessionId: id, duration, ...info },
		}, { triggerTurn: true });
		pi.events.emit("interactive-shell:transfer", { sessionId: id, ...info });
		sessionManager.unregisterActive(id, false);
		headlessMonitors.delete(id);
		sessionManager.scheduleCleanup(id, 5 * 60 * 1000);
	};
}

function registerHeadlessActive(
	id: string,
	command: string,
	reason: string | undefined,
	session: PtyTerminalSession,
	monitor: HeadlessDispatchMonitor,
	startTime: number,
): void {
	sessionManager.registerActive({
		id,
		command,
		reason,
		write: (data) => session.write(data),
		kill: () => {
			monitor.dispose();
			sessionManager.remove(id);
			sessionManager.unregisterActive(id, true);
			headlessMonitors.delete(id);
		},
		background: () => {},
		getOutput: (opts) => getHeadlessOutput(session, opts),
		getStatus: () => session.exited ? "exited" : "running",
		getRuntime: () => Date.now() - startTime,
		getResult: () => monitor.getResult(),
		onComplete: (cb) => monitor.registerCompleteCallback(cb),
	});
}

let bgWidgetCleanup: (() => void) | null = null;

function setupBackgroundWidget(ctx: { ui: { setWidget: Function }; hasUI?: boolean }) {
	if (!ctx.hasUI) return;

	bgWidgetCleanup?.();

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

	bgWidgetCleanup = () => {
		unsubscribe();
		if (durationTimer) {
			clearInterval(durationTimer);
			durationTimer = null;
		}
		ctx.ui.setWidget("bg-sessions", undefined);
		bgWidgetCleanup = null;
	};
}

export default function interactiveShellExtension(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => setupBackgroundWidget(ctx));
	pi.on("session_switch", (_event, ctx) => setupBackgroundWidget(ctx));

	pi.on("session_shutdown", () => {
		bgWidgetCleanup?.();
		sessionManager.killAll();
		for (const [id, monitor] of headlessMonitors) {
			monitor.dispose();
			headlessMonitors.delete(id);
		}
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: TOOL_LABEL,
		description: TOOL_DESCRIPTION,
		parameters: toolParameters,

		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			const {
				command,
				sessionId,
				kill,
				outputLines,
				outputMaxChars,
				outputOffset,
				drain,
				incremental,
				settings,
				input,
				inputKeys,
				inputHex,
				inputPaste,
				cwd,
				name,
				reason,
				mode,
				background,
				attach,
				listBackground,
				dismissBackground,
				handsFree,
				handoffPreview,
				handoffSnapshot,
				timeout,
			} = params as ToolParams;

			const hasStructuredInput = inputKeys?.length || inputHex?.length || inputPaste;
			const effectiveInput = hasStructuredInput
				? { text: input, keys: inputKeys, hex: inputHex, paste: inputPaste }
				: input;

			// ── Branch 1: Interact with existing session ──
			if (sessionId) {
				const session = sessionManager.getActive(sessionId);
				if (!session) {
					return {
						content: [{ type: "text", text: `Session not found or no longer active: ${sessionId}` }],
						isError: true,
						details: { sessionId, error: "session_not_found" },
					};
				}

				// Kill
				if (kill) {
					const hMonitor = headlessMonitors.get(sessionId);
					if (!hMonitor || hMonitor.disposed) {
						agentHandledCompletion = true;
					}
					const { output, truncated, totalBytes, totalLines, hasMore } = session.getOutput({ skipRateLimit: true, lines: outputLines, maxChars: outputMaxChars, offset: outputOffset, drain, incremental });
					const status = session.getStatus();
					const runtime = session.getRuntime();
					session.kill();
					sessionManager.unregisterActive(sessionId, true);

					const truncatedNote = truncated ? ` (${totalBytes} bytes total, truncated)` : "";
					const hasMoreNote = hasMore === true ? " (more available)" : "";
					return {
						content: [{ type: "text", text: `Session ${sessionId} killed after ${formatDurationMs(runtime)}${output ? `\n\nFinal output${truncatedNote}${hasMoreNote}:\n${output}` : ""}` }],
						details: { sessionId, status: "killed", runtime, output, outputTruncated: truncated, outputTotalBytes: totalBytes, outputTotalLines: totalLines, hasMore, previousStatus: status },
					};
				}

				// Background
				if (background) {
					if (session.getResult()) {
						return {
							content: [{ type: "text", text: "Session already completed." }],
							details: session.getResult(),
						};
					}
					const bMonitor = headlessMonitors.get(sessionId);
					if (!bMonitor || bMonitor.disposed) {
						agentHandledCompletion = true;
					}
					session.background();
					const result = session.getResult();
					if (!result || !result.backgrounded) {
						agentHandledCompletion = false;
						return {
							content: [{ type: "text", text: `Session ${sessionId} is already running in the background.` }],
							details: { sessionId },
						};
					}
					sessionManager.unregisterActive(sessionId, false);
					return {
						content: [{ type: "text", text: `Session backgrounded (id: ${result.backgroundId})` }],
						details: { sessionId, backgroundId: result.backgroundId, ...result },
					};
				}

				const actions: string[] = [];

				if (settings?.updateInterval !== undefined) {
					if (sessionManager.setActiveUpdateInterval(sessionId, settings.updateInterval)) {
						actions.push(`update interval set to ${settings.updateInterval}ms`);
					}
				}
				if (settings?.quietThreshold !== undefined) {
					if (sessionManager.setActiveQuietThreshold(sessionId, settings.quietThreshold)) {
						actions.push(`quiet threshold set to ${settings.quietThreshold}ms`);
					}
				}

				if (effectiveInput !== undefined) {
					const translatedInput = translateInput(effectiveInput);
					const success = sessionManager.writeToActive(sessionId, translatedInput);
					if (!success) {
						return {
							content: [{ type: "text", text: `Failed to send input to session: ${sessionId}` }],
							isError: true,
							details: { sessionId, error: "write_failed" },
						};
					}
					const inputDesc = typeof effectiveInput === "string"
						? effectiveInput.length === 0 ? "(empty)" : effectiveInput.length > 50 ? `${effectiveInput.slice(0, 50)}...` : effectiveInput
						: [effectiveInput.text ?? "", effectiveInput.keys ? `keys:[${effectiveInput.keys.join(",")}]` : "", effectiveInput.hex ? `hex:[${effectiveInput.hex.length} bytes]` : "", effectiveInput.paste ? `paste:[${effectiveInput.paste.length} chars]` : ""].filter(Boolean).join(" + ") || "(empty)";
					actions.push(`sent: ${inputDesc}`);
				}

				if (actions.length === 0) {
					const status = session.getStatus();
					const runtime = session.getRuntime();
					const result = session.getResult();

					if (result) {
						const { output, truncated, totalBytes, totalLines, hasMore } = session.getOutput({ skipRateLimit: true, lines: outputLines, maxChars: outputMaxChars, offset: outputOffset, drain, incremental });
						const truncatedNote = truncated ? ` (${totalBytes} bytes total, truncated)` : "";
						const hasOutput = output.length > 0;
						const hasMoreNote = hasMore === true ? " (more available)" : "";
						sessionManager.unregisterActive(sessionId, !result.backgrounded);
						return {
							content: [{ type: "text", text: `Session ${sessionId} ${status} after ${formatDurationMs(runtime)}${hasOutput ? `\n\nOutput${truncatedNote}${hasMoreNote}:\n${output}` : ""}` }],
							details: { sessionId, status, runtime, output, outputTruncated: truncated, outputTotalBytes: totalBytes, outputTotalLines: totalLines, hasMore, exitCode: result.exitCode, signal: result.signal, backgroundId: result.backgroundId },
						};
					}

					const outputResult = session.getOutput({ lines: outputLines, maxChars: outputMaxChars, offset: outputOffset, drain, incremental });

					if (outputResult.rateLimited && outputResult.waitSeconds) {
						const waitMs = outputResult.waitSeconds * 1000;
						const completedEarly = await Promise.race([
							new Promise<false>((resolve) => setTimeout(() => resolve(false), waitMs)),
							new Promise<true>((resolve) => session.onComplete(() => resolve(true))),
						]);

						if (completedEarly) {
							const earlySession = sessionManager.getActive(sessionId);
							if (!earlySession) {
								return { content: [{ type: "text", text: `Session ${sessionId} ended` }], details: { sessionId, status: "ended" } };
							}
							const earlyResult = earlySession.getResult();
							const { output, truncated, totalBytes, totalLines, hasMore } = earlySession.getOutput({ skipRateLimit: true, lines: outputLines, maxChars: outputMaxChars, offset: outputOffset, drain, incremental });
							const earlyStatus = earlySession.getStatus();
							const earlyRuntime = earlySession.getRuntime();
							const truncatedNote = truncated ? ` (${totalBytes} bytes total, truncated)` : "";
							const hasOutput = output.length > 0;
							const hasMoreNote = hasMore === true ? " (more available)" : "";
							if (earlyResult) {
								sessionManager.unregisterActive(sessionId, !earlyResult.backgrounded);
								return {
									content: [{ type: "text", text: `Session ${sessionId} ${earlyStatus} after ${formatDurationMs(earlyRuntime)}${hasOutput ? `\n\nOutput${truncatedNote}${hasMoreNote}:\n${output}` : ""}` }],
									details: { sessionId, status: earlyStatus, runtime: earlyRuntime, output, outputTruncated: truncated, outputTotalBytes: totalBytes, outputTotalLines: totalLines, hasMore, exitCode: earlyResult.exitCode, signal: earlyResult.signal, backgroundId: earlyResult.backgroundId },
								};
							}
							return {
								content: [{ type: "text", text: `Session ${sessionId} ${earlyStatus} (${formatDurationMs(earlyRuntime)})${hasOutput ? `\n\nOutput${truncatedNote}${hasMoreNote}:\n${output}` : ""}` }],
								details: { sessionId, status: earlyStatus, runtime: earlyRuntime, output, outputTruncated: truncated, outputTotalBytes: totalBytes, outputTotalLines: totalLines, hasMore, hasOutput },
							};
						}

						const freshOutput = session.getOutput({ lines: outputLines, maxChars: outputMaxChars, offset: outputOffset, drain, incremental });
						const truncatedNote = freshOutput.truncated ? ` (${freshOutput.totalBytes} bytes total, truncated)` : "";
						const hasOutput = freshOutput.output.length > 0;
						const hasMoreNote = freshOutput.hasMore === true ? " (more available)" : "";
						const freshStatus = session.getStatus();
						const freshRuntime = session.getRuntime();
						const freshResult = session.getResult();
						if (freshResult) {
							sessionManager.unregisterActive(sessionId, !freshResult.backgrounded);
							return {
								content: [{ type: "text", text: `Session ${sessionId} ${freshStatus} after ${formatDurationMs(freshRuntime)}${hasOutput ? `\n\nOutput${truncatedNote}${hasMoreNote}:\n${freshOutput.output}` : ""}` }],
								details: { sessionId, status: freshStatus, runtime: freshRuntime, output: freshOutput.output, outputTruncated: freshOutput.truncated, outputTotalBytes: freshOutput.totalBytes, outputTotalLines: freshOutput.totalLines, hasMore: freshOutput.hasMore, exitCode: freshResult.exitCode, signal: freshResult.signal, backgroundId: freshResult.backgroundId },
							};
						}
						return {
							content: [{ type: "text", text: `Session ${sessionId} ${freshStatus} (${formatDurationMs(freshRuntime)})${hasOutput ? `\n\nOutput${truncatedNote}${hasMoreNote}:\n${freshOutput.output}` : ""}` }],
							details: { sessionId, status: freshStatus, runtime: freshRuntime, output: freshOutput.output, outputTruncated: freshOutput.truncated, outputTotalBytes: freshOutput.totalBytes, outputTotalLines: freshOutput.totalLines, hasMore: freshOutput.hasMore, hasOutput },
						};
					}

					const { output, truncated, totalBytes, totalLines, hasMore } = outputResult;
					const truncatedNote = truncated ? ` (${totalBytes} bytes total, truncated)` : "";
					const hasOutput = output.length > 0;
					const hasMoreNote = hasMore === true ? " (more available)" : "";
					return {
						content: [{ type: "text", text: `Session ${sessionId} ${status} (${formatDurationMs(runtime)})${hasOutput ? `\n\nOutput${truncatedNote}${hasMoreNote}:\n${output}` : ""}` }],
						details: { sessionId, status, runtime, output, outputTruncated: truncated, outputTotalBytes: totalBytes, outputTotalLines: totalLines, hasMore, hasOutput },
					};
				}

				return {
					content: [{ type: "text", text: `Session ${sessionId}: ${actions.join(", ")}` }],
					details: { sessionId, actions },
				};
			}

			// ── Branch 2: Attach to background session ──
			if (attach) {
				if (background) {
					return {
						content: [{ type: "text", text: "Cannot attach and background simultaneously." }],
						isError: true,
					};
				}
				if (!ctx.hasUI) {
					return {
						content: [{ type: "text", text: "Attach requires interactive TUI mode" }],
						isError: true,
					};
				}
				if (overlayOpen) {
					return {
						content: [{ type: "text", text: "An interactive shell overlay is already open." }],
						isError: true,
						details: { error: "overlay_already_open" },
					};
				}

				const bgSession = sessionManager.take(attach);
				if (!bgSession) {
					return {
						content: [{ type: "text", text: `Background session not found: ${attach}` }],
						isError: true,
					};
				}

				const config = loadConfig(cwd ?? ctx.cwd);
				const reattachSessionId = attach;
				const monitor = headlessMonitors.get(attach);

				const isNonBlocking = mode === "hands-free" || mode === "dispatch";

				overlayOpen = true;
				const attachStartTime = Date.now();
				const overlayPromise = ctx.ui.custom<InteractiveShellResult>(
					(tui, theme, _kb, done) =>
						new InteractiveShellOverlay(tui, theme, {
							command: bgSession.command,
							existingSession: bgSession.session,
							sessionId: reattachSessionId,
							mode,
							cwd: cwd ?? ctx.cwd,
							name: bgSession.name,
							reason: bgSession.reason ?? reason,
							handsFreeUpdateMode: handsFree?.updateMode,
							handsFreeUpdateInterval: handsFree?.updateInterval,
							handsFreeQuietThreshold: handsFree?.quietThreshold,
							handsFreeUpdateMaxChars: handsFree?.updateMaxChars,
							handsFreeMaxTotalChars: handsFree?.maxTotalChars,
							autoExitOnQuiet: mode === "dispatch"
								? handsFree?.autoExitOnQuiet !== false
								: handsFree?.autoExitOnQuiet === true,
							handoffPreviewEnabled: handoffPreview?.enabled,
							handoffPreviewLines: handoffPreview?.lines,
							handoffPreviewMaxChars: handoffPreview?.maxChars,
							handoffSnapshotEnabled: handoffSnapshot?.enabled,
							handoffSnapshotLines: handoffSnapshot?.lines,
							handoffSnapshotMaxChars: handoffSnapshot?.maxChars,
							timeout,
						}, config, done),
					{
						overlay: true,
						overlayOptions: {
							width: `${config.overlayWidthPercent}%`,
							maxHeight: `${config.overlayHeightPercent}%`,
							anchor: "center",
							margin: 1,
						},
					},
				);

				if (isNonBlocking) {
					setupDispatchCompletion(pi, overlayPromise, config, {
						id: reattachSessionId,
						mode: mode!,
						command: bgSession.command,
						reason: bgSession.reason,
						timeout,
						handsFree,
						overlayStartTime: attachStartTime,
					});
					return {
						content: [{ type: "text", text: mode === "dispatch"
							? `Reattached to ${reattachSessionId}. You'll be notified when it completes.`
							: `Reattached to ${reattachSessionId}.\nUse interactive_shell({ sessionId: "${reattachSessionId}" }) to check status/output.` }],
						details: { sessionId: reattachSessionId, status: "running", command: bgSession.command, reason: bgSession.reason, mode },
					};
				}

				// Blocking (interactive) attach
				let result: InteractiveShellResult;
				try {
					result = await overlayPromise;
				} finally {
					overlayOpen = false;
				}
				if (monitor) {
					monitor.dispose();
					headlessMonitors.delete(attach);
					sessionManager.unregisterActive(attach, !result.backgrounded);
				} else if (!result.backgrounded) {
					releaseSessionId(attach);
				}

				let summary: string;
				if (result.transferred) {
					const truncatedNote = result.transferred.truncated ? ` (truncated from ${result.transferred.totalLines} total lines)` : "";
					summary = `Session output transferred (${result.transferred.lines.length} lines${truncatedNote}):\n\n${result.transferred.lines.join("\n")}`;
				} else if (result.backgrounded) {
					summary = `Session running in background (id: ${result.backgroundId}). User can reattach with /attach ${result.backgroundId}`;
				} else if (result.cancelled) {
					summary = "Session killed";
				} else if (result.timedOut) {
					summary = `Session killed after timeout (${timeout ?? "?"}ms)`;
				} else {
					const status = result.exitCode === 0 ? "successfully" : `with code ${result.exitCode}`;
					summary = `Session ended ${status}`;
				}
				if (!result.transferred && result.handoffPreview?.type === "tail" && result.handoffPreview.lines.length > 0) {
					summary += `\n\nOverlay tail (${result.handoffPreview.when}, last ${result.handoffPreview.lines.length} lines):\n${result.handoffPreview.lines.join("\n")}`;
				}
				return { content: [{ type: "text", text: summary }], details: result };
			}

			// ── Branch 3: List background sessions ──
			if (listBackground) {
				const sessions = sessionManager.list();
				if (sessions.length === 0) {
					return { content: [{ type: "text", text: "No background sessions." }] };
				}
				const lines = sessions.map(s => {
					const status = s.session.exited ? "exited" : "running";
					const duration = formatDuration(Date.now() - s.startedAt.getTime());
					const r = s.reason ? ` \u2022 ${s.reason}` : "";
					return `  ${s.id} - ${s.command}${r} (${status}, ${duration})`;
				});
				return { content: [{ type: "text", text: `Background sessions:\n${lines.join("\n")}` }] };
			}

			// ── Branch 3b: Dismiss background sessions ──
			if (dismissBackground) {
				if (typeof dismissBackground === "string") {
					if (!sessionManager.list().some(s => s.id === dismissBackground)) {
						return { content: [{ type: "text", text: `Background session not found: ${dismissBackground}` }], isError: true };
					}
				}

				const targetIds = typeof dismissBackground === "string"
					? [dismissBackground]
					: sessionManager.list().map(s => s.id);

				if (targetIds.length === 0) {
					return { content: [{ type: "text", text: "No background sessions to dismiss." }] };
				}

				for (const tid of targetIds) {
					const monitor = headlessMonitors.get(tid);
					if (monitor) {
						monitor.dispose();
						headlessMonitors.delete(tid);
					}
					sessionManager.unregisterActive(tid, false);
					sessionManager.remove(tid);
				}

				const summary = targetIds.length === 1
					? `Dismissed session ${targetIds[0]}.`
					: `Dismissed ${targetIds.length} sessions: ${targetIds.join(", ")}.`;
				return { content: [{ type: "text", text: summary }] };
			}

			// ── Branch 4: Start new session ──
			if (!command) {
				return {
					content: [{ type: "text", text: "One of 'command', 'sessionId', 'attach', 'listBackground', or 'dismissBackground' is required." }],
					isError: true,
				};
			}

			const effectiveCwd = cwd ?? ctx.cwd;
			const config = loadConfig(effectiveCwd);
			const isNonBlocking = mode === "hands-free" || mode === "dispatch";

			// ── Branch 4a: Headless dispatch ──
			if (mode === "dispatch" && background) {
				const id = generateSessionId(name);
				const session = new PtyTerminalSession(
					{ command, cwd: effectiveCwd, cols: 120, rows: 40, scrollback: config.scrollbackLines },
				);
				sessionManager.add(command, session, name, reason, { id, noAutoCleanup: true });

				const startTime = Date.now();
				const monitor = new HeadlessDispatchMonitor(session, config, {
					autoExitOnQuiet: handsFree?.autoExitOnQuiet !== false,
					quietThreshold: handsFree?.quietThreshold ?? config.handsFreeQuietThreshold,
					timeout,
				}, makeMonitorCompletionCallback(pi, id, startTime));
				headlessMonitors.set(id, monitor);
				registerHeadlessActive(id, command, reason, session, monitor, startTime);

				return {
					content: [{ type: "text", text: `Session dispatched in background (id: ${id}).\nYou'll be notified when it completes. User can /attach ${id} to watch.` }],
					details: { sessionId: id, backgroundId: id, mode: "dispatch", background: true },
				};
			}

			// Validate: background only valid with dispatch for new sessions
			if (background) {
				return {
					content: [{ type: "text", text: "background: true requires mode='dispatch' for new sessions." }],
					isError: true,
				};
			}

			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "Interactive shell requires interactive TUI mode" }],
					isError: true,
				};
			}

			if (overlayOpen) {
				return {
					content: [{ type: "text", text: "An interactive shell overlay is already open. Wait for it to close or kill the active session before starting a new one." }],
					isError: true,
					details: { error: "overlay_already_open" },
				};
			}

			const generatedSessionId = isNonBlocking ? generateSessionId(name) : undefined;

			// ── Non-blocking path (hands-free or dispatch) ──
			if (isNonBlocking && generatedSessionId) {
				overlayOpen = true;
				const overlayStartTime = Date.now();

				const overlayPromise = ctx.ui.custom<InteractiveShellResult>(
					(tui, theme, _kb, done) =>
						new InteractiveShellOverlay(tui, theme, {
							command,
							cwd: effectiveCwd,
							name,
							reason,
							mode,
							sessionId: generatedSessionId,
							handsFreeUpdateMode: handsFree?.updateMode,
							handsFreeUpdateInterval: handsFree?.updateInterval,
							handsFreeQuietThreshold: handsFree?.quietThreshold,
							handsFreeUpdateMaxChars: handsFree?.updateMaxChars,
							handsFreeMaxTotalChars: handsFree?.maxTotalChars,
							autoExitOnQuiet: mode === "dispatch"
								? handsFree?.autoExitOnQuiet !== false
								: handsFree?.autoExitOnQuiet === true,
							handoffPreviewEnabled: handoffPreview?.enabled,
							handoffPreviewLines: handoffPreview?.lines,
							handoffPreviewMaxChars: handoffPreview?.maxChars,
							handoffSnapshotEnabled: handoffSnapshot?.enabled,
							handoffSnapshotLines: handoffSnapshot?.lines,
							handoffSnapshotMaxChars: handoffSnapshot?.maxChars,
							timeout,
						}, config, done),
					{
						overlay: true,
						overlayOptions: {
							width: `${config.overlayWidthPercent}%`,
							maxHeight: `${config.overlayHeightPercent}%`,
							anchor: "center",
							margin: 1,
						},
					},
				);

				setupDispatchCompletion(pi, overlayPromise, config, {
					id: generatedSessionId,
					mode: mode!,
					command,
					reason,
					timeout,
					handsFree,
					overlayStartTime,
				});

				if (mode === "dispatch") {
					return {
						content: [{ type: "text", text: `Session dispatched (id: ${generatedSessionId}).\nYou'll be notified when it completes.\nYou can still query with interactive_shell({ sessionId: "${generatedSessionId}" }) if needed.` }],
						details: { sessionId: generatedSessionId, status: "running", command, reason, mode },
					};
				}
				return {
					content: [{ type: "text", text: `Session started: ${generatedSessionId}\nCommand: ${command}\n\nUse interactive_shell({ sessionId: "${generatedSessionId}" }) to check status/output.\nUse interactive_shell({ sessionId: "${generatedSessionId}", kill: true }) to end when done.` }],
					details: { sessionId: generatedSessionId, status: "running", command, reason },
				};
			}

			// ── Blocking (interactive) path ──
			overlayOpen = true;
			onUpdate?.({
				content: [{ type: "text", text: `Opening: ${command}` }],
				details: { exitCode: null, backgrounded: false, cancelled: false },
			});

			let result: InteractiveShellResult;
			try {
				result = await ctx.ui.custom<InteractiveShellResult>(
					(tui, theme, _kb, done) =>
						new InteractiveShellOverlay(tui, theme, {
							command,
							cwd: effectiveCwd,
							name,
							reason,
							mode,
							sessionId: generatedSessionId,
							handsFreeUpdateMode: handsFree?.updateMode,
							handsFreeUpdateInterval: handsFree?.updateInterval,
							handsFreeQuietThreshold: handsFree?.quietThreshold,
							handsFreeUpdateMaxChars: handsFree?.updateMaxChars,
							handsFreeMaxTotalChars: handsFree?.maxTotalChars,
							autoExitOnQuiet: handsFree?.autoExitOnQuiet,
							onHandsFreeUpdate: mode === "hands-free"
								? (update) => {
									let statusText: string;
									switch (update.status) {
										case "user-takeover":
											statusText = `User took over session ${update.sessionId}`;
											break;
										case "exited":
											statusText = `Session ${update.sessionId} exited`;
											break;
										default: {
											const budgetInfo = update.budgetExhausted ? " [budget exhausted]" : "";
											statusText = `Session ${update.sessionId} running (${formatDurationMs(update.runtime)})${budgetInfo}`;
										}
									}
									const newOutput = update.status === "running" && update.tail.length > 0
										? `\n\n${update.tail.join("\n")}`
										: "";
									onUpdate?.({
										content: [{ type: "text", text: statusText + newOutput }],
										details: {
											status: update.status,
											sessionId: update.sessionId,
											runtime: update.runtime,
											newChars: update.tail.join("\n").length,
											totalCharsSent: update.totalCharsSent,
											budgetExhausted: update.budgetExhausted,
											userTookOver: update.userTookOver,
										},
									});
								}
								: undefined,
							handoffPreviewEnabled: handoffPreview?.enabled,
							handoffPreviewLines: handoffPreview?.lines,
							handoffPreviewMaxChars: handoffPreview?.maxChars,
							handoffSnapshotEnabled: handoffSnapshot?.enabled,
							handoffSnapshotLines: handoffSnapshot?.lines,
							handoffSnapshotMaxChars: handoffSnapshot?.maxChars,
							timeout,
						}, config, done),
					{
						overlay: true,
						overlayOptions: {
							width: `${config.overlayWidthPercent}%`,
							maxHeight: `${config.overlayHeightPercent}%`,
							anchor: "center",
							margin: 1,
						},
					},
				);
			} finally {
				overlayOpen = false;
			}

			let summary: string;
			if (result.transferred) {
				const truncatedNote = result.transferred.truncated ? ` (truncated from ${result.transferred.totalLines} total lines)` : "";
				summary = `Session output transferred (${result.transferred.lines.length} lines${truncatedNote}):\n\n${result.transferred.lines.join("\n")}`;
			} else if (result.backgrounded) {
				summary = `Session running in background (id: ${result.backgroundId}). User can reattach with /attach ${result.backgroundId}`;
			} else if (result.cancelled) {
				summary = "User killed the interactive session";
			} else if (result.timedOut) {
				summary = `Session killed after timeout (${timeout ?? "?"}ms)`;
			} else {
				const status = result.exitCode === 0 ? "successfully" : `with code ${result.exitCode}`;
				summary = `Session ended ${status}`;
			}

			if (result.userTookOver) {
				summary += "\n\nNote: User took over control during hands-free mode.";
			}

			const warning = buildIdlePromptWarning(command, reason);
			if (warning) {
				summary += `\n\n${warning}`;
			}

			if (!result.transferred && result.handoffPreview?.type === "tail" && result.handoffPreview.lines.length > 0) {
				summary += `\n\nOverlay tail (${result.handoffPreview.when}, last ${result.handoffPreview.lines.length} lines):\n${result.handoffPreview.lines.join("\n")}`;
			}

			return { content: [{ type: "text", text: summary }], details: result };
		},
	});

	pi.registerCommand("attach", {
		description: "Reattach to a background shell session",
		handler: async (args, ctx) => {
			if (overlayOpen) {
				ctx.ui.notify("An overlay is already open. Close it first.", "error");
				return;
			}

			const sessions = sessionManager.list();
			if (sessions.length === 0) {
				ctx.ui.notify("No background sessions", "info");
				return;
			}

			let targetId = args.trim();
			if (!targetId) {
				const options = sessions.map((s) => {
					const status = s.session.exited ? "exited" : "running";
					const duration = formatDuration(Date.now() - s.startedAt.getTime());
					const sanitizedCommand = s.command.replace(/\s+/g, " ").trim();
					const sanitizedReason = s.reason?.replace(/\s+/g, " ").trim();
					const r = sanitizedReason ? ` \u2022 ${sanitizedReason}` : "";
					return `${s.id} - ${sanitizedCommand}${r} (${status}, ${duration})`;
				});
				const choice = await ctx.ui.select("Background Sessions", options);
				if (!choice) return;
				targetId = choice.split(" - ")[0]!;
			}

			const monitor = headlessMonitors.get(targetId);

			const session = sessionManager.get(targetId);
			if (!session) {
				ctx.ui.notify(`Session not found: ${targetId}`, "error");
				return;
			}

			const config = loadConfig(ctx.cwd);
			overlayOpen = true;
			try {
				const result = await ctx.ui.custom<InteractiveShellResult>(
					(tui, theme, _kb, done) =>
						new ReattachOverlay(tui, theme, { id: session.id, command: session.command, reason: session.reason, session: session.session }, config, done),
					{
						overlay: true,
						overlayOptions: {
							width: `${config.overlayWidthPercent}%`,
							maxHeight: `${config.overlayHeightPercent}%`,
							anchor: "center",
							margin: 1,
						},
					},
				);

				if (monitor && !monitor.disposed) {
					if (!result.backgrounded) {
						monitor.handleExternalCompletion(result.exitCode, result.signal, result.completionOutput);
						headlessMonitors.delete(targetId);
					}
				} else if (result.backgrounded) {
					sessionManager.restartAutoCleanup(targetId);
				} else {
					sessionManager.scheduleCleanup(targetId);
				}
			} finally {
				overlayOpen = false;
			}
		},
	});

	pi.registerCommand("dismiss", {
		description: "Dismiss background shell sessions (kill running, remove exited)",
		handler: async (args, ctx) => {
			const sessions = sessionManager.list();
			if (sessions.length === 0) {
				ctx.ui.notify("No background sessions", "info");
				return;
			}

			let targetIds: string[];
			const arg = args.trim();
			if (arg) {
				if (!sessions.some(s => s.id === arg)) {
					ctx.ui.notify(`Session not found: ${arg}`, "error");
					return;
				}
				targetIds = [arg];
			} else if (sessions.length === 1) {
				targetIds = [sessions[0].id];
			} else {
				const options = ["All sessions", ...sessions.map((s) => {
					const status = s.session.exited ? "exited" : "running";
					const duration = formatDuration(Date.now() - s.startedAt.getTime());
					return `${s.id} (${status}, ${duration})`;
				})];
				const choice = await ctx.ui.select("Dismiss sessions", options);
				if (!choice) return;
				targetIds = choice === "All sessions"
					? sessions.map(s => s.id)
					: [choice.split(" (")[0]];
			}

			for (const tid of targetIds) {
				const monitor = headlessMonitors.get(tid);
				if (monitor) {
					monitor.dispose();
					headlessMonitors.delete(tid);
				}
				sessionManager.unregisterActive(tid, false);
				sessionManager.remove(tid);
			}

			const noun = targetIds.length === 1 ? "session" : "sessions";
			ctx.ui.notify(`Dismissed ${targetIds.length} ${noun}`, "info");
		},
	});
}

function setupDispatchCompletion(
	pi: ExtensionAPI,
	overlayPromise: Promise<InteractiveShellResult>,
	config: InteractiveShellConfig,
	ctx: {
		id: string;
		mode: string;
		command: string;
		reason?: string;
		timeout?: number;
		handsFree?: { autoExitOnQuiet?: boolean; quietThreshold?: number };
		overlayStartTime?: number;
	},
): void {
	const { id, mode, command, reason } = ctx;

	overlayPromise.then((result) => {
		overlayOpen = false;

		const wasAgentInitiated = agentHandledCompletion;
		agentHandledCompletion = false;

		if (result.transferred) {
			const truncatedNote = result.transferred.truncated
				? ` (truncated from ${result.transferred.totalLines} total lines)`
				: "";
			const content = `Session ${id} output transferred (${result.transferred.lines.length} lines${truncatedNote}):\n\n${result.transferred.lines.join("\n")}`;
			pi.sendMessage({
				customType: "interactive-shell-transfer",
				content,
				display: true,
				details: { sessionId: id, transferred: result.transferred, exitCode: result.exitCode, signal: result.signal },
			}, { triggerTurn: true });
			pi.events.emit("interactive-shell:transfer", { sessionId: id, transferred: result.transferred, exitCode: result.exitCode, signal: result.signal });
			sessionManager.unregisterActive(id, true);

			const remainingMonitor = headlessMonitors.get(id);
			if (remainingMonitor) { remainingMonitor.dispose(); headlessMonitors.delete(id); }
		} else if (mode === "dispatch" && result.backgrounded) {
			if (!wasAgentInitiated) {
				pi.sendMessage({
					customType: "interactive-shell-transfer",
					content: `Session ${id} moved to background (id: ${result.backgroundId}).`,
					display: true,
					details: { sessionId: id, backgroundId: result.backgroundId },
				}, { triggerTurn: true });
			}
			sessionManager.unregisterActive(id, false);

			const existingMonitor = headlessMonitors.get(id);
			if (existingMonitor && !existingMonitor.disposed) {
				const bgSession = sessionManager.get(result.backgroundId!);
				if (bgSession) {
					registerHeadlessActive(result.backgroundId!, command, reason, bgSession.session, existingMonitor, existingMonitor.startTime);
				}
			} else if (!existingMonitor) {
				const bgSession = sessionManager.get(result.backgroundId!);
				if (bgSession) {
					const bgId = result.backgroundId!;
					const bgStartTime = ctx.overlayStartTime ?? Date.now();
					const elapsed = ctx.overlayStartTime ? Date.now() - ctx.overlayStartTime : 0;
					const remainingTimeout = ctx.timeout ? Math.max(0, ctx.timeout - elapsed) : undefined;

					const monitor = new HeadlessDispatchMonitor(bgSession.session, config, {
						autoExitOnQuiet: ctx.handsFree?.autoExitOnQuiet !== false,
						quietThreshold: ctx.handsFree?.quietThreshold ?? config.handsFreeQuietThreshold,
						timeout: remainingTimeout,
					}, makeMonitorCompletionCallback(pi, bgId, bgStartTime));
					headlessMonitors.set(bgId, monitor);
					registerHeadlessActive(bgId, command, reason, bgSession.session, monitor, bgStartTime);
				}
			}
		} else if (mode === "dispatch") {
			if (!wasAgentInitiated) {
				const content = buildResultNotification(id, result);
				pi.sendMessage({
					customType: "interactive-shell-transfer",
					content,
					display: true,
					details: { sessionId: id, exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut, cancelled: result.cancelled, completionOutput: result.completionOutput },
				}, { triggerTurn: true });
			}
			pi.events.emit("interactive-shell:transfer", {
				sessionId: id,
				completionOutput: result.completionOutput,
				exitCode: result.exitCode,
				signal: result.signal,
				timedOut: result.timedOut,
				cancelled: result.cancelled,
			});
			sessionManager.unregisterActive(id, true);

			const remainingMonitor = headlessMonitors.get(id);
			if (remainingMonitor) { remainingMonitor.dispose(); headlessMonitors.delete(id); }
		}

		if (mode !== "dispatch") {
			const staleMonitor = headlessMonitors.get(id);
			if (staleMonitor) { staleMonitor.dispose(); headlessMonitors.delete(id); }
		}
	}).catch(() => {
		overlayOpen = false;
		sessionManager.unregisterActive(id, true);
		const orphanedMonitor = headlessMonitors.get(id);
		if (orphanedMonitor) { orphanedMonitor.dispose(); headlessMonitors.delete(id); }
	});
}

function buildIdlePromptWarning(command: string, reason: string | undefined): string | null {
	if (!reason) return null;

	const tasky = /\b(scan|check|review|summariz|analyz|inspect|audit|find|fix|refactor|debug|investigat|explore|enumerat|list)\b/i;
	if (!tasky.test(reason)) return null;

	const trimmed = command.trim();
	const binaries = ["pi", "claude", "codex", "gemini", "cursor-agent"] as const;
	const bin = binaries.find((b) => trimmed === b || trimmed.startsWith(`${b} `));
	if (!bin) return null;

	const rest = trimmed === bin ? "" : trimmed.slice(bin.length).trim();
	const hasQuotedPrompt = /["']/.test(rest);
	const hasKnownPromptFlag =
		/\b(-p|--print|--prompt|--prompt-interactive|-i|exec)\b/.test(rest) ||
		(bin === "pi" && /\b-p\b/.test(rest)) ||
		(bin === "codex" && /\bexec\b/.test(rest));

	if (hasQuotedPrompt || hasKnownPromptFlag) return null;
	if (rest.length === 0 || /^(-{1,2}[A-Za-z0-9][A-Za-z0-9-]*(?:=[^\s]+)?\s*)+$/.test(rest)) {
		const examplePrompt = reason.replace(/\s+/g, " ").trim();
		const clipped = examplePrompt.length > 120 ? `${examplePrompt.slice(0, 117)}...` : examplePrompt;
		return `Note: \`reason\` is UI-only. This command likely started the agent idle. If you intended an initial prompt, embed it in \`command\`, e.g. \`${bin} "${clipped}"\`.`;
	}

	return null;
}
