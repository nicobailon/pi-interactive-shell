import type { OverlayHandle } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HeadlessDispatchMonitor } from "./headless-monitor.ts";
import type { MonitorConfig, MonitorEventPayload, MonitorSessionState, MonitorTerminalReason, SemanticDecision, SemanticDecisionInput, SemanticSessionState } from "./types.ts";

const MONITOR_HISTORY_LIMIT = 200;
const SEMANTIC_HISTORY_LIMIT = 200;
const GLOBAL_SEMANTIC_ACTION_LIMIT = 10;

export interface MonitorEventsQueryResult {
	events: MonitorEventPayload[];
	total: number;
	limit: number;
	offset: number;
	sinceEventId?: number;
	triggerId?: string;
}

export interface SemanticDecisionsQueryResult {
	decisions: SemanticDecision[];
	total: number;
	limit: number;
	offset: number;
}

/** Centralizes overlay, monitor, widget, and completion-suppression state for the extension runtime. */
export class InteractiveShellCoordinator {
	private overlayOpen = false;
	private overlayHandle: OverlayHandle | null = null;
	private headlessMonitors = new Map<string, HeadlessDispatchMonitor>();
	private monitorEventHistory = new Map<string, MonitorEventPayload[]>();
	private monitorEventCounters = new Map<string, number>();
	private monitorSessionState = new Map<string, MonitorSessionState>();
	private pendingMonitorReason = new Map<string, MonitorTerminalReason>();
	private bgWidgetCleanup: (() => void) | null = null;
	private agentHandledCompletion = new Set<string>();
	private extensionApi: ExtensionAPI | null = null;
	private pendingApiTasks: Array<(pi: ExtensionAPI) => void> = [];
	private semanticHistory = new Map<string, SemanticDecision[]>();
	private semanticCounters = new Map<string, number>();
	private semanticState = new Map<string, SemanticSessionState>();
	private runtimeEpoch = 0;
	private semanticActionAttempts = 0;

	bindExtensionApi(pi: ExtensionAPI): void {
		if (this.extensionApi === pi) return;
		this.runtimeEpoch += 1;
		const epoch = this.runtimeEpoch;
		for (const monitor of this.headlessMonitors.values()) {
			monitor.rebindSemanticEpoch(() => this.runtimeEpoch === epoch);
		}
		this.extensionApi = pi;
		const pending = this.pendingApiTasks.splice(0);
		for (const task of pending) task(pi);
	}

	getRuntimeEpoch(): number { return this.runtimeEpoch; }
	isRuntimeEpochCurrent(epoch: number): boolean { return epoch === this.runtimeEpoch; }

	reserveSemanticActionAttempt(): boolean {
		if (this.semanticActionAttempts >= GLOBAL_SEMANTIC_ACTION_LIMIT) return false;
		this.semanticActionAttempts += 1;
		return true;
	}

	getSemanticActionAttempts(): number { return this.semanticActionAttempts; }

	ensureReloadState(): void {
		if (!Number.isSafeInteger(this.semanticActionAttempts) || this.semanticActionAttempts < 0) this.semanticActionAttempts = 0;
	}

	unbindExtensionApi(pi: ExtensionAPI): void {
		if (this.extensionApi !== pi) return;
		this.extensionApi = null;
		this.runtimeEpoch += 1;
		for (const monitor of this.headlessMonitors.values()) {
			monitor.pauseSemantic();
		}
	}

	runWithExtensionApi(task: (pi: ExtensionAPI) => void): void {
		if (this.extensionApi) {
			task(this.extensionApi);
			return;
		}
		this.pendingApiTasks.push(task);
	}

	clearPendingApiTasks(): void {
		this.pendingApiTasks = [];
	}

	isOverlayOpen(): boolean {
		return this.overlayOpen;
	}

	beginOverlay(): boolean {
		if (this.overlayOpen) return false;
		this.overlayOpen = true;
		return true;
	}

	endOverlay(): void {
		this.overlayOpen = false;
		this.clearOverlayHandle();
	}

	focusOverlay(): void {
		this.overlayHandle?.focus();
	}

	unfocusOverlay(): void {
		this.overlayHandle?.unfocus();
	}

	isOverlayFocused(): boolean {
		return this.overlayHandle?.isFocused() === true;
	}

	setOverlayHandle(handle: OverlayHandle): void {
		this.overlayHandle = handle;
	}

	clearOverlayHandle(): void {
		this.overlayHandle = null;
	}

	markAgentHandledCompletion(sessionId: string): void {
		this.agentHandledCompletion.add(sessionId);
	}

	consumeAgentHandledCompletion(sessionId: string): boolean {
		const had = this.agentHandledCompletion.has(sessionId);
		this.agentHandledCompletion.delete(sessionId);
		return had;
	}

	setMonitor(id: string, monitor: HeadlessDispatchMonitor): void {
		this.headlessMonitors.set(id, monitor);
	}

	getMonitor(id: string): HeadlessDispatchMonitor | undefined {
		return this.headlessMonitors.get(id);
	}

	deleteMonitor(id: string): void {
		this.headlessMonitors.delete(id);
	}

	registerMonitorSession(sessionId: string, monitor: MonitorConfig, startedAt: Date): MonitorSessionState {
		const state: MonitorSessionState = {
			sessionId,
			strategy: monitor.strategy ?? "stream",
			triggerIds: (monitor.triggers ?? []).map((trigger) => trigger.id),
			status: "running",
			eventCount: 0,
			startedAt: startedAt.toISOString(),
		};
		this.monitorSessionState.set(sessionId, state);
		return state;
	}

	markMonitorStopping(sessionId: string, reason: MonitorTerminalReason = "stopped"): void {
		this.pendingMonitorReason.set(sessionId, reason);
	}

	consumePendingMonitorReason(sessionId: string): MonitorTerminalReason | undefined {
		const reason = this.pendingMonitorReason.get(sessionId);
		this.pendingMonitorReason.delete(sessionId);
		return reason;
	}

	finalizeMonitorSession(
		sessionId: string,
		result: { exitCode: number | null; signal?: number },
		reason: MonitorTerminalReason,
	): MonitorSessionState | undefined {
		const current = this.monitorSessionState.get(sessionId);
		if (!current) return undefined;
		const finalized: MonitorSessionState = {
			...current,
			status: "stopped",
			endedAt: new Date().toISOString(),
			terminalReason: reason,
			exitCode: result.exitCode,
			signal: result.signal,
		};
		this.monitorSessionState.set(sessionId, finalized);
		this.pendingMonitorReason.delete(sessionId);
		return finalized;
	}

	getMonitorSessionState(sessionId: string): MonitorSessionState | undefined {
		return this.monitorSessionState.get(sessionId);
	}

	recordMonitorEvent(event: Omit<MonitorEventPayload, "eventId" | "timestamp">): MonitorEventPayload {
		const nextId = (this.monitorEventCounters.get(event.sessionId) ?? 0) + 1;
		this.monitorEventCounters.set(event.sessionId, nextId);

		const recorded: MonitorEventPayload = {
			...event,
			eventId: nextId,
			timestamp: new Date().toISOString(),
		};

		const existing = this.monitorEventHistory.get(event.sessionId) ?? [];
		existing.push(recorded);
		if (existing.length > MONITOR_HISTORY_LIMIT) {
			existing.splice(0, existing.length - MONITOR_HISTORY_LIMIT);
		}
		this.monitorEventHistory.set(event.sessionId, existing);

		const currentState = this.monitorSessionState.get(event.sessionId);
		if (currentState) {
			this.monitorSessionState.set(event.sessionId, {
				...currentState,
				eventCount: nextId,
				lastEventId: recorded.eventId,
				lastEventAt: recorded.timestamp,
				lastTriggerId: recorded.triggerId,
			});
		}

		return recorded;
	}

	getMonitorEvents(sessionId: string, options?: { limit?: number; offset?: number; sinceEventId?: number; triggerId?: string }): MonitorEventsQueryResult {
		let events = this.monitorEventHistory.get(sessionId) ?? [];
		const sinceEventId = options?.sinceEventId !== undefined ? Math.max(0, Math.trunc(options.sinceEventId)) : undefined;
		if (sinceEventId !== undefined) {
			events = events.filter((event) => event.eventId > sinceEventId);
		}
		const triggerId = options?.triggerId?.trim();
		if (triggerId) {
			events = events.filter((event) => event.triggerId === triggerId);
		}
		const total = events.length;
		const limit = Math.max(1, Math.trunc(options?.limit ?? 20));
		const offset = Math.max(0, Math.trunc(options?.offset ?? 0));
		const end = Math.max(0, total - offset);
		const start = Math.max(0, end - limit);
		return {
			events: events.slice(start, end),
			total,
			limit,
			offset,
			sinceEventId,
			triggerId,
		};
	}

	clearMonitorEvents(sessionId: string): void {
		this.monitorEventHistory.delete(sessionId);
		this.monitorEventCounters.delete(sessionId);
		this.monitorSessionState.delete(sessionId);
		this.pendingMonitorReason.delete(sessionId);
	}

	recordSemanticDecision(sessionId: string, decision: SemanticDecisionInput): SemanticDecision {
		const decisionId = (this.semanticCounters.get(sessionId) ?? 0) + 1;
		this.semanticCounters.set(sessionId, decisionId);
		const metadata = { sessionId, decisionId, timestamp: new Date().toISOString() };
		let recorded: SemanticDecision;
		switch (decision.kind) {
			case "observation":
				recorded = { ...decision, ...metadata };
				break;
			case "evaluator-error":
				recorded = { ...decision, ...metadata };
				break;
			case "skipped":
				recorded = { ...decision, ...metadata };
				break;
		}
		const history = this.semanticHistory.get(sessionId) ?? [];
		history.push(recorded);
		if (history.length > SEMANTIC_HISTORY_LIMIT) history.splice(0, history.length - SEMANTIC_HISTORY_LIMIT);
		this.semanticHistory.set(sessionId, history);
		const state = this.semanticState.get(sessionId);
		if (state) this.semanticState.set(sessionId, { ...state, decisionCount: decisionId, lastDecisionId: decisionId, lastDecisionAt: recorded.timestamp });
		return recorded;
	}

	registerSemanticSession(sessionId: string, startedAt: Date): SemanticSessionState {
		const state: SemanticSessionState = { sessionId, status: "running", decisionCount: 0, startedAt: startedAt.toISOString() };
		this.semanticState.set(sessionId, state);
		return state;
	}

	setSemanticSessionStatus(sessionId: string, status: SemanticSessionState["status"]): void {
		const state = this.semanticState.get(sessionId);
		if (state) this.semanticState.set(sessionId, { ...state, status });
	}

	getSemanticSessionState(sessionId: string): SemanticSessionState | undefined { return this.semanticState.get(sessionId); }

	getSemanticDecisions(sessionId: string, options?: { limit?: number; offset?: number }): SemanticDecisionsQueryResult {
		const history = this.semanticHistory.get(sessionId) ?? [];
		const limit = Math.max(1, Math.min(200, Math.trunc(options?.limit ?? 20)));
		const offset = Math.max(0, Math.trunc(options?.offset ?? 0));
		const newestFirst = [...history].reverse();
		return { decisions: newestFirst.slice(offset, offset + limit), total: history.length, limit, offset };
	}

	clearSemanticDecisions(sessionId: string): void {
		this.semanticHistory.delete(sessionId);
		this.semanticCounters.delete(sessionId);
		this.semanticState.delete(sessionId);
	}

	disposeMonitor(id: string): void {
		const monitor = this.headlessMonitors.get(id);
		if (!monitor) return;
		monitor.dispose();
		this.headlessMonitors.delete(id);
	}

	disposeAllMonitors(): void {
		for (const monitor of this.headlessMonitors.values()) {
			monitor.dispose();
		}
		this.headlessMonitors.clear();
		this.semanticActionAttempts = 0;
	}

	replaceBackgroundWidgetCleanup(cleanup: (() => void) | null): void {
		const previous = this.bgWidgetCleanup;
		this.bgWidgetCleanup = cleanup;
		previous?.();
	}

	clearBackgroundWidget(): void {
		const previous = this.bgWidgetCleanup;
		this.bgWidgetCleanup = null;
		previous?.();
	}
}
