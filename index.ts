import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { InteractiveShellOverlay } from "./overlay-component.js";
import { ReattachOverlay } from "./reattach-overlay.js";
import { PtyTerminalSession } from "./pty-session.js";
import type { InteractiveShellResult, HandsFreeUpdate } from "./types.js";
import { sessionManager, generateSessionId } from "./session-manager.js";
import { loadConfig } from "./config.js";
import type { InteractiveShellConfig } from "./config.js";
import { translateInput } from "./key-encoding.js";
import { TOOL_NAME, TOOL_LABEL, TOOL_DESCRIPTION, toolParameters, type ToolParams } from "./tool-schema.js";
import { formatDuration, formatDurationMs } from "./types.js";
import { HeadlessDispatchMonitor } from "./headless-monitor.js";
import type { HeadlessCompletionInfo } from "./headless-monitor.js";
import { setupBackgroundWidget } from "./background-widget.js";
import { buildDispatchNotification, buildHandsFreeUpdateMessage, buildResultNotification, summarizeInteractiveResult } from "./notification-utils.js";
import { createSessionQueryState, getSessionOutput } from "./session-query.js";
import { InteractiveShellCoordinator } from "./runtime-coordinator.js";

const coordinator = new InteractiveShellCoordinator();

function makeMonitorCompletionCallback(
	pi: ExtensionAPI,
	id: string,
	startTime: number,
): (info: HeadlessCompletionInfo) => void {
	return (info) => {
		const wasAgentHandled = coordinator.consumeAgentHandledCompletion(id);
		if (!wasAgentHandled) {
			const duration = formatDuration(Date.now() - startTime);
			const content = buildDispatchNotification(id, info, duration);
			pi.sendMessage({
				customType: "interactive-shell-transfer",
				content,
				display: true,
				details: { sessionId: id, duration, ...info },
			}, { triggerTurn: true });
			pi.events.emit("interactive-shell:transfer", { sessionId: id, ...info });
		}
		sessionManager.unregisterActive(id, false);
		coordinator.deleteMonitor(id);
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
	config: InteractiveShellConfig,
): void {
	const queryState = createSessionQueryState();
	coordinator.setMonitor(id, monitor);
	const getCompletionOutput = () => monitor.getResult()?.completionOutput;

	sessionManager.registerActive({
		id,
		command,
		reason,
		write: (data) => session.write(data),
		kill: () => {
			coordinator.disposeMonitor(id);
			sessionManager.remove(id);
			sessionManager.unregisterActive(id, true);
		},
		background: () => {},
		getOutput: (opts) => getSessionOutput(session, config, queryState, opts, getCompletionOutput()),
		getStatus: () => session.exited ? "exited" : "running",
		getRuntime: () => Date.now() - startTime,
		getResult: () => monitor.getResult(),
		onComplete: (cb) => monitor.registerCompleteCallback(cb),
	});
}

function makeNonBlockingUpdateHandler(pi: ExtensionAPI): (update: HandsFreeUpdate) => void {
	return (update) => {
		pi.events.emit("interactive-shell:update", update);
		const message = buildHandsFreeUpdateMessage(update);
		if (!message) return;
		pi.sendMessage({
			customType: "interactive-shell-update",
			content: message.content,
			display: true,
			details: message.details,
		}, { triggerTurn: true });
	};
}

function emitTransferredOutput(
	pi: ExtensionAPI,
	result: InteractiveShellResult,
	fallbackSessionId?: string,
): void {
	if (!result.transferred) return;
	const sessionId = result.sessionId ?? fallbackSessionId;
	const truncatedNote = result.transferred.truncated
		? ` (truncated from ${result.transferred.totalLines} total lines)`
		: "";
	const prefix = sessionId
		? `Session ${sessionId} output transferred`
		: "Interactive shell output transferred";
	const content = `${prefix} (${result.transferred.lines.length} lines${truncatedNote}):\n\n${result.transferred.lines.join("\n")}`;
	pi.sendMessage({
		customType: "interactive-shell-transfer",
		content,
		display: true,
		details: {
			sessionId,
			transferred: result.transferred,
			exitCode: result.exitCode,
			signal: result.signal,
		},
	}, { triggerTurn: true });
	pi.events.emit("interactive-shell:transfer", {
		sessionId,
		transferred: result.transferred,
		exitCode: result.exitCode,
		signal: result.signal,
	});
}

type SpawnMode = "fresh" | "fork";

const SPAWN_SHORTCUT = "alt+shift+p";

function parseSpawnMode(args: string): SpawnMode | undefined {
	const normalized = args.trim().toLowerCase();
	switch (normalized) {
		case "":
		case "fresh":
		case "new":
			return "fresh";
		case "fork":
			return "fork";
		default:
			return undefined;
	}
}

function shellQuote(value: string): string {
	if (process.platform === "win32") {
		return `"${value.replace(/"/g, '""')}"`;
	}
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildSpawnPiCommand(mode: SpawnMode, getSessionFile: () => string | undefined):
	| { ok: true; command: string; reason: string }
	| { ok: false; error: string } {
	if (mode === "fork") {
		const sourceSessionFile = getSessionFile();
		if (!sourceSessionFile) {
			return { ok: false, error: "Cannot fork the current session because it is not persisted (likely --no-session mode)." };
		}
		return {
			ok: true,
			command: `pi --fork ${shellQuote(sourceSessionFile)}`,
			reason: "spawn pi (fork current session)",
		};
	}

	return {
		ok: true,
		command: "pi",
		reason: "spawn pi (fresh session)",
	};
}

export default function interactiveShellExtension(pi: ExtensionAPI) {
	const startupConfig = loadConfig(process.cwd());
	const loadRuntimeConfig = (cwd: string): InteractiveShellConfig => ({
		...loadConfig(cwd),
		focusShortcut: startupConfig.focusShortcut,
	});
	const disposeStaleMonitor = (id: string, monitor: HeadlessDispatchMonitor | undefined): void => {
		if (!monitor || monitor.disposed) return;
		coordinator.disposeMonitor(id);
		sessionManager.unregisterActive(id, false);
	};
	const createOverlayUiOptions = (config: InteractiveShellConfig) => ({
		overlay: true,
		overlayOptions: {
			width: `${config.overlayWidthPercent}%`,
			maxHeight: `${config.overlayHeightPercent}%`,
			anchor: "center",
			margin: 1,
			nonCapturing: true,
		},
		onHandle: (handle) => {
			coordinator.setOverlayHandle(handle);
			handle.focus();
		},
	});
	const spawnPiOverlay = async (ctx: ExtensionContext, mode: SpawnMode): Promise<void> => {
		if (coordinator.isOverlayOpen()) {
			ctx.ui.notify("An overlay is already open. Close it first.", "error");
			return;
		}

		const spawn = buildSpawnPiCommand(mode, () => ctx.sessionManager.getSessionFile());
		if (!spawn.ok) {
			ctx.ui.notify(spawn.error, "error");
			return;
		}

		const config = loadRuntimeConfig(ctx.cwd);
		if (!coordinator.beginOverlay()) {
			ctx.ui.notify("An overlay is already open. Close it first.", "error");
			return;
		}
		try {
			const result = await ctx.ui.custom<InteractiveShellResult>(
				(tui, theme, _kb, done) =>
					new InteractiveShellOverlay(tui, theme, {
						command: spawn.command,
						cwd: ctx.cwd,
						reason: spawn.reason,
						onUnfocus: () => coordinator.unfocusOverlay(),
					}, config, done),
				createOverlayUiOptions(config),
			);
			emitTransferredOutput(pi, result);
		} finally {
			coordinator.endOverlay();
		}
	};
	pi.registerShortcut(startupConfig.focusShortcut, {
		description: "Focus interactive shell overlay",
		handler: () => {
			coordinator.focusOverlay();
		},
	});
	pi.registerShortcut(SPAWN_SHORTCUT, {
		description: "Spawn pi in a fresh interactive shell overlay",
		handler: (ctx) => spawnPiOverlay(ctx, "fresh"),
	});

	pi.on("session_start", (_event, ctx) => {
		coordinator.replaceBackgroundWidgetCleanup(setupBackgroundWidget(ctx, sessionManager));
	});

	pi.on("session_shutdown", () => {
		coordinator.clearBackgroundWidget();
		sessionManager.killAll();
		coordinator.disposeAllMonitors();
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
					const alreadyCompleted = Boolean(session.getResult());
					if (!alreadyCompleted) {
						coordinator.markAgentHandledCompletion(sessionId);
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
					const bMonitor = coordinator.getMonitor(sessionId);
					if (!bMonitor || bMonitor.disposed) {
						coordinator.markAgentHandledCompletion(sessionId);
					}
					session.background();
					const result = session.getResult();
					if (!result || !result.backgrounded) {
						coordinator.consumeAgentHandledCompletion(sessionId);
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
				if (coordinator.isOverlayOpen()) {
					return {
						content: [{ type: "text", text: "An interactive shell overlay is already open." }],
						isError: true,
						details: { error: "overlay_already_open" },
					};
				}

				const monitor = coordinator.getMonitor(attach);
				const bgSession = sessionManager.take(attach);
				if (!bgSession) {
					disposeStaleMonitor(attach, monitor);
					return {
						content: [{ type: "text", text: `Background session not found: ${attach}` }],
						isError: true,
					};
				}

				const restoreAttachSession = () => {
					bgSession.session.setEventHandlers({});
					sessionManager.restore(bgSession, { noAutoCleanup: Boolean(monitor && !monitor.disposed) });
					return {
						releaseId: false,
						disposeMonitor: false,
					};
				};
				if (!coordinator.beginOverlay()) {
					restoreAttachSession();
					return {
						content: [{ type: "text", text: "An interactive shell overlay is already open." }],
						isError: true,
						details: { error: "overlay_already_open" },
					};
				}

				const config = loadRuntimeConfig(cwd ?? ctx.cwd);
				const reattachSessionId = attach;
				const isNonBlocking = mode === "hands-free" || mode === "dispatch";
				const attachStartTime = bgSession.startedAt.getTime();
				let overlayPromise: Promise<InteractiveShellResult>;
				try {
					overlayPromise = ctx.ui.custom<InteractiveShellResult>(
						(tui, theme, _kb, done) =>
							new InteractiveShellOverlay(tui, theme, {
								command: bgSession.command,
								existingSession: bgSession.session,
								sessionId: reattachSessionId,
								mode,
								cwd: cwd ?? ctx.cwd,
								name: bgSession.name,
								reason: bgSession.reason ?? reason,
								startedAt: attachStartTime,
								handsFreeUpdateMode: handsFree?.updateMode,
								handsFreeUpdateInterval: handsFree?.updateInterval,
								handsFreeQuietThreshold: handsFree?.quietThreshold,
								handsFreeUpdateMaxChars: handsFree?.updateMaxChars,
								handsFreeMaxTotalChars: handsFree?.maxTotalChars,
								autoExitOnQuiet: mode === "dispatch"
									? handsFree?.autoExitOnQuiet !== false
									: handsFree?.autoExitOnQuiet === true,
								autoExitGracePeriod: handsFree?.gracePeriod ?? config.autoExitGracePeriod,
								onUnfocus: () => coordinator.unfocusOverlay(),
								onHandsFreeUpdate: mode === "hands-free"
									? makeNonBlockingUpdateHandler(pi)
									: undefined,
								handoffPreviewEnabled: handoffPreview?.enabled,
								handoffPreviewLines: handoffPreview?.lines,
								handoffPreviewMaxChars: handoffPreview?.maxChars,
								handoffSnapshotEnabled: handoffSnapshot?.enabled,
								handoffSnapshotLines: handoffSnapshot?.lines,
								handoffSnapshotMaxChars: handoffSnapshot?.maxChars,
								timeout,
							}, config, done),
						createOverlayUiOptions(config),
					);
				} catch (error) {
					coordinator.endOverlay();
					restoreAttachSession();
					throw error;
				}

				if (isNonBlocking) {
					setupDispatchCompletion(pi, overlayPromise, config, {
						id: reattachSessionId,
						mode: mode!,
						command: bgSession.command,
						reason: bgSession.reason,
						timeout,
						handsFree,
						overlayStartTime: attachStartTime,
						onOverlayError: restoreAttachSession,
					});
					return {
						content: [{ type: "text", text: mode === "dispatch"
							? `Reattached to ${reattachSessionId}. You'll be notified when it completes.`
							: `Reattached to ${reattachSessionId}.\nUse interactive_shell({ sessionId: "${reattachSessionId}" }) to check status/output.` }],
						details: { sessionId: reattachSessionId, status: "running", command: bgSession.command, reason: bgSession.reason, mode },
					};
				}

				let result: InteractiveShellResult;
				try {
					result = await overlayPromise;
				} catch (error) {
					restoreAttachSession();
					throw error;
				} finally {
					coordinator.endOverlay();
				}
				if (monitor && !monitor.disposed) {
					if (!result.backgrounded) {
						monitor.handleExternalCompletion(result.exitCode, result.signal, result.completionOutput);
						coordinator.deleteMonitor(attach);
					} else {
						const monitoredId = result.backgroundId ?? attach;
						const monitoredSession = sessionManager.take(monitoredId);
						if (monitoredSession) {
							sessionManager.restore(monitoredSession, { noAutoCleanup: true });
						}
					}
				} else if (result.backgrounded) {
					sessionManager.restartAutoCleanup(attach);
				} else {
					sessionManager.scheduleCleanup(attach);
				}

				return { content: [{ type: "text", text: summarizeInteractiveResult(command ?? bgSession.command, result, timeout, bgSession.reason ?? reason) }], details: result };
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
					coordinator.disposeMonitor(tid);
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
			const config = loadRuntimeConfig(effectiveCwd);
			const isNonBlocking = mode === "hands-free" || mode === "dispatch";

			// ── Branch 4a: Headless dispatch ──
			if (mode === "dispatch" && background) {
				const id = generateSessionId(name);
				const session = new PtyTerminalSession(
					{ command, cwd: effectiveCwd, cols: 120, rows: 40, scrollback: config.scrollbackLines },
				);

				const startTime = Date.now();
				sessionManager.add(command, session, name, reason, { id, noAutoCleanup: true, startedAt: new Date(startTime) });

				const monitor = new HeadlessDispatchMonitor(session, config, {
					autoExitOnQuiet: handsFree?.autoExitOnQuiet !== false,
					quietThreshold: handsFree?.quietThreshold ?? config.handsFreeQuietThreshold,
					gracePeriod: handsFree?.gracePeriod ?? config.autoExitGracePeriod,
					timeout,
					startedAt: startTime,
				}, makeMonitorCompletionCallback(pi, id, startTime));
				registerHeadlessActive(id, command, reason, session, monitor, startTime, config);

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

			if (coordinator.isOverlayOpen()) {
				return {
					content: [{ type: "text", text: "An interactive shell overlay is already open. Wait for it to close or kill the active session before starting a new one." }],
					isError: true,
					details: { error: "overlay_already_open" },
				};
			}

			const generatedSessionId = isNonBlocking ? generateSessionId(name) : undefined;

			// ── Non-blocking path (hands-free or dispatch) ──
			if (isNonBlocking && generatedSessionId) {
				if (!coordinator.beginOverlay()) {
					return {
						content: [{ type: "text", text: "An interactive shell overlay is already open. Wait for it to close or kill the active session before starting a new one." }],
						isError: true,
						details: { error: "overlay_already_open" },
					};
				}
				const overlayStartTime = Date.now();

				let overlayPromise: Promise<InteractiveShellResult>;
				try {
					overlayPromise = ctx.ui.custom<InteractiveShellResult>(
						(tui, theme, _kb, done) =>
							new InteractiveShellOverlay(tui, theme, {
								command,
								cwd: effectiveCwd,
								name,
								reason,
								mode,
								sessionId: generatedSessionId,
								startedAt: overlayStartTime,
								handsFreeUpdateMode: handsFree?.updateMode,
								handsFreeUpdateInterval: handsFree?.updateInterval,
								handsFreeQuietThreshold: handsFree?.quietThreshold,
								handsFreeUpdateMaxChars: handsFree?.updateMaxChars,
								handsFreeMaxTotalChars: handsFree?.maxTotalChars,
								autoExitOnQuiet: mode === "dispatch"
									? handsFree?.autoExitOnQuiet !== false
									: handsFree?.autoExitOnQuiet === true,
								autoExitGracePeriod: handsFree?.gracePeriod ?? config.autoExitGracePeriod,
								onUnfocus: () => coordinator.unfocusOverlay(),
								onHandsFreeUpdate: mode === "hands-free"
									? makeNonBlockingUpdateHandler(pi)
									: undefined,
								handoffPreviewEnabled: handoffPreview?.enabled,
								handoffPreviewLines: handoffPreview?.lines,
								handoffPreviewMaxChars: handoffPreview?.maxChars,
								handoffSnapshotEnabled: handoffSnapshot?.enabled,
								handoffSnapshotLines: handoffSnapshot?.lines,
								handoffSnapshotMaxChars: handoffSnapshot?.maxChars,
								timeout,
							}, config, done),
						createOverlayUiOptions(config),
					);
				} catch (error) {
					coordinator.endOverlay();
					throw error;
				}

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
			if (!coordinator.beginOverlay()) {
				return {
					content: [{ type: "text", text: "An interactive shell overlay is already open. Wait for it to close or kill the active session before starting a new one." }],
					isError: true,
					details: { error: "overlay_already_open" },
				};
			}
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
							autoExitGracePeriod: handsFree?.gracePeriod ?? config.autoExitGracePeriod,
							onUnfocus: () => coordinator.unfocusOverlay(),
							streamingMode: mode === "hands-free",
							onHandsFreeUpdate: mode === "hands-free"
								? (update) => {
									let statusText: string;
									switch (update.status) {
										case "user-takeover":
											statusText = `User took over session ${update.sessionId}`;
											break;
										case "agent-resumed":
											statusText = `Agent resumed monitoring session ${update.sessionId}`;
											break;
										case "exited":
											statusText = `Session ${update.sessionId} exited`;
											break;
										case "killed":
											statusText = `Session ${update.sessionId} killed`;
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
									pi.events.emit("interactive-shell:update", update);
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
					createOverlayUiOptions(config),
				);
			} finally {
				coordinator.endOverlay();
			}

			return { content: [{ type: "text", text: summarizeInteractiveResult(command, result, timeout, reason) }], details: result };
		},
	});

	pi.registerCommand("spawn", {
		description: "Spawn pi in an interactive shell overlay (/spawn [fresh|fork])",
		handler: async (args, ctx) => {
			const mode = parseSpawnMode(args);
			if (!mode) {
				ctx.ui.notify("Usage: /spawn [fresh|fork]", "error");
				return;
			}
			await spawnPiOverlay(ctx, mode);
		},
	});

	pi.registerCommand("attach", {
		description: "Reattach to a background shell session",
		handler: async (args, ctx) => {
			if (coordinator.isOverlayOpen()) {
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
					return {
						id: s.id,
						label: `${s.id} - ${sanitizedCommand}${r} (${status}, ${duration})`,
					};
				});
				const choice = await ctx.ui.select("Background Sessions", options.map((o) => o.label));
				if (!choice) return;
				targetId = options.find((o) => o.label === choice)!.id;
			}

			const monitor = coordinator.getMonitor(targetId);
			if (!coordinator.beginOverlay()) {
				ctx.ui.notify("An overlay is already open. Close it first.", "error");
				return;
			}

			const session = sessionManager.get(targetId);
			if (!session) {
				disposeStaleMonitor(targetId, monitor);
				coordinator.endOverlay();
				ctx.ui.notify(`Session not found: ${targetId}`, "error");
				return;
			}

			const restoreBackgroundLifecycle = () => {
				session.session.setEventHandlers({});
				if (monitor && !monitor.disposed) {
					return;
				}
				if (session.session.exited) {
					sessionManager.scheduleCleanup(targetId);
					return;
				}
				sessionManager.restartAutoCleanup(targetId);
			};

			const config = loadRuntimeConfig(ctx.cwd);
			try {
				const result = await ctx.ui.custom<InteractiveShellResult>(
					(tui, theme, _kb, done) =>
						new ReattachOverlay(
							tui,
							theme,
							{ id: session.id, command: session.command, reason: session.reason, session: session.session },
							config,
							done,
							() => coordinator.unfocusOverlay(),
						),
					createOverlayUiOptions(config),
				);

				emitTransferredOutput(pi, result, targetId);

				if (monitor && !monitor.disposed) {
					if (!result.backgrounded) {
						if (result.transferred) {
							coordinator.markAgentHandledCompletion(targetId);
						}
						monitor.handleExternalCompletion(result.exitCode, result.signal, result.completionOutput);
						coordinator.deleteMonitor(targetId);
					}
				} else if (result.backgrounded) {
					sessionManager.restartAutoCleanup(targetId);
				} else {
					sessionManager.scheduleCleanup(targetId);
				}
			} catch (error) {
				restoreBackgroundLifecycle();
				throw error;
			} finally {
				coordinator.endOverlay();
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
				const options = [
					{ label: "All sessions" },
					...sessions.map((s) => {
						const status = s.session.exited ? "exited" : "running";
						const duration = formatDuration(Date.now() - s.startedAt.getTime());
						return { id: s.id, label: `${s.id} (${status}, ${duration})` };
					}),
				];
				const choice = await ctx.ui.select("Dismiss sessions", options.map((o) => o.label));
				if (!choice) return;
				const selected = options.find((o) => o.label === choice);
				targetIds = selected?.id ? [selected.id] : sessions.map((s) => s.id);
			}

			for (const tid of targetIds) {
				coordinator.disposeMonitor(tid);
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
		handsFree?: { autoExitOnQuiet?: boolean; quietThreshold?: number; gracePeriod?: number };
		overlayStartTime?: number;
		onOverlayError?: () => { releaseId?: boolean; disposeMonitor?: boolean } | void;
	},
): void {
	const { id, mode, command, reason } = ctx;

	overlayPromise.then((result) => {
		coordinator.endOverlay();

		const wasAgentInitiated = coordinator.consumeAgentHandledCompletion(id);

		if (result.transferred) {
			emitTransferredOutput(pi, result, id);
			sessionManager.unregisterActive(id, true);
			coordinator.disposeMonitor(id);
			return;
		}

		if (mode === "dispatch" && result.backgrounded) {
			if (!wasAgentInitiated) {
				pi.sendMessage({
					customType: "interactive-shell-transfer",
					content: `Session ${id} moved to background (id: ${result.backgroundId}).`,
					display: true,
					details: { sessionId: id, backgroundId: result.backgroundId },
				}, { triggerTurn: true });
			}
			sessionManager.unregisterActive(id, false);

			const bgId = result.backgroundId!;
			const existingMonitor = coordinator.getMonitor(id);
			const bgSession = sessionManager.get(bgId);
			if (!bgSession) return;

			if (existingMonitor && !existingMonitor.disposed) {
				coordinator.deleteMonitor(id);
				registerHeadlessActive(bgId, command, reason, bgSession.session, existingMonitor, bgSession.startedAt.getTime(), config);
				return;
			}

			const elapsed = ctx.overlayStartTime ? Date.now() - ctx.overlayStartTime : 0;
			const remainingTimeout = ctx.timeout ? Math.max(0, ctx.timeout - elapsed) : undefined;
			const bgStartTime = bgSession.startedAt.getTime();
			const monitor = new HeadlessDispatchMonitor(bgSession.session, config, {
				autoExitOnQuiet: ctx.handsFree?.autoExitOnQuiet !== false,
				quietThreshold: ctx.handsFree?.quietThreshold ?? config.handsFreeQuietThreshold,
				gracePeriod: ctx.handsFree?.gracePeriod ?? config.autoExitGracePeriod,
				timeout: remainingTimeout,
				startedAt: bgStartTime,
			}, makeMonitorCompletionCallback(pi, bgId, bgStartTime));
			registerHeadlessActive(bgId, command, reason, bgSession.session, monitor, bgStartTime, config);
			return;
		}

		if (mode === "dispatch") {
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
			coordinator.disposeMonitor(id);
			return;
		}

		coordinator.disposeMonitor(id);
	}).catch((error) => {
		console.error(`interactive-shell: overlay error for session ${id}:`, error);
		coordinator.endOverlay();
		const recovery = ctx.onOverlayError?.();
		sessionManager.unregisterActive(id, recovery?.releaseId ?? true);
		if (recovery?.disposeMonitor !== false) {
			coordinator.disposeMonitor(id);
		}
	});
}
