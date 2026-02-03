import { Type } from "@sinclair/typebox";

export const TOOL_NAME = "interactive_shell";
export const TOOL_LABEL = "Interactive Shell";

export const TOOL_DESCRIPTION = `Run an interactive CLI coding agent in an overlay.

Use this ONLY for delegating tasks to other AI coding agents (Claude Code, Gemini CLI, Codex, etc.) that have their own TUI and benefit from user interaction.

DO NOT use this for regular bash commands - use the standard bash tool instead.

MODES:
- interactive (default): User supervises and controls the session
- hands-free: Agent monitors with periodic updates, user can take over anytime by typing
- dispatch: Agent is notified on completion via triggerTurn (no polling needed)

The user will see the process in an overlay. They can:
- Watch output in real-time
- Scroll through output (Shift+Up/Down)
- Transfer output to you (Ctrl+T) - closes overlay and sends output as your context
- Background (Ctrl+B) - dismiss overlay, keep process running
- Detach (Ctrl+Q) for menu: transfer/background/kill
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
- Kill/background via Ctrl+Q

QUERYING SESSION STATUS:
- interactive_shell({ sessionId: "calm-reef" }) - get status + rendered terminal output (default: 20 lines, 5KB)
- interactive_shell({ sessionId: "calm-reef", outputLines: 50 }) - get more lines (max: 200)
- interactive_shell({ sessionId: "calm-reef", outputMaxChars: 20000 }) - get more content (max: 50KB)
- interactive_shell({ sessionId: "calm-reef", outputOffset: 0, outputLines: 50 }) - pagination (lines 0-49)
- interactive_shell({ sessionId: "calm-reef", incremental: true }) - get next N unseen lines (server tracks position)
- interactive_shell({ sessionId: "calm-reef", drain: true }) - only NEW output since last query (raw stream)
- interactive_shell({ sessionId: "calm-reef", kill: true }) - end session
- interactive_shell({ sessionId: "calm-reef", input: "..." }) - send input

IMPORTANT: Don't query too frequently! Wait 30-60 seconds between status checks.
The user is watching the overlay in real-time - you're just checking in periodically.

RATE LIMITING:
Queries are limited to once every 60 seconds (configurable). If you query too soon,
the tool will automatically wait until the limit expires before returning.

SENDING INPUT:
- interactive_shell({ sessionId: "calm-reef", input: "/help\\n" }) - raw text/keystrokes
- interactive_shell({ sessionId: "calm-reef", inputKeys: ["ctrl+c"] }) - named keys
- interactive_shell({ sessionId: "calm-reef", inputKeys: ["up", "up", "enter"] }) - multiple keys
- interactive_shell({ sessionId: "calm-reef", inputHex: ["0x1b", "0x5b", "0x41"] }) - raw escape sequences
- interactive_shell({ sessionId: "calm-reef", inputPaste: "multiline\\ntext" }) - bracketed paste (prevents auto-execution)

Named keys for inputKeys: up, down, left, right, enter, escape, tab, backspace, ctrl+c, ctrl+d, etc.
Modifiers: ctrl+x, alt+x, shift+tab, ctrl+alt+delete (or c-x, m-x, s-tab syntax)

TIMEOUT (for TUI commands that don't exit cleanly):
Use timeout to auto-kill after N milliseconds. Useful for capturing output from commands like "pi --help":
- interactive_shell({ command: "pi --help", mode: "hands-free", timeout: 5000 })

DISPATCH MODE (NON-BLOCKING, NO POLLING):
When mode="dispatch", the tool returns IMMEDIATELY with a sessionId.
You do NOT need to poll. You'll be notified automatically when the session completes.

Workflow:
1. Start session: interactive_shell({ command: 'pi "Fix bugs"', mode: "dispatch" })
   -> Returns immediately with sessionId
2. Do other work - no polling needed
3. When complete, you receive a notification with the session output

Dispatch defaults autoExitOnQuiet to true (opt-out with handsFree.autoExitOnQuiet: false).
You can still query with sessionId if needed, but it's not required.

BACKGROUND DISPATCH (HEADLESS):
Start a session without any overlay. Process runs headlessly, agent notified on completion:
- interactive_shell({ command: 'pi "fix bugs"', mode: "dispatch", background: true })

AGENT-INITIATED BACKGROUND:
Dismiss an existing overlay, keep the process running in background:
- interactive_shell({ sessionId: "calm-reef", background: true })

ATTACH (REATTACH TO BACKGROUND SESSION):
Open an overlay for a background session:
- interactive_shell({ attach: "calm-reef" }) - interactive (blocking)
- interactive_shell({ attach: "calm-reef", mode: "dispatch" }) - dispatch (non-blocking, notified)

LIST BACKGROUND SESSIONS:
- interactive_shell({ listBackground: true })

DISMISS BACKGROUND SESSIONS:
- interactive_shell({ dismissBackground: true }) - kill running, remove exited, clear all
- interactive_shell({ dismissBackground: "calm-reef" }) - dismiss specific session

Important: this tool does NOT inject prompts. If you want to start with a prompt,
include it in the command using the CLI's own prompt flags.

Examples:
- pi "Scan the current codebase"
- claude "Check the current directory and summarize"
- gemini (interactive, idle)
- aider --yes-always (hands-free, auto-approve)
- pi --help (with timeout: 5000 to capture help output)`;

export const toolParameters = Type.Object({
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
	outputLines: Type.Optional(
		Type.Number({
			description: "Number of lines to return when querying (default: 20, max: 200)",
		}),
	),
	outputMaxChars: Type.Optional(
		Type.Number({
			description: "Max chars to return when querying (default: 5KB, max: 50KB)",
		}),
	),
	outputOffset: Type.Optional(
		Type.Number({
			description: "Line offset for pagination (0-indexed). Use with outputLines to read specific ranges.",
		}),
	),
	drain: Type.Optional(
		Type.Boolean({
			description: "If true, return only NEW output since last query (raw stream). More token-efficient for repeated polling.",
		}),
	),
	incremental: Type.Optional(
		Type.Boolean({
			description: "If true, return next N lines not yet seen. Server tracks position - just keep calling to paginate through output.",
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
		Type.String({ description: "Raw text/keystrokes to send to the session (requires sessionId). For special keys, use inputKeys instead." }),
	),
	inputKeys: Type.Optional(
		Type.Array(Type.String(), {
			description: "Named keys with modifier support: up, down, enter, ctrl+c, alt+x, shift+tab, ctrl+alt+delete, etc. (requires sessionId)",
		}),
	),
	inputHex: Type.Optional(
		Type.Array(Type.String(), {
			description: "Hex bytes to send as raw escape sequences (e.g., ['0x1b', '0x5b', '0x41'] for ESC[A). (requires sessionId)",
		}),
	),
	inputPaste: Type.Optional(
		Type.String({
			description: "Text to paste with bracketed paste mode - prevents shells from auto-executing multiline input. (requires sessionId)",
		}),
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
		Type.String({
			description: "Mode: 'interactive' (default, user controls), 'hands-free' (agent monitors, user can take over), or 'dispatch' (agent notified on completion, no polling needed)",
		}),
	),
	background: Type.Optional(
		Type.Boolean({
			description: "Run without overlay (with mode='dispatch') or dismiss existing overlay (with sessionId). Process runs in background, user can /attach.",
		}),
	),
	attach: Type.Optional(
		Type.String({
			description: "Background session ID to reattach. Opens overlay with the specified mode.",
		}),
	),
	listBackground: Type.Optional(
		Type.Boolean({
			description: "List all background sessions.",
		}),
	),
	dismissBackground: Type.Optional(
		Type.Union([Type.Boolean(), Type.String()], {
			description: "Dismiss background sessions. true = all, string = specific session ID. Kills running sessions, removes exited ones.",
		}),
	),
	handsFree: Type.Optional(
		Type.Object({
			updateMode: Type.Optional(
				Type.String({
					description: "Update mode: 'on-quiet' (default, emit when output stops) or 'interval' (emit on fixed schedule)",
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
					description: "Auto-kill session when output stops (after quietThreshold). Defaults to false. Set to true for fire-and-forget single-task delegations.",
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
});

/** Parsed tool parameters type */
export interface ToolParams {
	command?: string;
	sessionId?: string;
	kill?: boolean;
	outputLines?: number;
	outputMaxChars?: number;
	outputOffset?: number;
	drain?: boolean;
	incremental?: boolean;
	settings?: { updateInterval?: number; quietThreshold?: number };
	input?: string;
	inputKeys?: string[];
	inputHex?: string[];
	inputPaste?: string;
	cwd?: string;
	name?: string;
	reason?: string;
	mode?: "interactive" | "hands-free" | "dispatch";
	background?: boolean;
	attach?: string;
	listBackground?: boolean;
	dismissBackground?: boolean | string;
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
}
