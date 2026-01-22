import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { InteractiveShellOverlay } from "./overlay-component.js";
import { ReattachOverlay } from "./reattach-overlay.js";
import type { InteractiveShellResult } from "./types.js";
import { sessionManager, generateSessionId } from "./session-manager.js";
import { loadConfig } from "./config.js";
import { translateInput } from "./key-encoding.js";
import { TOOL_NAME, TOOL_LABEL, TOOL_DESCRIPTION, toolParameters, type ToolParams } from "./tool-schema.js";
import { formatDuration, formatDurationMs } from "./types.js";

export default function interactiveShellExtension(pi: ExtensionAPI) {
	pi.on("session_shutdown", () => {
		sessionManager.killAll();
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: TOOL_LABEL,
		description: TOOL_DESCRIPTION,
		parameters: toolParameters,

		async execute(_toolCallId, params, onUpdate, ctx) {
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
				cwd,
				name,
				reason,
				mode,
				handsFree,
				handoffPreview,
				handoffSnapshot,
				timeout,
			} = params as ToolParams;

			// Mode 1: Interact with existing session (query status, send input, kill, or change settings)
			if (sessionId) {
				const session = sessionManager.getActive(sessionId);
				if (!session) {
					return {
						content: [{ type: "text", text: `Session not found or no longer active: ${sessionId}` }],
						isError: true,
						details: { sessionId, error: "session_not_found" },
					};
				}

				// Kill session if requested
				if (kill) {
					const { output, truncated, totalBytes, totalLines, hasMore } = session.getOutput({ skipRateLimit: true, lines: outputLines, maxChars: outputMaxChars, offset: outputOffset, drain, incremental });
					const status = session.getStatus();
					const runtime = session.getRuntime();
					session.kill();
					sessionManager.unregisterActive(sessionId, true);

					const truncatedNote = truncated ? ` (${totalBytes} bytes total, truncated)` : "";
					const hasMoreNote = hasMore === true ? " (more available)" : "";
					return {
						content: [
							{
								type: "text",
								text: `Session ${sessionId} killed after ${formatDurationMs(runtime)}${output ? `\n\nFinal output${truncatedNote}${hasMoreNote}:\n${output}` : ""}`,
							},
						],
						details: {
							sessionId,
							status: "killed",
							runtime,
							output,
							outputTruncated: truncated,
							outputTotalBytes: totalBytes,
							outputTotalLines: totalLines,
							hasMore,
							previousStatus: status,
						},
					};
				}

				const actions: string[] = [];

				// Apply settings changes
				if (settings?.updateInterval !== undefined) {
					const changed = sessionManager.setActiveUpdateInterval(sessionId, settings.updateInterval);
					if (changed) {
						actions.push(`update interval set to ${settings.updateInterval}ms`);
					}
				}
				if (settings?.quietThreshold !== undefined) {
					const changed = sessionManager.setActiveQuietThreshold(sessionId, settings.quietThreshold);
					if (changed) {
						actions.push(`quiet threshold set to ${settings.quietThreshold}ms`);
					}
				}

				// Send input if provided
				if (input !== undefined) {
					const translatedInput = translateInput(input);
					const success = sessionManager.writeToActive(sessionId, translatedInput);

					if (!success) {
						return {
							content: [{ type: "text", text: `Failed to send input to session: ${sessionId}` }],
							isError: true,
							details: { sessionId, error: "write_failed" },
						};
					}

					const inputDesc =
						typeof input === "string"
							? input.length === 0
								? "(empty)"
								: input.length > 50
									? `${input.slice(0, 50)}...`
									: input
							: [
									input.text ?? "",
									input.keys ? `keys:[${input.keys.join(",")}]` : "",
									input.hex ? `hex:[${input.hex.length} bytes]` : "",
									input.paste ? `paste:[${input.paste.length} chars]` : "",
								]
									.filter(Boolean)
									.join(" + ") || "(empty)";

					actions.push(`sent: ${inputDesc}`);
				}

				// If only querying status (no input, no settings, no kill)
				if (actions.length === 0) {
					const status = session.getStatus();
					const runtime = session.getRuntime();
					const result = session.getResult();

					// If session completed, always allow query (no rate limiting)
					// Rate limiting only applies to "checking in" on running sessions
					if (result) {
						const { output, truncated, totalBytes, totalLines, hasMore } = session.getOutput({ skipRateLimit: true, lines: outputLines, maxChars: outputMaxChars, offset: outputOffset, drain, incremental });
						const truncatedNote = truncated ? ` (${totalBytes} bytes total, truncated)` : "";
						const hasOutput = output.length > 0;
						const hasMoreNote = hasMore === true ? " (more available)" : "";

						sessionManager.unregisterActive(sessionId, true);
						return {
							content: [
								{
									type: "text",
									text: `Session ${sessionId} ${status} after ${formatDurationMs(runtime)}${hasOutput ? `\n\nOutput${truncatedNote}${hasMoreNote}:\n${output}` : ""}`,
								},
							],
							details: {
								sessionId,
								status,
								runtime,
								output,
								outputTruncated: truncated,
								outputTotalBytes: totalBytes,
								outputTotalLines: totalLines,
								hasMore,
								exitCode: result.exitCode,
								signal: result.signal,
								backgroundId: result.backgroundId,
							},
						};
					}

					// Session still running - check rate limiting
					const outputResult = session.getOutput({ lines: outputLines, maxChars: outputMaxChars, offset: outputOffset, drain, incremental });

					// If rate limited, wait until allowed then return fresh result
					// Use Promise.race to detect if session completes during wait
					if (outputResult.rateLimited && outputResult.waitSeconds) {
						const waitMs = outputResult.waitSeconds * 1000;
						
						// Race: rate limit timeout vs session completion
						const completedEarly = await Promise.race([
							new Promise<false>((resolve) => setTimeout(() => resolve(false), waitMs)),
							new Promise<true>((resolve) => session.onComplete(() => resolve(true))),
						]);
						
						// If session completed during wait, return result immediately
						if (completedEarly) {
							const earlySession = sessionManager.getActive(sessionId);
							if (!earlySession) {
								return {
									content: [{ type: "text", text: `Session ${sessionId} ended` }],
									details: { sessionId, status: "ended" },
								};
							}
							const earlyResult = earlySession.getResult();
							const { output, truncated, totalBytes, totalLines, hasMore } = earlySession.getOutput({ skipRateLimit: true, lines: outputLines, maxChars: outputMaxChars, offset: outputOffset, drain, incremental });
							const earlyStatus = earlySession.getStatus();
							const earlyRuntime = earlySession.getRuntime();
							const truncatedNote = truncated ? ` (${totalBytes} bytes total, truncated)` : "";
							const hasOutput = output.length > 0;
							const hasMoreNote = hasMore === true ? " (more available)" : "";
							
							if (earlyResult) {
								sessionManager.unregisterActive(sessionId, true);
								return {
									content: [
										{
											type: "text",
											text: `Session ${sessionId} ${earlyStatus} after ${formatDurationMs(earlyRuntime)}${hasOutput ? `\n\nOutput${truncatedNote}${hasMoreNote}:\n${output}` : ""}`,
										},
									],
									details: {
										sessionId,
										status: earlyStatus,
										runtime: earlyRuntime,
										output,
										outputTruncated: truncated,
										outputTotalBytes: totalBytes,
										outputTotalLines: totalLines,
										hasMore,
										exitCode: earlyResult.exitCode,
										signal: earlyResult.signal,
										backgroundId: earlyResult.backgroundId,
									},
								};
							}
							// Edge case: onComplete fired but no result yet (shouldn't happen)
							// Return current status without unregistering
							return {
								content: [
									{
										type: "text",
										text: `Session ${sessionId} ${earlyStatus} (${formatDurationMs(earlyRuntime)})${hasOutput ? `\n\nOutput${truncatedNote}${hasMoreNote}:\n${output}` : ""}`,
									},
								],
								details: {
									sessionId,
									status: earlyStatus,
									runtime: earlyRuntime,
									output,
									outputTruncated: truncated,
									outputTotalBytes: totalBytes,
									outputTotalLines: totalLines,
									hasMore,
									hasOutput,
								},
							};
						}
						// Get fresh output after waiting
						const freshOutput = session.getOutput({ lines: outputLines, maxChars: outputMaxChars, offset: outputOffset, drain, incremental });
						const truncatedNote = freshOutput.truncated ? ` (${freshOutput.totalBytes} bytes total, truncated)` : "";
						const hasOutput = freshOutput.output.length > 0;
						const hasMoreNote = freshOutput.hasMore === true ? " (more available)" : "";
						const freshStatus = session.getStatus();
						const freshRuntime = session.getRuntime();
						const freshResult = session.getResult();

						if (freshResult) {
							sessionManager.unregisterActive(sessionId, true);
							return {
								content: [
									{
										type: "text",
										text: `Session ${sessionId} ${freshStatus} after ${formatDurationMs(freshRuntime)}${hasOutput ? `\n\nOutput${truncatedNote}${hasMoreNote}:\n${freshOutput.output}` : ""}`,
									},
								],
								details: {
									sessionId,
									status: freshStatus,
									runtime: freshRuntime,
									output: freshOutput.output,
									outputTruncated: freshOutput.truncated,
									outputTotalBytes: freshOutput.totalBytes,
									outputTotalLines: freshOutput.totalLines,
									hasMore: freshOutput.hasMore,
									exitCode: freshResult.exitCode,
									signal: freshResult.signal,
									backgroundId: freshResult.backgroundId,
								},
							};
						}

						return {
							content: [
								{
									type: "text",
									text: `Session ${sessionId} ${freshStatus} (${formatDurationMs(freshRuntime)})${hasOutput ? `\n\nOutput${truncatedNote}${hasMoreNote}:\n${freshOutput.output}` : ""}`,
								},
							],
							details: {
								sessionId,
								status: freshStatus,
								runtime: freshRuntime,
								output: freshOutput.output,
								outputTruncated: freshOutput.truncated,
								outputTotalBytes: freshOutput.totalBytes,
								outputTotalLines: freshOutput.totalLines,
								hasMore: freshOutput.hasMore,
								hasOutput,
							},
						};
					}

					const { output, truncated, totalBytes, totalLines, hasMore } = outputResult;

					const truncatedNote = truncated ? ` (${totalBytes} bytes total, truncated)` : "";
					const hasOutput = output.length > 0;
					// Only show "(more available)" when there's more to read; absence means caught up
					const hasMoreNote = hasMore === true ? " (more available)" : "";

					return {
						content: [
							{
								type: "text",
								text: `Session ${sessionId} ${status} (${formatDurationMs(runtime)})${hasOutput ? `\n\nOutput${truncatedNote}${hasMoreNote}:\n${output}` : ""}`,
							},
						],
						details: {
							sessionId,
							status,
							runtime,
							output,
							outputTruncated: truncated,
							outputTotalBytes: totalBytes,
							outputTotalLines: totalLines,
							hasMore,
							hasOutput,
						},
					};
				}

				return {
					content: [{ type: "text", text: `Session ${sessionId}: ${actions.join(", ")}` }],
					details: { sessionId, actions },
				};
			}

			// Mode 2: Start new session (requires command)
			if (!command) {
				return {
					content: [
						{
							type: "text",
							text: "Either 'command' (to start a session) or 'sessionId' (to query/interact with existing session) is required",
						},
					],
					isError: true,
					details: {},
				};
			}

			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "Interactive shell requires interactive TUI mode" }],
					isError: true,
					details: {},
				};
			}

			const effectiveCwd = cwd ?? ctx.cwd;
			const config = loadConfig(effectiveCwd);
			const isHandsFree = mode === "hands-free";

			// Generate sessionId early so it's available immediately
			const generatedSessionId = isHandsFree ? generateSessionId(name) : undefined;

			// For hands-free mode: non-blocking - return immediately with sessionId
			// Agent can then query status/output via sessionId and kill when done
			if (isHandsFree && generatedSessionId) {
				// Start overlay but don't await - it runs in background
				const overlayPromise = ctx.ui.custom<InteractiveShellResult>(
					(tui, theme, _kb, done) =>
						new InteractiveShellOverlay(
							tui,
							theme,
							{
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
								// Default autoExitOnQuiet to false - agent must opt-in for fire-and-forget tasks
								autoExitOnQuiet: handsFree?.autoExitOnQuiet === true,
								// No onHandsFreeUpdate in non-blocking mode - agent queries directly
								handoffPreviewEnabled: handoffPreview?.enabled,
								handoffPreviewLines: handoffPreview?.lines,
								handoffPreviewMaxChars: handoffPreview?.maxChars,
								handoffSnapshotEnabled: handoffSnapshot?.enabled,
								handoffSnapshotLines: handoffSnapshot?.lines,
								handoffSnapshotMaxChars: handoffSnapshot?.maxChars,
								timeout,
							},
							config,
							done,
						),
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

				// Handle overlay completion in background (cleanup when user closes)
				overlayPromise.then((result) => {
					// Session already handles cleanup via finishWith* methods
					// This just ensures the promise doesn't cause unhandled rejection
					if (result.userTookOver) {
						// User took over - session continues interactively
					}
				}).catch(() => {
					// Ignore errors - session cleanup handles this
				});

				// Return immediately - agent can query via sessionId
				return {
					content: [
						{
							type: "text",
							text: `Session started: ${generatedSessionId}\nCommand: ${command}\n\nUse interactive_shell({ sessionId: "${generatedSessionId}" }) to check status/output.\nUse interactive_shell({ sessionId: "${generatedSessionId}", kill: true }) to end when done.`,
						},
					],
					details: {
						sessionId: generatedSessionId,
						status: "running",
						command,
						reason,
					},
				};
			}

			// Interactive mode: blocking - wait for overlay to close
			onUpdate?.({
				content: [{ type: "text", text: `Opening: ${command}` }],
				details: {
					exitCode: null,
					backgrounded: false,
					cancelled: false,
				},
			});

			const result = await ctx.ui.custom<InteractiveShellResult>(
				(tui, theme, _kb, done) =>
					new InteractiveShellOverlay(
						tui,
						theme,
						{
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
							onHandsFreeUpdate: isHandsFree
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
												const budgetInfo = update.budgetExhausted
													? " [budget exhausted]"
													: "";
												statusText = `Session ${update.sessionId} running (${formatDurationMs(update.runtime)})${budgetInfo}`;
											}
										}
										// Only include new output if there is any
										const newOutput =
											update.status === "running" && update.tail.length > 0
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
						},
						config,
						done,
					),
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

			let summary: string;
			if (result.backgrounded) {
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

			if (result.handoffPreview?.type === "tail" && result.handoffPreview.lines.length > 0) {
				const tailHeader = `\n\nOverlay tail (${result.handoffPreview.when}, last ${result.handoffPreview.lines.length} lines):\n`;
				summary += tailHeader + result.handoffPreview.lines.join("\n");
			}

			return {
				content: [{ type: "text", text: summary }],
				details: result,
			};
		},
	});

	pi.registerCommand("attach", {
		description: "Reattach to a background shell session",
		handler: async (args, ctx) => {
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
					// Sanitize command and reason: collapse newlines and whitespace for display
					const sanitizedCommand = s.command.replace(/\s+/g, " ").trim();
					const sanitizedReason = s.reason?.replace(/\s+/g, " ").trim();
					const reason = sanitizedReason ? ` • ${sanitizedReason}` : "";
					return `${s.id} - ${sanitizedCommand}${reason} (${status}, ${duration})`;
				});

				const choice = await ctx.ui.select("Background Sessions", options);
				if (!choice) return;
				targetId = choice.split(" - ")[0]!;
			}

			const session = sessionManager.get(targetId);
			if (!session) {
				ctx.ui.notify(`Session not found: ${targetId}`, "error");
				return;
			}

			const config = loadConfig(ctx.cwd);
			await ctx.ui.custom<InteractiveShellResult>(
				(tui, theme, _kb, done) =>
					new ReattachOverlay(
						tui,
						theme,
						{ id: session.id, command: session.command, reason: session.reason, session: session.session },
						config,
						done,
					),
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
		},
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

	// Consider "idle" when the command has no obvious positional prompt and only contains flags.
	// This is intentionally conservative to avoid false positives.
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
		return `Note: \`reason\` is UI-only. This command likely started the agent idle. If you intended an initial prompt, embed it in \`command\`, e.g. \`${bin} \"${clipped}\"\`.`;
	}

	return null;
}
