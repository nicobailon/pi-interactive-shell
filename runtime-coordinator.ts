import type { HeadlessDispatchMonitor } from "./headless-monitor.js";

/** Centralizes overlay, monitor, widget, and completion-suppression state for the extension runtime. */
export class InteractiveShellCoordinator {
	private overlayOpen = false;
	private headlessMonitors = new Map<string, HeadlessDispatchMonitor>();
	private bgWidgetCleanup: (() => void) | null = null;
	private agentHandledCompletion = new Set<string>();

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
	}

	replaceBackgroundWidgetCleanup(cleanup: (() => void) | null): void {
		this.bgWidgetCleanup?.();
		this.bgWidgetCleanup = cleanup;
	}

	clearBackgroundWidget(): void {
		this.bgWidgetCleanup?.();
		this.bgWidgetCleanup = null;
	}
}
