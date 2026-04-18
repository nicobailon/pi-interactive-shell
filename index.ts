import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, matchesKey } from "@mariozechner/pi-tui";
import { InteractiveShellOverlay } from "./overlay-component.js";
import { ReattachOverlay } from "./reattach-overlay.js";
import { PtyTerminalSession } from "./pty-session.js";
import { formatDuration, formatDurationMs } from "./types.js";
import type {
	HandsFreeUpdate,
	InteractiveShellResult,
	MonitorConfig,
	MonitorEventPayload,
	MonitorFileWatchConfig,
	MonitorStrategy,
	MonitorTerminalReason,
	MonitorThresholdOperator,
	MonitorTriggerConfig,
} from "./types.js";
import { sessionManager, generateSessionId } from "./session-manager.js";
import { loadConfig } from "./config.js";
import type { InteractiveShellConfig } from "./config.js";
import { parseSpawnArgs, resolveSpawn, type SpawnRequest } from "./spawn.js";
import { translateInput } from "./key-encoding.js";
import { TOOL_NAME, TOOL_LABEL, TOOL_DESCRIPTION, toolParameters, type ToolParams } from "./tool-schema.js";
import { HeadlessDispatchMonitor } from "./headless-monitor.js";
import type {
	HeadlessCompletionInfo,
	MonitorMatchInfo,
	MonitorRuntimeConfig,
	MonitorTriggerMatcher,
} from "./headless-monitor.js";
import { setupBackgroundWidget } from "./background-widget.js";
import { buildDispatchNotification, buildHandsFreeUpdateMessage, buildMonitorEventNotification, buildMonitorLifecycleNotification, buildResultNotification, summarizeInteractiveResult } from "./notification-utils.js";
import { createSessionQueryState, getSessionOutput } from "./session-query.js";
import { InteractiveShellCoordinator } from "./runtime-coordinator.js";
import { spawn as spawnChildProcess } from "node:child_process";

const coordinator = new InteractiveShellCoordinator();
const SIDE_CHAT_SHORTCUT = "alt+/";

function scheduleMonitorHistoryCleanup(sessionId: string, delayMs = 5 * 60 * 1000): void {
	const attempt = () => {
		const stillInUse = Boolean(coordinator.getMonitor(sessionId))
			|| Boolean(sessionManager.getActive(sessionId))
			|| sessionManager.list().some((session) => session.id === sessionId);
		if (stillInUse) {
			setTimeout(attempt, 30_000);
			return;
		}
		coordinator.clearMonitorEvents(sessionId);
	};
	setTimeout(attempt, delayMs);
}

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
		scheduleMonitorHistoryCleanup(id);
		sessionManager.scheduleCleanup(id, 5 * 60 * 1000);
	};
}

function resolveMonitorTerminalReason(info: HeadlessCompletionInfo, override?: MonitorTerminalReason): MonitorTerminalReason {
	if (override) return override;
	if (info.timedOut) return "timed-out";
	if (info.cancelled) return "stopped";
	if (info.exitCode === 0) return "stream-ended";
	return "script-failed";
}

function makeStructuredMonitorCompletionCallback(
	pi: ExtensionAPI,
	id: string,
): (info: HeadlessCompletionInfo) => void {
	return (info) => {
		const reason = resolveMonitorTerminalReason(info, coordinator.consumePendingMonitorReason(id));
		const state = coordinator.finalizeMonitorSession(id, { exitCode: info.exitCode, signal: info.signal }, reason);
		const wasAgentHandled = coordinator.consumeAgentHandledCompletion(id);
		if (!wasAgentHandled && state) {
			const content = buildMonitorLifecycleNotification(state);
			pi.sendMessage({
				customType: "interactive-shell-monitor-lifecycle",
				content,
				display: true,
				details: { sessionId: id, state, completion: info },
			}, { triggerTurn: true });
			pi.events.emit("interactive-shell:monitor-lifecycle", { sessionId: id, state, completion: info });
		}
		sessionManager.unregisterActive(id, false);
		coordinator.deleteMonitor(id);
		scheduleMonitorHistoryCleanup(id);
		sessionManager.scheduleCleanup(id, 5 * 60 * 1000);
	};
}

type CompiledMonitorConfig = {
	runtime: MonitorRuntimeConfig;
	persistence: {
		stopAfterFirstEvent: boolean;
		maxEvents?: number;
	};
	fileWatch?: Required<MonitorFileWatchConfig>;
	detector?: {
		detectorCommand: string;
		timeoutMs: number;
	};
	publicConfig: MonitorConfig;
};

type DetectorDecision = {
	emit: boolean;
	triggerId?: string;
	eventType?: string;
	matchedText?: string;
	lineOrDiff?: string;
};

function buildPollDiffLoopCommand(command: string, intervalMs: number): string {
	if (process.platform === "win32") {
		const seconds = Math.max(1, Math.ceil(intervalMs / 1000));
		return `for /L %i in (0,0,1) do (${command} & timeout /t ${seconds} /nobreak >nul)`;
	}
	const seconds = Math.max(0.25, intervalMs / 1000);
	const roundedSeconds = Number(seconds.toFixed(3));
	return `while true; do ${command}; sleep ${roundedSeconds}; done`;
}

function shellQuote(value: string): string {
	if (process.platform === "win32") {
		return `"${value.replace(/"/g, '""')}"`;
	}
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function buildFileWatchCommand(fileWatch: Required<MonitorFileWatchConfig>): string {
	const script = `
const fs = require("node:fs");
const watchPath = process.argv[1];
const recursive = process.argv[2] === "1";
const allowed = new Set((process.argv[3] || "rename,change").split(",").filter(Boolean));
function emit(eventType, filename) {
  if (!allowed.has(eventType)) return;
  const name = filename ? String(filename) : ".";
  process.stdout.write(eventType.toUpperCase() + " " + name + "\\n");
}
let watcher;
try {
  watcher = fs.watch(watchPath, { recursive }, (eventType, filename) => emit(eventType, filename));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error("file-watch failed: " + message);
  process.exit(1);
}
watcher.on("error", (error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("file-watch error: " + message);
  process.exit(1);
});
process.stdin.resume();
`.trim();

	const encoded = Buffer.from(script, "utf8").toString("base64");
	const eventCsv = fileWatch.events.join(",");
	return `${shellQuote(process.execPath)} -e "eval(Buffer.from('${encoded}','base64').toString('utf8'))" ${shellQuote(fileWatch.path)} ${fileWatch.recursive ? "1" : "0"} ${shellQuote(eventCsv)}`;
}

function compareThreshold(value: number, op: MonitorThresholdOperator, expected: number): boolean {
	if (op === "lt") return value < expected;
	if (op === "lte") return value <= expected;
	if (op === "gt") return value > expected;
	return value >= expected;
}

function parseRegexPattern(value: string): { ok: true; regex: RegExp } | { ok: false; error: string } {
	const trimmed = value.trim();
	if (!trimmed) {
		return { ok: false, error: "Regex pattern cannot be empty." };
	}

	const literal = /^\/(.+)\/([A-Za-z]*)$/.exec(trimmed);
	let source = trimmed;
	let flags = "";
	if (literal) {
		if (!/^[dgimsuvy]*$/i.test(literal[2])) {
			return { ok: false, error: `Invalid regex flags: ${literal[2]}` };
		}
		source = literal[1];
		flags = literal[2].replace(/[gy]/gi, "");
	}

	try {
		return { ok: true, regex: new RegExp(source, flags) };
	} catch (error) {
		if (error instanceof Error) {
			return { ok: false, error: `Invalid regex '${value}': ${error.message}` };
		}
		return { ok: false, error: `Invalid regex '${value}'.` };
	}
}

function compileMonitorTrigger(trigger: MonitorTriggerConfig, index: number):
	| { ok: true; compiled: MonitorTriggerMatcher }
	| { ok: false; error: string } {
	const id = trigger.id?.trim();
	if (!id) {
		return { ok: false, error: `monitor.triggers[${index}] requires non-empty id.` };
	}

	const hasLiteral = typeof trigger.literal === "string";
	const hasRegex = typeof trigger.regex === "string";
	if ((hasLiteral ? 1 : 0) + (hasRegex ? 1 : 0) !== 1) {
		return { ok: false, error: `monitor.triggers[${index}] must define exactly one matcher: literal or regex.` };
	}

	if (trigger.threshold && !hasRegex) {
		return { ok: false, error: `monitor.triggers[${index}].threshold requires regex matcher.` };
	}

	if (hasLiteral) {
		const literal = trigger.literal!.trim();
		if (!literal) {
			return { ok: false, error: `monitor.triggers[${index}].literal cannot be empty.` };
		}
		return {
			ok: true,
			compiled: {
				id,
				cooldownMs: trigger.cooldownMs,
				match: (input: string) => {
					const idx = input.indexOf(literal);
					if (idx === -1) return undefined;
					return input.slice(idx, idx + literal.length);
				},
			},
		};
	}

	const parsed = parseRegexPattern(trigger.regex!);
	if (!parsed.ok) {
		return { ok: false, error: `monitor.triggers[${index}].regex ${parsed.error}` };
	}

	const threshold = trigger.threshold;
	if (threshold) {
		if (!Number.isInteger(threshold.captureGroup) || threshold.captureGroup < 1) {
			return { ok: false, error: `monitor.triggers[${index}].threshold.captureGroup must be an integer >= 1.` };
		}
		if (!["lt", "lte", "gt", "gte"].includes(threshold.op)) {
			return { ok: false, error: `monitor.triggers[${index}].threshold.op must be one of: lt, lte, gt, gte.` };
		}
		if (!Number.isFinite(threshold.value)) {
			return { ok: false, error: `monitor.triggers[${index}].threshold.value must be a finite number.` };
		}
	}

	return {
		ok: true,
		compiled: {
			id,
			cooldownMs: trigger.cooldownMs,
			match: (input: string) => {
				parsed.regex.lastIndex = 0;
				const match = parsed.regex.exec(input);
				if (!match) return undefined;
				if (!threshold) return match[0];
				const captured = match[threshold.captureGroup];
				if (captured === undefined) return undefined;
				const numeric = Number(captured);
				if (!Number.isFinite(numeric)) return undefined;
				if (!compareThreshold(numeric, threshold.op, threshold.value)) return undefined;
				return match[0];
			},
		},
	};
}

function compileMonitorConfig(raw: MonitorConfig | undefined):
	| { ok: true; compiled: CompiledMonitorConfig }
	| { ok: false; error: string } {
	if (!raw) {
		return { ok: false, error: "mode='monitor' requires monitor configuration." };
	}

	const strategy: MonitorStrategy = raw.strategy ?? "stream";
	if (strategy !== "stream" && strategy !== "poll-diff" && strategy !== "file-watch") {
		return { ok: false, error: `Unsupported monitor.strategy: ${String(raw.strategy)}` };
	}

	if (!Array.isArray(raw.triggers) || raw.triggers.length === 0) {
		return { ok: false, error: "monitor.triggers must contain at least one trigger." };
	}

	const ids = new Set<string>();
	const compiledTriggers: MonitorTriggerMatcher[] = [];
	for (let i = 0; i < raw.triggers.length; i++) {
		const trigger = raw.triggers[i];
		const compiled = compileMonitorTrigger(trigger, i);
		if (!compiled.ok) return compiled;
		if (ids.has(compiled.compiled.id)) {
			return { ok: false, error: `Duplicate monitor trigger id: ${compiled.compiled.id}` };
		}
		ids.add(compiled.compiled.id);
		compiledTriggers.push(compiled.compiled);
	}

	let fileWatch: Required<MonitorFileWatchConfig> | undefined;
	if (strategy === "file-watch") {
		if (!raw.fileWatch) {
			return { ok: false, error: "monitor.fileWatch is required when monitor.strategy='file-watch'." };
		}
		const watchPath = raw.fileWatch.path?.trim();
		if (!watchPath) {
			return { ok: false, error: "monitor.fileWatch.path must be a non-empty string." };
		}
		const watchEvents = raw.fileWatch.events ?? ["rename", "change"];
		if (!Array.isArray(watchEvents) || watchEvents.length === 0) {
			return { ok: false, error: "monitor.fileWatch.events must contain at least one event." };
		}
		for (const eventName of watchEvents) {
			if (eventName !== "rename" && eventName !== "change") {
				return { ok: false, error: `Unsupported monitor.fileWatch event: ${String(eventName)}. Use 'rename' or 'change'.` };
			}
		}
		fileWatch = {
			path: watchPath,
			recursive: raw.fileWatch.recursive === true,
			events: Array.from(new Set(watchEvents)),
		};
	} else if (raw.fileWatch) {
		return { ok: false, error: "monitor.fileWatch is only valid when monitor.strategy='file-watch'." };
	}

	if (strategy !== "poll-diff" && raw.poll) {
		return { ok: false, error: "monitor.poll is only valid when monitor.strategy='poll-diff'." };
	}

	const pollIntervalMs = Math.max(250, Math.trunc(raw.poll?.intervalMs ?? 5000));
	const dedupeExactLine = raw.throttle?.dedupeExactLine !== false;
	const cooldownMs = raw.throttle?.cooldownMs !== undefined
		? Math.max(0, Math.trunc(raw.throttle.cooldownMs))
		: undefined;
	const stopAfterFirstEvent = raw.persistence?.stopAfterFirstEvent === true;
	const maxEvents = raw.persistence?.maxEvents !== undefined
		? Math.max(1, Math.trunc(raw.persistence.maxEvents))
		: undefined;

	const detectorCommand = raw.detector?.detectorCommand?.trim();
	const detector = detectorCommand
		? {
			detectorCommand,
			timeoutMs: Math.max(100, Math.trunc(raw.detector?.timeoutMs ?? 3000)),
		}
		: undefined;

	const publicConfig: MonitorConfig = {
		strategy,
		triggers: raw.triggers,
		fileWatch,
		poll: strategy === "poll-diff" ? { intervalMs: pollIntervalMs } : undefined,
		persistence: {
			stopAfterFirstEvent,
			maxEvents,
		},
		throttle: {
			dedupeExactLine,
			cooldownMs,
		},
		detector: detector
			? {
				detectorCommand: detector.detectorCommand,
				timeoutMs: detector.timeoutMs,
			}
			: undefined,
	};

	return {
		ok: true,
		compiled: {
			runtime: {
				strategy,
				triggers: compiledTriggers,
				pollIntervalMs,
				dedupeExactLine,
				cooldownMs,
			},
			persistence: {
				stopAfterFirstEvent,
				maxEvents,
			},
			fileWatch,
			detector,
			publicConfig,
		},
	};
}

async function runDetectorCommand(
	detector: NonNullable<CompiledMonitorConfig["detector"]>,
	candidate: MonitorEventPayload,
	cwd?: string,
): Promise<DetectorDecision> {
	return new Promise<DetectorDecision>((resolve, reject) => {
		const shell = process.platform === "win32"
			? (process.env.COMSPEC || "cmd.exe")
			: (process.env.SHELL || "/bin/sh");
		const args = process.platform === "win32"
			? ["/d", "/s", "/c", detector.detectorCommand]
			: ["-c", detector.detectorCommand];

		const child = spawnChildProcess(shell, args, {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
			env: process.env,
		});

		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error(`detectorCommand timed out after ${detector.timeoutMs}ms`));
		}, detector.timeoutMs);

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });

		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});

		child.on("exit", (code) => {
			clearTimeout(timer);
			if (code !== 0) {
				reject(new Error(`detectorCommand exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
				return;
			}
			const raw = stdout.trim();
			if (!raw) {
				resolve({ emit: true });
				return;
			}
			try {
				const parsed = JSON.parse(raw) as DetectorDecision | boolean;
				if (typeof parsed === "boolean") {
					resolve({ emit: parsed });
					return;
				}
				resolve({
					emit: parsed.emit !== false,
					triggerId: parsed.triggerId,
					eventType: parsed.eventType,
					matchedText: parsed.matchedText,
					lineOrDiff: parsed.lineOrDiff,
				});
			} catch (error) {
				reject(new Error(`detectorCommand returned invalid JSON: ${(error as Error).message}`));
			}
		});

		child.stdin.write(`${JSON.stringify(candidate)}\n`);
		child.stdin.end();
	});
}

function makeMonitorEventCallback(
	pi: ExtensionAPI,
	sessionId: string,
	config: CompiledMonitorConfig,
	cwd?: string,
): (event: MonitorMatchInfo) => void {
	let queue = Promise.resolve();
	let emitted = 0;
	let stopped = false;

	return (event) => {
		queue = queue.then(async () => {
			if (stopped) return;
			if (!coordinator.getMonitor(sessionId)) {
				stopped = true;
				return;
			}

			let candidate: Omit<MonitorEventPayload, "eventId" | "timestamp"> = {
				sessionId,
				strategy: event.strategy,
				triggerId: event.triggerId,
				eventType: event.eventType,
				matchedText: event.matchedText,
				lineOrDiff: event.lineOrDiff,
				stream: event.stream,
			};

			if (config.detector) {
				try {
					const detectorPreview: MonitorEventPayload = {
						...candidate,
						eventId: 0,
						timestamp: new Date().toISOString(),
					};
					const decision = await runDetectorCommand(config.detector, detectorPreview, cwd);
					if (!decision.emit) return;
					if (decision.triggerId) candidate = { ...candidate, triggerId: decision.triggerId };
					if (decision.eventType) candidate = { ...candidate, eventType: decision.eventType };
					if (decision.matchedText) candidate = { ...candidate, matchedText: decision.matchedText };
					if (decision.lineOrDiff) candidate = { ...candidate, lineOrDiff: decision.lineOrDiff };
				} catch (error) {
					console.error(`interactive-shell: detectorCommand failed for ${sessionId}:`, error);
					return;
				}
			}

			const payload = coordinator.recordMonitorEvent(candidate);
			const content = buildMonitorEventNotification(payload);
			pi.sendMessage({
				customType: "interactive-shell-monitor-event",
				content,
				display: true,
				details: payload,
			}, { triggerTurn: true });
			pi.events.emit("interactive-shell:monitor-event", payload);

			emitted += 1;
			if (config.persistence.stopAfterFirstEvent || (config.persistence.maxEvents !== undefined && emitted >= config.persistence.maxEvents)) {
				stopped = true;
				coordinator.markMonitorStopping(sessionId, "stopped");
				sessionManager.getActive(sessionId)?.kill();
			}
		}).catch((error) => {
			console.error(`interactive-shell: monitor callback queue error for ${sessionId}:`, error);
		});
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
	status: "running" | "monitoring" = "running",
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
			const monitorState = coordinator.getMonitorSessionState(id);
			if (monitorState?.status === "running") {
				coordinator.markMonitorStopping(id, "stopped");
			}
			const liveMonitor = coordinator.getMonitor(id);
			if (liveMonitor && !liveMonitor.disposed) {
				session.kill();
				return;
			}
			coordinator.disposeMonitor(id);
			scheduleMonitorHistoryCleanup(id);
			sessionManager.remove(id);
			sessionManager.unregisterActive(id, true);
		},
		background: () => {},
		getOutput: (opts) => getSessionOutput(session, config, queryState, opts, getCompletionOutput()),
		getStatus: () => session.exited ? "exited" : status,
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

function appendWorktreeNotice(text: string, worktreePath: string | undefined): string {
	if (!worktreePath) return text;
	return `${text}\nWorktree left in place: ${worktreePath}`;
}

export default function interactiveShellExtension(pi: ExtensionAPI) {
	const startupConfig = loadConfig(process.cwd());
	let terminalInputCleanup: (() => void) | null = null;
	const loadRuntimeConfig = (cwd: string): InteractiveShellConfig => {
		const config = loadConfig(cwd);
		return {
			...config,
			focusShortcut: startupConfig.focusShortcut,
			spawn: {
				...config.spawn,
				shortcut: startupConfig.spawn.shortcut,
			},
		};
	};
	const disposeStaleMonitor = (id: string, monitor: HeadlessDispatchMonitor | undefined): void => {
		if (!monitor || monitor.disposed) return;
		coordinator.disposeMonitor(id);
		coordinator.clearMonitorEvents(id);
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
	const spawnOverlay = async (ctx: ExtensionContext, request?: SpawnRequest): Promise<void> => {
		if (coordinator.isOverlayOpen()) {
			ctx.ui.notify("An overlay is already open. Close it first.", "error");
			return;
		}

		const config = loadRuntimeConfig(ctx.cwd);
		const spawn = resolveSpawn(config, ctx.cwd, request, () => ctx.sessionManager.getSessionFile());
		if (!spawn.ok) {
			ctx.ui.notify(spawn.error, "error");
			return;
		}

		if (!coordinator.beginOverlay()) {
			ctx.ui.notify(appendWorktreeNotice("An overlay is already open. Close it first.", spawn.spawn.worktreePath), "error");
			return;
		}
		try {
			const result = await ctx.ui.custom<InteractiveShellResult>(
				(tui, theme, _kb, done) =>
					new InteractiveShellOverlay(tui, theme, {
						command: spawn.spawn.command,
						cwd: spawn.spawn.cwd,
						reason: spawn.spawn.reason,
						onUnfocus: () => coordinator.unfocusOverlay(),
					}, config, done),
				createOverlayUiOptions(config),
			);
			if (spawn.spawn.worktreePath) {
				ctx.ui.notify(`Worktree left in place: ${spawn.spawn.worktreePath}`, "info");
			}
			emitTransferredOutput(pi, result);
		} finally {
			coordinator.endOverlay();
		}
	};
	const startNewSession = async (params: {
		ctx: Pick<ExtensionContext, "ui" | "cwd" | "sessionManager"> & { hasUI?: boolean };
		command?: string;
		spawn?: SpawnRequest;
		cwd?: string;
		name?: string;
		reason?: string;
		mode?: "interactive" | "hands-free" | "dispatch" | "monitor";
		background?: boolean;
		handsFree?: ToolParams["handsFree"];
		handoffPreview?: ToolParams["handoffPreview"];
		handoffSnapshot?: ToolParams["handoffSnapshot"];
		timeout?: number;
		monitor?: ToolParams["monitor"];
		onUpdate?: (update: { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }) => void;
	}): Promise<{ content: Array<{ type: "text"; text: string }>; details?: any; isError?: boolean }> => {
		const { ctx, command, spawn, cwd, name, reason, mode, background, handsFree, handoffPreview, handoffSnapshot, timeout, monitor, onUpdate } = params;
		const allowsGeneratedCommand = mode === "monitor" && monitor?.strategy === "file-watch";
		if (!command && !spawn && !allowsGeneratedCommand) {
			return {
				content: [{ type: "text", text: "One of 'command' or 'spawn' is required." }],
				isError: true,
			};
		}

		let effectiveCwd = cwd ?? ctx.cwd;
		const config = loadRuntimeConfig(effectiveCwd);
		const isMonitorMode = mode === "monitor";
		const isNonBlocking = mode === "hands-free" || mode === "dispatch" || isMonitorMode;
		const hasUI = ctx.hasUI !== false;

		if (background && mode !== "dispatch" && mode !== "monitor") {
			return {
				content: [{ type: "text", text: "background: true requires mode='dispatch' or mode='monitor' for new sessions." }],
				isError: true,
			};
		}
		if (!isMonitorMode && !(mode === "dispatch" && background)) {
			if (!hasUI) {
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
		}

		let effectiveCommand = command;
		let effectiveReason = reason;
		let spawnWorktreePath: string | undefined;
		let spawnAgent: string | undefined;
		let spawnMode: string | undefined;
		if (spawn) {
			const resolvedSpawn = resolveSpawn(config, effectiveCwd, spawn, () => ctx.sessionManager.getSessionFile());
			if (!resolvedSpawn.ok) {
				return {
					content: [{ type: "text", text: resolvedSpawn.error }],
					isError: true,
				};
			}
			effectiveCommand = resolvedSpawn.spawn.command;
			effectiveCwd = resolvedSpawn.spawn.cwd;
			effectiveReason = effectiveReason
				? `${effectiveReason} • ${resolvedSpawn.spawn.reason}`
				: resolvedSpawn.spawn.reason;
			spawnWorktreePath = resolvedSpawn.spawn.worktreePath;
			spawnAgent = resolvedSpawn.spawn.agent;
			spawnMode = resolvedSpawn.spawn.mode;
		}
		const expectsGeneratedCommand = isMonitorMode && monitor?.strategy === "file-watch";
		if (!effectiveCommand && !expectsGeneratedCommand) {
			return {
				content: [{ type: "text", text: "Failed to resolve the command to launch." }],
				isError: true,
			};
		}

		if (isMonitorMode) {
			const compiledMonitor = compileMonitorConfig(monitor);
			if (!compiledMonitor.ok) {
				return {
					content: [{ type: "text", text: compiledMonitor.error }],
					isError: true,
				};
			}

			const id = generateSessionId(name);
			const sessionCommand = compiledMonitor.compiled.runtime.strategy === "file-watch"
				? `file-watch ${compiledMonitor.compiled.fileWatch?.path ?? "<unknown>"}`
				: effectiveCommand!;
			const monitorCommand = compiledMonitor.compiled.runtime.strategy === "poll-diff"
				? buildPollDiffLoopCommand(sessionCommand, compiledMonitor.compiled.runtime.pollIntervalMs)
				: compiledMonitor.compiled.runtime.strategy === "file-watch"
					? buildFileWatchCommand(compiledMonitor.compiled.fileWatch!)
					: sessionCommand;
			const session = new PtyTerminalSession(
				{ command: monitorCommand, cwd: effectiveCwd, cols: 120, rows: 40, scrollback: config.scrollbackLines },
			);
			const startTime = Date.now();
			sessionManager.add(sessionCommand, session, name, effectiveReason, { id, noAutoCleanup: true, startedAt: new Date(startTime) });

			coordinator.registerMonitorSession(id, compiledMonitor.compiled.publicConfig, new Date(startTime));
			const monitorRunner = new HeadlessDispatchMonitor(session, config, {
				autoExitOnQuiet: handsFree?.autoExitOnQuiet === true,
				quietThreshold: handsFree?.quietThreshold ?? config.handsFreeQuietThreshold,
				gracePeriod: handsFree?.gracePeriod ?? config.autoExitGracePeriod,
				timeout,
				startedAt: startTime,
				monitor: compiledMonitor.compiled.runtime,
				onMonitorEvent: makeMonitorEventCallback(pi, id, compiledMonitor.compiled, effectiveCwd),
			}, makeStructuredMonitorCompletionCallback(pi, id));
			registerHeadlessActive(id, sessionCommand, effectiveReason, session, monitorRunner, startTime, config, "monitoring");

			return {
				content: [{ type: "text", text: appendWorktreeNotice(`Monitor started in background (id: ${id}).\nStrategy: ${compiledMonitor.compiled.publicConfig.strategy ?? "stream"}\nTriggers: ${compiledMonitor.compiled.publicConfig.triggers.map((trigger) => trigger.id).join(", ")}\nYou'll be notified when a trigger emits an event.`, spawnWorktreePath) }],
				details: { sessionId: id, backgroundId: id, mode: "monitor", monitor: compiledMonitor.compiled.publicConfig, background: true, spawnAgent, spawnMode, spawnWorktreePath },
			};
		}

		if (mode === "dispatch" && background) {
			const id = generateSessionId(name);
			const session = new PtyTerminalSession(
				{ command: effectiveCommand, cwd: effectiveCwd, cols: 120, rows: 40, scrollback: config.scrollbackLines },
			);

			const startTime = Date.now();
			sessionManager.add(effectiveCommand, session, name, effectiveReason, { id, noAutoCleanup: true, startedAt: new Date(startTime) });

			const monitor = new HeadlessDispatchMonitor(session, config, {
				autoExitOnQuiet: handsFree?.autoExitOnQuiet !== false,
				quietThreshold: handsFree?.quietThreshold ?? config.handsFreeQuietThreshold,
				gracePeriod: handsFree?.gracePeriod ?? config.autoExitGracePeriod,
				timeout,
				startedAt: startTime,
			}, makeMonitorCompletionCallback(pi, id, startTime));
			registerHeadlessActive(id, effectiveCommand, effectiveReason, session, monitor, startTime, config);

			return {
				content: [{ type: "text", text: appendWorktreeNotice(`Session dispatched in background (id: ${id}).\nYou'll be notified when it completes. User can /attach ${id} to watch.`, spawnWorktreePath) }],
				details: { sessionId: id, backgroundId: id, mode: "dispatch", background: true, spawnAgent, spawnMode, spawnWorktreePath },
			};
		}

		const generatedSessionId = isNonBlocking ? generateSessionId(name) : undefined;
		if (isNonBlocking && generatedSessionId) {
			if (!coordinator.beginOverlay()) {
				return {
					content: [{ type: "text", text: appendWorktreeNotice("An interactive shell overlay is already open. Wait for it to close or kill the active session before starting a new one.", spawnWorktreePath) }],
					isError: true,
					details: { error: "overlay_already_open", spawnAgent, spawnMode, spawnWorktreePath },
				};
			}
			const overlayStartTime = Date.now();

			let overlayPromise: Promise<InteractiveShellResult>;
			try {
				overlayPromise = ctx.ui.custom<InteractiveShellResult>(
					(tui, theme, _kb, done) =>
						new InteractiveShellOverlay(tui, theme, {
							command: effectiveCommand,
							cwd: effectiveCwd,
							name,
							reason: effectiveReason,
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
				mode,
				command: effectiveCommand,
				reason: effectiveReason,
				timeout,
				handsFree,
				overlayStartTime,
			});

			if (mode === "dispatch") {
				return {
					content: [{ type: "text", text: appendWorktreeNotice(`Session dispatched (id: ${generatedSessionId}).\nYou'll be notified when it completes.\nYou can still query with interactive_shell({ sessionId: "${generatedSessionId}" }) if needed.`, spawnWorktreePath) }],
					details: { sessionId: generatedSessionId, status: "running", command: effectiveCommand, reason: effectiveReason, mode, spawnAgent, spawnMode, spawnWorktreePath },
				};
			}
			return {
				content: [{ type: "text", text: appendWorktreeNotice(`Session started: ${generatedSessionId}\nCommand: ${effectiveCommand}\n\nUse interactive_shell({ sessionId: "${generatedSessionId}" }) to check status/output.\nUse interactive_shell({ sessionId: "${generatedSessionId}", kill: true }) to end when done.`, spawnWorktreePath) }],
				details: { sessionId: generatedSessionId, status: "running", command: effectiveCommand, reason: effectiveReason, spawnAgent, spawnMode, spawnWorktreePath },
			};
		}

		if (!coordinator.beginOverlay()) {
			return {
				content: [{ type: "text", text: appendWorktreeNotice("An interactive shell overlay is already open. Wait for it to close or kill the active session before starting a new one.", spawnWorktreePath) }],
				isError: true,
				details: { error: "overlay_already_open", spawnAgent, spawnMode, spawnWorktreePath },
			};
		}
		onUpdate?.({
			content: [{ type: "text", text: appendWorktreeNotice(`Opening: ${effectiveCommand}`, spawnWorktreePath) }],
			details: { exitCode: null, backgrounded: false, cancelled: false },
		});

		let result: InteractiveShellResult;
		try {
			result = await ctx.ui.custom<InteractiveShellResult>(
				(tui, theme, _kb, done) =>
					new InteractiveShellOverlay(tui, theme, {
						command: effectiveCommand,
						cwd: effectiveCwd,
						name,
						reason: effectiveReason,
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

		return {
			content: [{ type: "text", text: appendWorktreeNotice(summarizeInteractiveResult(effectiveCommand, result, timeout, effectiveReason), spawnWorktreePath) }],
			details: { ...result, spawnAgent, spawnMode, spawnWorktreePath },
		};
	};
	pi.registerShortcut(startupConfig.focusShortcut, {
		description: "Focus interactive shell overlay",
		handler: () => {
			coordinator.focusOverlay();
		},
	});
	pi.registerShortcut(startupConfig.spawn.shortcut, {
		description: "Spawn the configured default agent in a fresh interactive shell overlay",
		handler: (ctx) => spawnOverlay(ctx),
	});

	pi.on("session_start", (_event, ctx) => {
		coordinator.replaceBackgroundWidgetCleanup(setupBackgroundWidget(ctx, sessionManager, coordinator));
		terminalInputCleanup?.();
		terminalInputCleanup = ctx.ui.onTerminalInput((data) => {
			if (!coordinator.isOverlayOpen()) return undefined;
			if (isKeyRelease(data) || isKeyRepeat(data)) {
				return undefined;
			}
			if (matchesKey(data, startupConfig.focusShortcut)) {
				if (coordinator.isOverlayFocused()) {
					coordinator.unfocusOverlay();
				} else {
					coordinator.focusOverlay();
				}
				return { consume: true };
			}
			if (matchesKey(data, SIDE_CHAT_SHORTCUT)) {
				ctx.ui.notify("Close pi-interactive-shell first.", "warning");
				return { consume: true };
			}
			return undefined;
		});
	});

	pi.on("session_shutdown", () => {
		terminalInputCleanup?.();
		terminalInputCleanup = null;
		coordinator.clearBackgroundWidget();
		sessionManager.killAll();
		coordinator.disposeAllMonitors();
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: TOOL_LABEL,
		description: TOOL_DESCRIPTION,
		promptSnippet:
			"Use this only to delegate tasks to interactive CLI coding agents (pi/claude/gemini/codex/aider). Prefer mode='dispatch' for fire-and-forget delegations. When sending slash commands or prompts to an existing session, use submit=true so the text is actually submitted.",
		parameters: toolParameters,

		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			const {
				command,
				spawn,
				sessionId,
				kill,
				outputLines,
				outputMaxChars,
				outputOffset,
				drain,
				incremental,
				settings,
				input,
				submit,
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
				monitorEvents,
				monitorStatus,
				monitorSessionId,
				monitorEventLimit,
				monitorEventOffset,
				monitorSinceEventId,
				monitorTriggerId,
				handsFree,
				handoffPreview,
				handoffSnapshot,
				timeout,
				monitor,
			} = params as ToolParams;

			const hasStructuredInput = inputKeys?.length || inputHex?.length || inputPaste;
			const effectiveInput = hasStructuredInput
				? { text: input, keys: inputKeys, hex: inputHex, paste: inputPaste }
				: input;

			if (spawn && command) {
				return {
					content: [{ type: "text", text: "Use either 'command' or 'spawn', not both." }],
					isError: true,
				};
			}
			if (spawn && (sessionId || attach || listBackground || dismissBackground || monitorEvents || monitorStatus)) {
				return {
					content: [{ type: "text", text: "'spawn' is only valid when starting a new session." }],
					isError: true,
				};
			}

			if ((params as { monitorFilter?: unknown }).monitorFilter !== undefined) {
				return {
					content: [{ type: "text", text: "monitorFilter was removed. Use mode='monitor' with a structured monitor object." }],
					isError: true,
				};
			}

			if (monitorStatus) {
				const targetMonitorSessionId = monitorSessionId ?? sessionId;
				if (!targetMonitorSessionId) {
					return {
						content: [{ type: "text", text: "monitorStatus requires monitorSessionId (or sessionId)." }],
						isError: true,
					};
				}

				const state = coordinator.getMonitorSessionState(targetMonitorSessionId);
				if (!state) {
					return {
						content: [{ type: "text", text: `No monitor state for session ${targetMonitorSessionId}.` }],
						details: { sessionId: targetMonitorSessionId, state: null },
					};
				}

				const summary = [
					`Monitor state for ${targetMonitorSessionId}`,
					`Status: ${state.status}`,
					`Strategy: ${state.strategy}`,
					`Triggers: ${state.triggerIds.join(", ") || "(none)"}`,
					`Events: ${state.eventCount}`,
					`Started: ${state.startedAt}`,
					state.lastEventAt ? `Last event: #${state.lastEventId} at ${state.lastEventAt}` : "Last event: none",
					state.terminalReason ? `Terminal reason: ${state.terminalReason}` : "Terminal reason: (running)",
				].join("\n");

				return {
					content: [{ type: "text", text: summary }],
					details: { sessionId: targetMonitorSessionId, state },
				};
			}

			if (monitorEvents) {
				const targetMonitorSessionId = monitorSessionId ?? sessionId;
				if (!targetMonitorSessionId) {
					return {
						content: [{ type: "text", text: "monitorEvents requires monitorSessionId (or sessionId)." }],
						isError: true,
					};
				}

				const history = coordinator.getMonitorEvents(targetMonitorSessionId, {
					limit: monitorEventLimit,
					offset: monitorEventOffset,
					sinceEventId: monitorSinceEventId,
					triggerId: monitorTriggerId,
				});
				const state = coordinator.getMonitorSessionState(targetMonitorSessionId);
				if (history.total === 0) {
					return {
						content: [{ type: "text", text: `No monitor events for session ${targetMonitorSessionId}.` }],
						details: {
							sessionId: targetMonitorSessionId,
							events: [],
							total: 0,
							limit: history.limit,
							offset: history.offset,
							sinceEventId: history.sinceEventId,
							triggerId: history.triggerId,
							state,
						},
					};
				}

				const lines = history.events.map((event) =>
					`#${event.eventId} [${event.strategy}/${event.triggerId}] ${event.timestamp} :: ${event.matchedText}`,
				);
				return {
					content: [{
						type: "text",
						text: `Monitor events for ${targetMonitorSessionId} (${history.events.length}/${history.total}, offset ${history.offset}):\n${lines.join("\n")}`,
					}],
					details: {
						sessionId: targetMonitorSessionId,
						events: history.events,
						total: history.total,
						limit: history.limit,
						offset: history.offset,
						sinceEventId: history.sinceEventId,
						triggerId: history.triggerId,
						state,
					},
				};
			}

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

				if (effectiveInput !== undefined || submit) {
					const translatedInput = effectiveInput !== undefined ? translateInput(effectiveInput) : "";
					const finalInput = submit ? `${translatedInput}\r` : translatedInput;
					const success = sessionManager.writeToActive(sessionId, finalInput);
					if (!success) {
						return {
							content: [{ type: "text", text: `Failed to send input to session: ${sessionId}` }],
							isError: true,
							details: { sessionId, error: "write_failed" },
						};
					}
					const inputDesc = effectiveInput === undefined
						? ""
						: typeof effectiveInput === "string"
							? effectiveInput.length === 0 ? "(empty)" : effectiveInput.length > 50 ? `${effectiveInput.slice(0, 50)}...` : effectiveInput
							: [effectiveInput.text ?? "", effectiveInput.keys ? `keys:[${effectiveInput.keys.join(",")}]` : "", effectiveInput.hex ? `hex:[${effectiveInput.hex.length} bytes]` : "", effectiveInput.paste ? `paste:[${effectiveInput.paste.length} chars]` : ""].filter(Boolean).join(" + ") || "(empty)";
					if (submit) {
						actions.push(inputDesc ? `sent: ${inputDesc} + enter` : "sent: enter");
					} else {
						actions.push(`sent: ${inputDesc}`);
					}
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
					const monitorState = coordinator.getMonitorSessionState(s.id);
					const status = s.session.exited ? "exited" : "running";
					const duration = formatDuration(Date.now() - s.startedAt.getTime());
					const r = s.reason ? ` \u2022 ${s.reason}` : "";
					const monitorLabel = monitorState
						? ` \u2022 monitor:${monitorState.strategy} events=${monitorState.eventCount}${monitorState.lastEventAt ? ` last=${monitorState.lastEventAt}` : ""}`
						: "";
					return `  ${s.id} - ${s.command}${r}${monitorLabel} (${status}, ${duration})`;
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
					coordinator.clearMonitorEvents(tid);
					sessionManager.unregisterActive(tid, false);
					sessionManager.remove(tid);
				}

				const summary = targetIds.length === 1
					? `Dismissed session ${targetIds[0]}.`
					: `Dismissed ${targetIds.length} sessions: ${targetIds.join(", ")}.`;
				return { content: [{ type: "text", text: summary }] };
			}

			// ── Branch 4: Start new session ──
			const allowsGeneratedCommand = mode === "monitor" && monitor?.strategy === "file-watch";
			if (!command && !spawn && !allowsGeneratedCommand) {
				return {
					content: [{ type: "text", text: "One of 'command', 'spawn', 'sessionId', 'attach', 'listBackground', or 'dismissBackground' is required." }],
					isError: true,
				};
			}
			return startNewSession({
				ctx,
				command,
				spawn,
				cwd,
				name,
				reason,
				mode,
				background,
				monitor,
				handsFree,
				handoffPreview,
				handoffSnapshot,
				timeout,
				onUpdate,
			});
		},
	});

	pi.registerCommand("spawn", {
		description: "Spawn the configured default agent, pi, codex, claude, or agent in an interactive shell overlay",
		handler: async (args, ctx) => {
			const parsed = parseSpawnArgs(args);
			if (!parsed.ok) {
				ctx.ui.notify(`${parsed.error}\nUsage: /spawn [pi|codex|claude|agent] [fresh|fork] [--worktree] [\"prompt\" --hands-free|--dispatch]`, "error");
				return;
			}
			if (parsed.parsed.monitorMode) {
				const result = await startNewSession({
					ctx,
					spawn: parsed.parsed.request,
					mode: parsed.parsed.monitorMode,
				});
				if (result.isError) {
					ctx.ui.notify(result.content[0]?.text ?? "Failed to start session.", "error");
				}
				return;
			}
			await spawnOverlay(ctx, parsed.parsed.request);
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
				coordinator.clearMonitorEvents(tid);
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

			const bgId = result.backgroundId!;
			const existingMonitor = coordinator.getMonitor(id);
			const bgSession = sessionManager.get(bgId);
			if (!bgSession) {
				sessionManager.unregisterActive(id, true);
				coordinator.disposeMonitor(id);
				return;
			}

			sessionManager.unregisterActive(id, bgId !== id);

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
