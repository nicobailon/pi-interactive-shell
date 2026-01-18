import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { InteractiveShellOverlay, ReattachOverlay, type InteractiveShellResult } from "./overlay-component.js";
import { sessionManager, generateSessionId } from "./session-manager.js";
import { loadConfig } from "./config.js";

// Terminal escape sequences for named keys
// Named key sequences (without modifiers)
const NAMED_KEYS: Record<string, string> = {
	// Arrow keys
	up: "\x1b[A",
	down: "\x1b[B",
	left: "\x1b[D",
	right: "\x1b[C",

	// Common keys
	enter: "\r",
	return: "\r",
	escape: "\x1b",
	esc: "\x1b",
	tab: "\t",
	space: " ",
	backspace: "\x7f",
	bspace: "\x7f", // tmux-style alias

	// Editing keys
	delete: "\x1b[3~",
	del: "\x1b[3~",
	dc: "\x1b[3~", // tmux-style alias
	insert: "\x1b[2~",
	ic: "\x1b[2~", // tmux-style alias

	// Navigation
	home: "\x1b[H",
	end: "\x1b[F",
	pageup: "\x1b[5~",
	pgup: "\x1b[5~",
	ppage: "\x1b[5~", // tmux-style alias
	pagedown: "\x1b[6~",
	pgdn: "\x1b[6~",
	npage: "\x1b[6~", // tmux-style alias

	// Shift+Tab (backtab)
	btab: "\x1b[Z",

	// Function keys
	f1: "\x1bOP",
	f2: "\x1bOQ",
	f3: "\x1bOR",
	f4: "\x1bOS",
	f5: "\x1b[15~",
	f6: "\x1b[17~",
	f7: "\x1b[18~",
	f8: "\x1b[19~",
	f9: "\x1b[20~",
	f10: "\x1b[21~",
	f11: "\x1b[23~",
	f12: "\x1b[24~",

	// Keypad keys (application mode)
	kp0: "\x1bOp",
	kp1: "\x1bOq",
	kp2: "\x1bOr",
	kp3: "\x1bOs",
	kp4: "\x1bOt",
	kp5: "\x1bOu",
	kp6: "\x1bOv",
	kp7: "\x1bOw",
	kp8: "\x1bOx",
	kp9: "\x1bOy",
	"kp/": "\x1bOo",
	"kp*": "\x1bOj",
	"kp-": "\x1bOm",
	"kp+": "\x1bOk",
	"kp.": "\x1bOn",
	kpenter: "\x1bOM",
};

// Ctrl+key combinations (ctrl+a through ctrl+z, plus some special)
const CTRL_KEYS: Record<string, string> = {};
for (let i = 0; i < 26; i++) {
	const char = String.fromCharCode(97 + i); // a-z
	CTRL_KEYS[`ctrl+${char}`] = String.fromCharCode(i + 1);
}
// Special ctrl combinations
CTRL_KEYS["ctrl+["] = "\x1b"; // Same as Escape
CTRL_KEYS["ctrl+\\"] = "\x1c";
CTRL_KEYS["ctrl+]"] = "\x1d";
CTRL_KEYS["ctrl+^"] = "\x1e";
CTRL_KEYS["ctrl+_"] = "\x1f";
CTRL_KEYS["ctrl+?"] = "\x7f"; // Same as Backspace

// Alt+key sends ESC followed by the key
function altKey(char: string): string {
	return `\x1b${char}`;
}

// Keys that support xterm modifier encoding (CSI sequences)
const MODIFIABLE_KEYS = new Set([
	"up", "down", "left", "right", "home", "end",
	"pageup", "pgup", "ppage", "pagedown", "pgdn", "npage",
	"insert", "ic", "delete", "del", "dc",
]);

// Calculate xterm modifier code: 1 + (shift?1:0) + (alt?2:0) + (ctrl?4:0)
function xtermModifier(shift: boolean, alt: boolean, ctrl: boolean): number {
	let mod = 1;
	if (shift) mod += 1;
	if (alt) mod += 2;
	if (ctrl) mod += 4;
	return mod;
}

// Apply xterm modifier to CSI sequence: ESC[A -> ESC[1;modA
function applyXtermModifier(sequence: string, modifier: number): string | null {
	// Arrow keys: ESC[A -> ESC[1;modA
	const arrowMatch = sequence.match(/^\x1b\[([A-D])$/);
	if (arrowMatch) {
		return `\x1b[1;${modifier}${arrowMatch[1]}`;
	}
	// Numbered sequences: ESC[5~ -> ESC[5;mod~
	const numMatch = sequence.match(/^\x1b\[(\d+)~$/);
	if (numMatch) {
		return `\x1b[${numMatch[1]};${modifier}~`;
	}
	// Home/End: ESC[H -> ESC[1;modH, ESC[F -> ESC[1;modF
	const hfMatch = sequence.match(/^\x1b\[([HF])$/);
	if (hfMatch) {
		return `\x1b[1;${modifier}${hfMatch[1]}`;
	}
	return null;
}

// Bracketed paste mode sequences
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

function encodePaste(text: string, bracketed = true): string {
	if (!bracketed) return text;
	return `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`;
}

// Parse a key token and return the escape sequence
function encodeKeyToken(token: string): string {
	const normalized = token.trim().toLowerCase();
	if (!normalized) return "";

	// Check for direct match in named keys
	if (NAMED_KEYS[normalized]) {
		return NAMED_KEYS[normalized];
	}

	// Check for ctrl+key
	if (CTRL_KEYS[normalized]) {
		return CTRL_KEYS[normalized];
	}

	// Parse modifier prefixes: ctrl+alt+shift+key, c-m-s-key, etc.
	let rest = normalized;
	let ctrl = false, alt = false, shift = false;

	// Support both "ctrl+alt+x" and "c-m-x" syntax
	while (rest.length > 2) {
		if (rest.startsWith("ctrl+") || rest.startsWith("ctrl-")) {
			ctrl = true;
			rest = rest.slice(5);
		} else if (rest.startsWith("alt+") || rest.startsWith("alt-")) {
			alt = true;
			rest = rest.slice(4);
		} else if (rest.startsWith("shift+") || rest.startsWith("shift-")) {
			shift = true;
			rest = rest.slice(6);
		} else if (rest.startsWith("c-")) {
			ctrl = true;
			rest = rest.slice(2);
		} else if (rest.startsWith("m-")) {
			alt = true;
			rest = rest.slice(2);
		} else if (rest.startsWith("s-")) {
			shift = true;
			rest = rest.slice(2);
		} else {
			break;
		}
	}

	// Handle shift+tab specially
	if (shift && rest === "tab") {
		return "\x1b[Z";
	}

	// Check if base key is a named key that supports modifiers
	const baseSeq = NAMED_KEYS[rest];
	if (baseSeq && MODIFIABLE_KEYS.has(rest) && (ctrl || alt || shift)) {
		const mod = xtermModifier(shift, alt, ctrl);
		if (mod > 1) {
			const modified = applyXtermModifier(baseSeq, mod);
			if (modified) return modified;
		}
	}

	// For single character with modifiers
	if (rest.length === 1) {
		let char = rest;
		if (shift && /[a-z]/.test(char)) {
			char = char.toUpperCase();
		}
		if (ctrl) {
			const ctrlChar = CTRL_KEYS[`ctrl+${char.toLowerCase()}`];
			if (ctrlChar) char = ctrlChar;
		}
		if (alt) {
			return altKey(char);
		}
		return char;
	}

	// Named key with alt modifier
	if (baseSeq && alt) {
		return `\x1b${baseSeq}`;
	}

	// Return base sequence if found
	if (baseSeq) {
		return baseSeq;
	}

	// Unknown key, return as literal
	return token;
}

function translateInput(input: string | { text?: string; keys?: string[]; paste?: string; hex?: string[] }): string {
	if (typeof input === "string") {
		return input;
	}

	let result = "";

	// Hex bytes (raw escape sequences)
	if (input.hex?.length) {
		for (const raw of input.hex) {
			const trimmed = raw.trim().toLowerCase();
			const normalized = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
			if (/^[0-9a-f]{1,2}$/.test(normalized)) {
				const value = Number.parseInt(normalized, 16);
				if (!Number.isNaN(value) && value >= 0 && value <= 0xff) {
					result += String.fromCharCode(value);
				}
			}
		}
	}

	// Literal text
	if (input.text) {
		result += input.text;
	}

	// Named keys with modifier support
	if (input.keys) {
		for (const key of input.keys) {
			result += encodeKeyToken(key);
		}
	}

	// Bracketed paste
	if (input.paste) {
		result += encodePaste(input.paste);
	}

	return result;
}

export default function interactiveShellExtension(pi: ExtensionAPI) {
	pi.on("session_shutdown", () => {
		sessionManager.killAll();
	});

	pi.registerTool({
		name: "interactive_shell",
		label: "Interactive Shell",
		description: `Run an interactive CLI coding agent in an overlay.

Use this ONLY for delegating tasks to other AI coding agents (Claude Code, Gemini CLI, Codex, etc.) that have their own TUI and benefit from user interaction.

DO NOT use this for regular bash commands - use the standard bash tool instead.

MODES:
- interactive (default): User supervises and controls the session
- hands-free: Agent monitors with periodic updates, user can take over anytime by typing

The user will see the process in an overlay. They can:
- Watch output in real-time
- Scroll through output (Shift+Up/Down)
- Detach (double-Escape) to kill or run in background
- In hands-free mode: type anything to take over control

HANDS-FREE MODE (NON-BLOCKING):
When mode="hands-free", the tool returns IMMEDIATELY with a sessionId.
The overlay opens for the user to watch, but you (the agent) get control back right away.

Workflow:
1. Start session: interactive_shell({ command: 'pi "Fix bugs"', mode: "hands-free" })
   -> Returns immediately with sessionId
2. Check status/output: interactive_shell({ sessionId: "calm-reef" })
   -> Returns current status and any new output since last check
3. When task is done: interactive_shell({ sessionId: "calm-reef", kill: true })
   -> Kills session and returns final output

The user sees the overlay and can:
- Watch output in real-time
- Take over by typing (you'll see "user-takeover" status on next query)
- Kill/background via double-Escape

QUERYING SESSION STATUS:
- interactive_shell({ sessionId: "calm-reef" }) - get status + new output
- interactive_shell({ sessionId: "calm-reef", kill: true }) - end session
- interactive_shell({ sessionId: "calm-reef", input: "..." }) - send input

SENDING INPUT:
- interactive_shell({ sessionId: "calm-reef", input: "/help\\n" })
- interactive_shell({ sessionId: "calm-reef", input: { keys: ["ctrl+c"] } })

Named keys: up, down, left, right, enter, escape, tab, backspace, ctrl+c, ctrl+d, etc.
Modifiers: ctrl+x, alt+x, shift+tab, ctrl+alt+delete (or c-x, m-x, s-tab syntax)
Hex bytes: input: { hex: ["0x1b", "0x5b", "0x41"] } for raw escape sequences
Bracketed paste: input: { paste: "multiline\\ntext" } prevents auto-execution

TIMEOUT (for TUI commands that don't exit cleanly):
Use timeout to auto-kill after N milliseconds. Useful for capturing output from commands like "pi --help":
- interactive_shell({ command: "pi --help", mode: "hands-free", timeout: 5000 })

Important: this tool does NOT inject prompts. If you want to start with a prompt,
include it in the command using the CLI's own prompt flags.

Examples:
- pi "Scan the current codebase"
- claude "Check the current directory and summarize"
- gemini (interactive, idle)
- aider --yes-always (hands-free, auto-approve)
- pi --help (with timeout: 5000 to capture help output)`,

		parameters: Type.Object({
			command: Type.Optional(
				Type.String({
					description: "The CLI agent command (e.g., 'pi \"Fix the bug\"'). Required to start a new session.",
				}),
			),
			sessionId: Type.Optional(
				Type.String({
					description: "Session ID to interact with an existing hands-free session",
				}),
			),
			kill: Type.Optional(
				Type.Boolean({
					description: "Kill the session (requires sessionId). Use when task appears complete.",
				}),
			),
			settings: Type.Optional(
				Type.Object({
					updateInterval: Type.Optional(
						Type.Number({ description: "Change max update interval for existing session (ms)" }),
					),
					quietThreshold: Type.Optional(
						Type.Number({ description: "Change quiet threshold for existing session (ms)" }),
					),
				}),
			),
			input: Type.Optional(
				Type.Union(
					[
						Type.String({ description: "Raw text/keystrokes to send" }),
						Type.Object({
							text: Type.Optional(Type.String({ description: "Text to type" })),
							keys: Type.Optional(
								Type.Array(Type.String(), {
									description:
										"Named keys with modifier support: up, down, enter, ctrl+c, alt+x, shift+tab, ctrl+alt+delete, etc.",
								}),
							),
							hex: Type.Optional(
								Type.Array(Type.String(), {
									description: "Hex bytes to send (e.g., ['0x1b', '0x5b', '0x41'] for ESC[A)",
								}),
							),
							paste: Type.Optional(
								Type.String({
									description: "Text to paste with bracketed paste mode (prevents auto-execution)",
								}),
							),
						}),
					],
					{ description: "Input to send to an existing session (requires sessionId)" },
				),
			),
			cwd: Type.Optional(
				Type.String({
					description: "Working directory for the command",
				}),
			),
			name: Type.Optional(
				Type.String({
					description: "Optional session name (used for session IDs)",
				}),
			),
			reason: Type.Optional(
				Type.String({
					description:
						"Brief explanation shown in the overlay header only (not passed to the subprocess)",
				}),
			),
			mode: Type.Optional(
				Type.Union([Type.Literal("interactive"), Type.Literal("hands-free")], {
					description: "interactive (default): user controls. hands-free: agent monitors, user can take over",
				}),
			),
			handsFree: Type.Optional(
				Type.Object({
					updateMode: Type.Optional(
						Type.Union([Type.Literal("on-quiet"), Type.Literal("interval")], {
							description: "on-quiet (default): emit when output stops. interval: emit on fixed schedule.",
						}),
					),
					updateInterval: Type.Optional(
						Type.Number({ description: "Max interval between updates in ms (default: 60000)" }),
					),
					quietThreshold: Type.Optional(
						Type.Number({ description: "Silence duration before emitting update in on-quiet mode (default: 5000ms)" }),
					),
					updateMaxChars: Type.Optional(
						Type.Number({ description: "Max chars per update (default: 1500)" }),
					),
					maxTotalChars: Type.Optional(
						Type.Number({ description: "Total char budget for all updates (default: 100000). Updates stop including content when exhausted." }),
					),
					autoExitOnQuiet: Type.Optional(
						Type.Boolean({
							description: "Auto-kill session when output stops (after quietThreshold). Use for agents that don't exit on their own after completing a task.",
						}),
					),
				}),
			),
			handoffPreview: Type.Optional(
				Type.Object({
					enabled: Type.Optional(Type.Boolean({ description: "Include last N lines in tool result details" })),
					lines: Type.Optional(Type.Number({ description: "Tail lines to include (default from config)" })),
					maxChars: Type.Optional(
						Type.Number({ description: "Max chars to include in tail preview (default from config)" }),
					),
				}),
			),
			handoffSnapshot: Type.Optional(
				Type.Object({
					enabled: Type.Optional(Type.Boolean({ description: "Write a transcript snapshot on detach/exit" })),
					lines: Type.Optional(Type.Number({ description: "Tail lines to capture (default from config)" })),
					maxChars: Type.Optional(Type.Number({ description: "Max chars to write (default from config)" })),
				}),
			),
			timeout: Type.Optional(
				Type.Number({
					description: "Auto-kill process after N milliseconds. Useful for TUI commands that don't exit cleanly (e.g., 'pi --help')",
				}),
			),
		}),

		async execute(_toolCallId, params, onUpdate, ctx) {
			const {
				command,
				sessionId,
				kill,
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
			} = params as {
				command?: string;
				sessionId?: string;
				kill?: boolean;
				settings?: { updateInterval?: number; quietThreshold?: number };
				input?: string | { text?: string; keys?: string[]; hex?: string[]; paste?: string };
				cwd?: string;
				name?: string;
				reason?: string;
				mode?: "interactive" | "hands-free";
				handsFree?: {
					updateMode?: "on-quiet" | "interval";
					updateInterval?: number;
					quietThreshold?: number;
					updateMaxChars?: number;
					maxTotalChars?: number;
					autoExitOnQuiet?: boolean;
				};
				handoffPreview?: { enabled?: boolean; lines?: number; maxChars?: number };
				handoffSnapshot?: { enabled?: boolean; lines?: number; maxChars?: number };
				timeout?: number;
			};

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
					const { output, truncated, totalBytes } = session.getOutput();
					const status = session.getStatus();
					const runtime = session.getRuntime();
					session.kill();
					sessionManager.unregisterActive(sessionId, true);

					const truncatedNote = truncated ? ` (${totalBytes} bytes total, truncated)` : "";
					return {
						content: [
							{
								type: "text",
								text: `Session ${sessionId} killed after ${formatDurationMs(runtime)}${output ? `\n\nFinal output${truncatedNote}:\n${output}` : ""}`,
							},
						],
						details: {
							sessionId,
							status: "killed",
							runtime,
							output,
							outputTruncated: truncated,
							outputTotalBytes: totalBytes,
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
					const { output, truncated, totalBytes } = session.getOutput();
					const status = session.getStatus();
					const runtime = session.getRuntime();
					const result = session.getResult();

					const truncatedNote = truncated ? ` (${totalBytes} bytes total, truncated to last 10KB)` : "";
					const hasOutput = output.length > 0;

					// Check if session completed
					if (result) {
						sessionManager.unregisterActive(sessionId, true);
						return {
							content: [
								{
									type: "text",
									text: `Session ${sessionId} ${status} after ${formatDurationMs(runtime)}${hasOutput ? `\n\nOutput${truncatedNote}:\n${output}` : ""}`,
								},
							],
							details: {
								sessionId,
								status,
								runtime,
								output,
								outputTruncated: truncated,
								outputTotalBytes: totalBytes,
								exitCode: result.exitCode,
								signal: result.signal,
								backgroundId: result.backgroundId,
							},
						};
					}

					return {
						content: [
							{
								type: "text",
								text: `Session ${sessionId} ${status} (${formatDurationMs(runtime)})${hasOutput ? `\n\nNew output${truncatedNote}:\n${output}` : "\n\n(no new output)"}`,
							},
						],
						details: {
							sessionId,
							status,
							runtime,
							output,
							outputTruncated: truncated,
							outputTotalBytes: totalBytes,
							hasNewOutput: hasOutput,
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
								autoExitOnQuiet: handsFree?.autoExitOnQuiet,
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
					const reason = s.reason ? ` • ${s.reason}` : "";
					return `${s.id} - ${s.command}${reason} (${status}, ${duration})`;
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

function formatDuration(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}

// Alias for clarity in hands-free update context
const formatDurationMs = formatDuration;

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
