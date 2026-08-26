import { Type, type Static } from "typebox";

export const TOOL_NAME = "interactive_shell";
export const TOOL_LABEL = "Interactive Shell";
export const ENABLE_TOOL_NAME = "enable_interactive_shell";
export const ENABLE_TOOL_LABEL = "Enable Interactive Shell";
export const ENABLE_TOOL_DESCRIPTION = "Enable the interactive_shell tool for interactive CLI coding agents, overlay supervision, background dispatch, and event-driven monitoring. Call this when interactive_shell is not available; it becomes callable on the next turn.";
export const enableToolParameters = Type.Object({});

export const TOOL_DESCRIPTION = `Run an interactive CLI in an overlay or managed background session.

Use interactive_shell for CLIs that need typed input, user approval, or live supervision, including coding-agent TUIs and auth flows. Use bash for non-interactive shell commands.

The tool returns a stable sessionId immediately for interactive, hands-free, dispatch, and monitor sessions. Query output defaults to 20 rendered lines and 5KB, with parameters for larger, paged, incremental, or drain reads. Dispatch completion notifications include a bounded tail and set completionReason: "auto-close-quiet" when quiet auto-close ends the session.

Detailed mode, query, input, spawn, attach, and monitor recipes live in the bundled interactive-shell skill and README.`;

export const toolParameters = Type.Object({
	command: Type.Optional(
		Type.String({
			description: "The raw CLI command to run (e.g., 'pi \"Fix the bug\"'). Use this for arbitrary CLIs. Mutually exclusive with 'spawn'.",
		}),
	),
	spawn: Type.Optional(
		Type.Object({
			agent: Type.Optional(Type.String({
				description: "Spawn agent key from spawn.commands: built-in 'pi', 'codex', 'claude', 'cursor', or any custom key configured by the user. Defaults to the configured spawn.defaultAgent.",
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
				description: "Optional startup prompt, appended as the CLI's final argument. Uses each CLI's native prompt-bearing startup form.",
			})),
		}, {
			description: "Structured spawn request for any configured spawn agent. Use this instead of building the command string manually when you want the extension's spawn defaults, Pi-only fork behavior, worktree support, or native startup prompts.",
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
				Type.Union([
					Type.Literal("on-quiet"),
					Type.Literal("interval"),
				], {
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

/** Parsed tool parameters type, derived from the schema so the two cannot drift. */
export type ToolParams = Static<typeof toolParameters>;
