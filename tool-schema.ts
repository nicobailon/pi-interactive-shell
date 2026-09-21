import { Type, type Static } from "typebox";
import { SEMANTIC_SAFE_ID_PATTERN } from "./semantic-policy.ts";

export const TOOL_NAME = "interactive_shell";
export const TOOL_LABEL = "Interactive Shell";
export const ENABLE_TOOL_NAME = "enable_interactive_shell";
export const ENABLE_TOOL_LABEL = "Enable Interactive Shell";
export const ENABLE_TOOL_DESCRIPTION = "Enable the interactive_shell tool for interactive CLI coding agents, overlay supervision, background dispatch, and event-driven monitoring. Call this when interactive_shell is not available; it becomes callable on the next turn.";
export const enableToolParameters = Type.Object({});

const SEMANTIC_NONCONTROL_PATTERN = "^(?=.*\\S)[^\\u0000-\\u001F\\u007F]+$";
const SEMANTIC_TEXT_PATTERN = "^[^\\u0000-\\u001F\\u007F;&|`$<>]+$";

export const TOOL_DESCRIPTION = `Run an interactive CLI in an overlay or managed background session.

Use interactive_shell for CLIs that need typed input, user approval, or live supervision, including coding-agent TUIs and auth flows. Use bash for non-interactive shell commands.

The tool returns a stable sessionId immediately for interactive, hands-free, dispatch, and monitor sessions. Query output defaults to 20 rendered lines and 5KB, with parameters for larger, paged, incremental, or drain reads. Dispatch completion notifications set completionReason: "auto-close-quiet" when quiet auto-close cancels local supervision and attempts termination; this is not a command-completion verdict and subprocess exit is not confirmed.

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
			description: "Cancel the session locally and attempt termination (requires sessionId); subprocess exit is not confirmed. Use when task appears complete.",
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
	outputView: Type.Optional(Type.Union([
		Type.Literal("status"),
		Type.Literal("raw"),
		Type.Literal("selected"),
	], { description: "Explicitly inspect a recoverable output source without changing ordinary output cursors." })),
	sourceId: Type.Optional(Type.String({ description: "Stable output source ID returned by an opted-in dispatch launch." })),
	sourceOffset: Type.Optional(Type.Integer({ minimum: 0, description: "UTF-16 offset for raw source pagination (default 0)." })),
	sourceLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 51200, description: "Maximum UTF-16 characters returned from a raw source (default 5120, maximum 51200)." })),
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
			description: "Mode: 'interactive' (default, user controls), 'hands-free' (agent monitors, user can take over), 'dispatch' (agent notified on completion, no polling needed), or 'monitor' (headless structured event monitor with stream, poll-diff, file-watch, or semantic strategy).",
		}),
	),
	outputSelection: Type.Optional(Type.Object({
		enabled: Type.Literal(true),
		goal: Type.String({ minLength: 1, maxLength: 1000, description: "Explicit bounded goal authorizing recoverable output capture for a finite headless dispatch." }),
	}, { additionalProperties: false })),
	monitor: Type.Optional(
		Type.Object({
			strategy: Type.Optional(Type.Union([
				Type.Literal("stream"),
				Type.Literal("poll-diff"),
				Type.Literal("file-watch"),
				Type.Literal("semantic"),
			], {
				description: "Monitor strategy: stream matches live output; poll-diff compares periodic rendered output; file-watch observes file changes; semantic uses optional Jev observation and requires global user enablement plus TYPESAFE_API_KEY (project config alone cannot enable transmission).",
			})),
			triggers: Type.Optional(Type.Array(Type.Object({
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
			})),
			semantic: Type.Optional(Type.Object({
				goal: Type.Optional(Type.String({ maxLength: 1000, description: "Task context for bounded semantic observation (maximum 1000 characters)." })),
				attention: Type.Optional(Type.Boolean({ description: "Emit built-in semantic attention events for clear input, approval, result, or intervention states (default: false)." })),
				watches: Type.Optional(Type.Array(Type.Object({
					id: Type.String({ minLength: 1, maxLength: 64, pattern: SEMANTIC_SAFE_ID_PATTERN }),
					condition: Type.String({ pattern: "\\S", description: "Nonblank visible condition. Runtime also rejects duplicate watch IDs." }),
					threshold: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
				}, { additionalProperties: false }))),
				minIntervalMs: Type.Optional(Type.Integer({ minimum: 250, maximum: 60000, description: "Minimum interval between coalesced semantic requests (250-60000ms)." })),
				uncertain: Type.Optional(Type.Union([Type.Literal("continue"), Type.Literal("notify")], { description: "Emit semantic-uncertain events or continue silently (default: continue)." })),
				actions: Type.Optional(Type.Object({
					enabled: Type.Literal(true, { description: "Explicitly authorize only the listed immutable terminal inputs." }),
					maxActions: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "Session action-attempt budget (default 1, maximum 10)." })),
					items: Type.Array(Type.Union([
						Type.Object({
							id: Type.String({ minLength: 1, maxLength: 64, pattern: SEMANTIC_SAFE_ID_PATTERN }),
							description: Type.String({ minLength: 1, maxLength: 500, pattern: SEMANTIC_NONCONTROL_PATTERN, description: "Runtime additionally rejects reserved IDs and forbidden credential/lifecycle intent." }),
							input: Type.String({ minLength: 1, maxLength: 2000, pattern: SEMANTIC_TEXT_PATTERN, description: "Exact text. Runtime additionally rejects credential/lifecycle intent and opaque token shapes." }),
							submit: Type.Optional(Type.Boolean()), cooldownMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 86400000 })),
							maxExecutions: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
						}, { additionalProperties: false }),
						Type.Object({
							id: Type.String({ minLength: 1, maxLength: 64, pattern: SEMANTIC_SAFE_ID_PATTERN }),
							description: Type.String({ minLength: 1, maxLength: 500, pattern: SEMANTIC_NONCONTROL_PATTERN, description: "Runtime additionally rejects reserved IDs and forbidden credential/lifecycle intent." }),
							inputKeys: Type.Array(Type.String({ minLength: 1, maxLength: 64, pattern: SEMANTIC_NONCONTROL_PATTERN }), { minItems: 1, maxItems: 32, description: "Strict named keys (1-64 characters each, no controls). Runtime rejects unknown names and effective dangerous bytes." }),
							cooldownMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 86400000 })),
							maxExecutions: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
						}, { additionalProperties: false }),
					]), { minItems: 1, maxItems: 10 }),
				}, { additionalProperties: false })),
			}, { additionalProperties: false, description: "Optional per-session Jev supervision. Bounded terminal text is sent to TypeSafe AI only with global jev.enabled and TYPESAFE_API_KEY in Pi's environment. Attention/watches notify; actions require a separate explicit immutable allowlist." })),
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
			description: "Dismiss background sessions. true = all, string = specific session ID. Running sessions are cancelled locally and termination is attempted; subprocess exit is not confirmed. Exited sessions are removed.",
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
	semanticDecisions: Type.Optional(
		Type.Boolean({ description: "Inspect observe-only semantic decision history. Never triggers notifications or process actions." }),
	),
	semanticSessionId: Type.Optional(Type.String({ description: "Target session for semanticDecisions or semanticIncident; sessionId is also accepted." })),
	semanticDecisionLimit: Type.Optional(Type.Number({ description: "Maximum semantic decisions to return (default: 20)." })),
	semanticDecisionOffset: Type.Optional(Type.Number({ description: "Number of newest semantic decisions to skip." })),
	semanticDiagnostics: Type.Optional(Type.Boolean({ description: "Summarize safe local Jev diagnostic activity and recurring agent-reported incidents. Does not inspect terminal content." })),
	semanticDiagnosticDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 90, description: "Recent diagnostic days to summarize (default 7, capped by configured retention)." })),
	semanticDiagnosticLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Maximum recent incidents to return (default 20)." })),
	semanticIncident: Type.Optional(Type.Object({
		kind: Type.Union([
			Type.Literal("missed-notification"), Type.Literal("unnecessary-notification"), Type.Literal("wrong-notification-type"),
			Type.Literal("duplicate-notification"), Type.Literal("premature-result"), Type.Literal("stale-notification"),
		], { description: "Fixed discrepancy category observed during normal task execution." }),
		decisionId: Type.Optional(Type.Integer({ minimum: 1, description: "Related semantic decision ID when one exists." })),
		expectedEvent: Type.Optional(Type.Union([
			Type.Literal("input-required"), Type.Literal("approval-required"), Type.Literal("result-ready"), Type.Literal("intervention-required"),
			Type.Literal("uncertain"), Type.Literal("watch"), Type.Literal("evaluator-error"), Type.Literal("action-control"),
		])),
		observedEvent: Type.Optional(Type.Union([
			Type.Literal("input-required"), Type.Literal("approval-required"), Type.Literal("result-ready"), Type.Literal("intervention-required"),
			Type.Literal("uncertain"), Type.Literal("watch"), Type.Literal("evaluator-error"), Type.Literal("action-control"),
		])),
	}, { additionalProperties: false, description: "Record a structured Jev discrepancy naturally observed by the agent. Requires semanticSessionId or sessionId. No free-form terminal content is accepted." })),
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
				Type.Number({ description: "Startup grace period before autoExitOnQuiet cancels local supervision and attempts termination; subprocess exit is not confirmed (default: 15000ms)" }),
			),
			updateMaxChars: Type.Optional(
				Type.Number({ description: "Max chars per update (default: 1500)" }),
			),
			maxTotalChars: Type.Optional(
				Type.Number({ description: "Total char budget for all updates (default: 100000). Updates stop including content when exhausted." }),
			),
			autoExitOnQuiet: Type.Optional(
				Type.Boolean({
					description: "Auto-cancel local session supervision and attempt termination when output stops (after quietThreshold); subprocess exit is not confirmed. Defaults to true in dispatch mode and false in hands-free mode.",
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
			description: "Cancel local supervision after N milliseconds and attempt termination; subprocess exit is not confirmed. Useful for TUI commands that don't exit cleanly (e.g., 'pi --help')",
		}),
	),
});

/** Parsed tool parameters type, derived from the schema so the two cannot drift. */
export type ToolParams = Static<typeof toolParameters>;
