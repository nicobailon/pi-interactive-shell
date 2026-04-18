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
- monitor: Run in background and wake the agent on structured monitor events (stream, poll-diff, or file-watch)

RECOMMENDED DEFAULT FOR DELEGATED TASKS:
- For fire-and-forget delegations and QA-style checks, prefer mode="dispatch".
- Dispatch is the safest choice when the agent should continue immediately and be notified automatically on completion.

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
- interactive_shell({ monitorStatus: true, monitorSessionId: "calm-reef" }) - query monitor lifecycle/state
- interactive_shell({ monitorEvents: true, monitorSessionId: "calm-reef" }) - query monitor event history
- interactive_shell({ monitorEvents: true, monitorSessionId: "calm-reef", monitorSinceEventId: 42 }) - fetch events after a cursor
- interactive_shell({ monitorEvents: true, monitorSessionId: "calm-reef", monitorTriggerId: "error" }) - filter monitor history by trigger id
- interactive_shell({ monitorEvents: true, monitorSessionId: "calm-reef", monitorEventLimit: 50, monitorEventOffset: 20 }) - paginate monitor history

IMPORTANT: Don't query too frequently! Wait 30-60 seconds between status checks.
The user is watching the overlay in real-time - you're just checking in periodically.

RATE LIMITING:
Queries are limited to once every 60 seconds (configurable). If you query too soon,
the tool will automatically wait until the limit expires before returning.

SENDING INPUT:
- interactive_shell({ sessionId: "calm-reef", input: "/help", submit: true }) - type text and press Enter
- interactive_shell({ sessionId: "calm-reef", inputKeys: ["ctrl+c"] }) - named keys
- interactive_shell({ sessionId: "calm-reef", inputKeys: ["up", "up", "enter"] }) - multiple keys
- interactive_shell({ sessionId: "calm-reef", inputHex: ["0x1b", "0x5b", "0x41"] }) - raw escape sequences
- interactive_shell({ sessionId: "calm-reef", inputPaste: "multiline\\ntext" }) - bracketed paste (prevents auto-execution)

Named keys for inputKeys: up, down, left, right, enter, escape, tab, backspace, ctrl+c, ctrl+d, etc.
Modifiers: ctrl+x, alt+x, shift+tab, ctrl+alt+delete (or c-x, m-x, s-tab syntax)
For editor-based TUIs like pi, raw \`input\` only types text. It does NOT submit by itself. Prefer \`submit: true\` or \`inputKeys: ["enter"]\` instead of relying on \`\\n\`.

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

MONITOR MODE (EVENT-DRIVEN, HEADLESS):
Run a background process and wake the agent on structured monitor triggers:
- interactive_shell({ command: 'npm test --watch', mode: "monitor", monitor: { strategy: "stream", triggers: [{ id: "fail", literal: "FAIL" }] } })
- interactive_shell({ command: 'npm run dev', mode: "monitor", monitor: { strategy: "stream", triggers: [{ id: "warn", regex: "/error|warn/i" }] } })
- interactive_shell({ command: 'curl -sf http://localhost:3000/health', mode: "monitor", monitor: { strategy: "poll-diff", triggers: [{ id: "changed", regex: "/./" }], poll: { intervalMs: 5000 } } })
- interactive_shell({ mode: "monitor", monitor: { strategy: "file-watch", fileWatch: { path: "./uploads", recursive: true, events: ["rename", "change"] }, triggers: [{ id: "pdf", regex: "/\\.pdf$/i" }] } })

AGENT-INITIATED BACKGROUND:
Dismiss an existing overlay, keep the process running in background:
- interactive_shell({ sessionId: "calm-reef", background: true })

ATTACH (REATTACH TO BACKGROUND SESSION):
Open an overlay for a background session:
- interactive_shell({ attach: "calm-reef" }) - interactive (blocking)
- interactive_shell({ attach: "calm-reef", mode: "hands-free" }) - hands-free (poll)
- interactive_shell({ attach: "calm-reef", mode: "dispatch" }) - dispatch (non-blocking, notified)

LIST BACKGROUND SESSIONS:
- interactive_shell({ listBackground: true })

DISMISS BACKGROUND SESSIONS:
- interactive_shell({ dismissBackground: true }) - kill running, remove exited, clear all
- interactive_shell({ dismissBackground: "calm-reef" }) - dismiss specific session

When using raw \`command\`, this tool does NOT inject prompts for you.
If you want to start with a prompt, include it in the command using the CLI's own prompt form.
Structured \`spawn\` also supports a \`prompt\` field for Pi, Codex, and Claude using their native startup prompt forms.

Examples:
- pi "Scan the current codebase"
- claude "Check the current directory and summarize"
- interactive_shell({ spawn: { agent: "codex" }, mode: "dispatch" })
- interactive_shell({ spawn: { agent: "claude", prompt: "Review the diffs" }, mode: "dispatch" })
- interactive_shell({ spawn: { agent: "agent", prompt: "Review the diffs" }, mode: "dispatch" })
- interactive_shell({ spawn: { mode: "fork" } }) // pi-only fork of the current persisted session
- gemini (interactive, idle)
- aider --yes-always (hands-free, auto-approve)
- pi --help (with timeout: 5000 to capture help output)`;

export const toolParameters = Type.Object({
	command: Type.Optional(
		Type.String({
			description: "The raw CLI command to run (e.g., 'pi \"Fix the bug\"'). Use this for arbitrary CLIs. Mutually exclusive with 'spawn'.",
		}),
	),
	spawn: Type.Optional(
		Type.Object({
			agent: Type.Optional(Type.Union([
				Type.Literal("pi"),
				Type.Literal("codex"),
				Type.Literal("claude"),
				Type.Literal("agent"),
			], {
				description: "Spawn agent to launch. Defaults to the configured spawn.defaultAgent.",
			})),
			mode: Type.Optional(Type.Union([
				Type.Literal("fresh"),
				Type.Literal("fork"),
			], {
				description: "Spawn mode. 'fork' is only supported for pi and requires a persisted current session.",
			})),
			worktree: Type.Optional(Type.Boolean({
				description: "Launch in a separate git worktree. Defaults to spawn.worktree from config.",
			})),
			prompt: Type.Optional(Type.String({
				description: "Optional startup prompt for pi, codex, claude, or agent. Uses each CLI's native prompt-bearing startup form.",
			})),
		}, {
			description: "Structured spawn request for pi, codex, claude, or agent. Use this instead of building the command string manually when you want the extension's spawn defaults, Pi-only fork behavior, worktree support, or native startup prompts.",
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
		Type.String({ description: "Raw text to send to the session (requires sessionId). This only types the text; it does not submit it. Use submit=true or inputKeys:['enter'] when you want to press Enter." }),
	),
	submit: Type.Optional(
		Type.Boolean({ description: "Press Enter after sending any input. Prefer this when submitting slash commands or prompts to editor-based TUIs like pi. (requires sessionId)" }),
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
		Type.Union([
			Type.Literal("interactive"),
			Type.Literal("hands-free"),
			Type.Literal("dispatch"),
			Type.Literal("monitor"),
		], {
			description: "Mode: 'interactive' (default, user controls), 'hands-free' (agent monitors, user can take over), 'dispatch' (agent notified on completion, no polling needed), or 'monitor' (headless structured event monitor with stream/poll-diff/file-watch strategies).",
		}),
	),
	monitor: Type.Optional(
		Type.Object({
			strategy: Type.Optional(Type.Union([
				Type.Literal("stream"),
				Type.Literal("poll-diff"),
			Type.Literal("file-watch"),
			], {
				description: "Monitor strategy. stream = line-based trigger matching. poll-diff = periodic snapshot diffing. file-watch = first-class filesystem watch events.",
			})),
			triggers: Type.Array(Type.Object({
				id: Type.String({ description: "Unique trigger id used in emitted event payloads." }),
				literal: Type.Optional(Type.String({ description: "Literal substring trigger." })),
				regex: Type.Optional(Type.String({ description: "Regex trigger string. Supports /pattern/flags format." })),
				cooldownMs: Type.Optional(Type.Number({ description: "Optional per-trigger cooldown window in ms." })),
				threshold: Type.Optional(Type.Object({
					captureGroup: Type.Number({ description: "Regex capture group index parsed as number (requires regex matcher)." }),
					op: Type.Union([
						Type.Literal("lt"),
						Type.Literal("lte"),
						Type.Literal("gt"),
						Type.Literal("gte"),
					], { description: "Threshold operator." }),
					value: Type.Number({ description: "Threshold numeric value." }),
				})),
			}), {
				description: "Named trigger definitions. Each trigger must define exactly one matcher: literal or regex.",
			}),
			fileWatch: Type.Optional(Type.Object({
				path: Type.String({ description: "Path to watch for strategy='file-watch'. Relative paths resolve from cwd." }),
				recursive: Type.Optional(Type.Boolean({ description: "Watch subdirectories recursively (platform-dependent support)." })),
				events: Type.Optional(Type.Array(Type.Union([
					Type.Literal("rename"),
					Type.Literal("change"),
				]), { description: "Filesystem event names to emit." })),
			})),
			poll: Type.Optional(Type.Object({
				intervalMs: Type.Optional(Type.Number({ description: "Poll interval in ms for strategy='poll-diff' (default: 5000)." })),
			})),
			persistence: Type.Optional(Type.Object({
				stopAfterFirstEvent: Type.Optional(Type.Boolean({ description: "Stop monitor after first emitted event." })),
				maxEvents: Type.Optional(Type.Number({ description: "Maximum emitted events before monitor stops." })),
			})),
			throttle: Type.Optional(Type.Object({
				dedupeExactLine: Type.Optional(Type.Boolean({ description: "Suppress repeated exact line/diff payloads (default: true)." })),
				cooldownMs: Type.Optional(Type.Number({ description: "Optional global cooldown in ms across triggers." })),
			})),
			detector: Type.Optional(Type.Object({
				detectorCommand: Type.String({ description: "External detector command. Receives JSON candidate event on stdin and returns JSON decision on stdout." }),
				timeoutMs: Type.Optional(Type.Number({ description: "Detector command timeout in ms (default: 3000)." })),
			})),
		}, {
			description: "Structured monitor configuration required when mode='monitor'.",
		}),
	),
	background: Type.Optional(
		Type.Boolean({
			description: "Run without overlay (with mode='dispatch' or mode='monitor') or dismiss existing overlay (with sessionId). Process runs in background, user can /attach.",
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
	monitorStatus: Type.Optional(
		Type.Boolean({
			description: "Query monitor lifecycle/state summary. Requires monitorSessionId or sessionId.",
		}),
	),
	monitorEvents: Type.Optional(
		Type.Boolean({
			description: "Query structured monitor event history instead of session output. Requires monitorSessionId or sessionId.",
		}),
	),
	monitorSessionId: Type.Optional(
		Type.String({
			description: "Target monitor session for monitorStatus/monitorEvents queries.",
		}),
	),
	monitorEventLimit: Type.Optional(
		Type.Number({
			description: "Max monitor events to return (default: 20).",
		}),
	),
	monitorEventOffset: Type.Optional(
		Type.Number({
			description: "How many newest monitor events to skip before returning results (default: 0).",
		}),
	),
	monitorSinceEventId: Type.Optional(
		Type.Number({
			description: "Only return monitor events with eventId greater than this cursor.",
		}),
	),
	monitorTriggerId: Type.Optional(
		Type.String({
			description: "Filter monitor events to a specific trigger id.",
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
				Type.Number({ description: "Silence duration before emitting update in on-quiet mode (default: 8000ms)" }),
			),
			gracePeriod: Type.Optional(
				Type.Number({ description: "Startup grace period before autoExitOnQuiet can kill the session (default: 15000ms)" }),
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
	spawn?: { agent?: "pi" | "codex" | "claude" | "agent"; mode?: "fresh" | "fork"; worktree?: boolean; prompt?: string };
	sessionId?: string;
	kill?: boolean;
	outputLines?: number;
	outputMaxChars?: number;
	outputOffset?: number;
	drain?: boolean;
	incremental?: boolean;
	settings?: { updateInterval?: number; quietThreshold?: number };
	input?: string;
	submit?: boolean;
	inputKeys?: string[];
	inputHex?: string[];
	inputPaste?: string;
	cwd?: string;
	name?: string;
	reason?: string;
	mode?: "interactive" | "hands-free" | "dispatch" | "monitor";
	background?: boolean;
	monitor?: {
		strategy?: "stream" | "poll-diff" | "file-watch";
		triggers: Array<{
			id: string;
			literal?: string;
			regex?: string;
			cooldownMs?: number;
			threshold?: { captureGroup: number; op: "lt" | "lte" | "gt" | "gte"; value: number };
		}>;
		fileWatch?: { path: string; recursive?: boolean; events?: Array<"rename" | "change"> };
		poll?: { intervalMs?: number };
		persistence?: { stopAfterFirstEvent?: boolean; maxEvents?: number };
		throttle?: { dedupeExactLine?: boolean; cooldownMs?: number };
		detector?: { detectorCommand: string; timeoutMs?: number };
	};
	attach?: string;
	listBackground?: boolean;
	dismissBackground?: boolean | string;
	monitorStatus?: boolean;
	monitorEvents?: boolean;
	monitorSessionId?: string;
	monitorEventLimit?: number;
	monitorEventOffset?: number;
	monitorSinceEventId?: number;
	monitorTriggerId?: string;
	handsFree?: {
		updateMode?: "on-quiet" | "interval";
		updateInterval?: number;
		quietThreshold?: number;
		gracePeriod?: number;
		updateMaxChars?: number;
		maxTotalChars?: number;
		autoExitOnQuiet?: boolean;
	};
	handoffPreview?: { enabled?: boolean; lines?: number; maxChars?: number };
	handoffSnapshot?: { enabled?: boolean; lines?: number; maxChars?: number };
	timeout?: number;
}
