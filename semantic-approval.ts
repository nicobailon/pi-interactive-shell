export const DEFAULT_APPROVAL_TTL_MS = 30_000;
export const MAX_APPROVAL_TTL_MS = 60_000;

/** The exact process and observation for which a human decision is requested. */
export interface SemanticApprovalBinding {
	readonly sessionId: string;
	readonly operationId: string;
	readonly observationGeneration: number;
	readonly observationHash: string;
}

export interface PendingSemanticApproval extends SemanticApprovalBinding {
	readonly requestId: string;
	readonly expiresAt: number;
}

export type TrustedUiApprovalDecision = Readonly<{
	requestId: string;
	decision: "approve" | "reject";
}>;

/**
 * This port is the trust boundary. Its listener must only be called by an
 * explicit, real-human UI gesture; model output and tool arguments must never
 * be forwarded to it.
 */
export interface TrustedApprovalUi {
	isAvailable(): boolean;
	subscribe(listener: (decision: TrustedUiApprovalDecision) => void): () => void;
}

export interface SemanticApprovalOptions {
	readonly now?: () => number;
	readonly createRequestId?: () => string;
	readonly maxTtlMs?: number;
}

export interface SemanticApprovalState {
	request(binding: SemanticApprovalBinding, ttlMs?: number): PendingSemanticApproval | undefined;
	consume(requestId: string, binding: SemanticApprovalBinding): boolean;
	cancel(requestId: string): boolean;
	invalidateSession(sessionId: string, reason: "takeover" | "exit"): number;
	dispose(): void;
}

type ApprovalRecord = {
	binding: SemanticApprovalBinding;
	expiresAt: number;
	approved: boolean;
};

/**
 * Creates process-local, one-shot approval state. Approval can enter the state
 * only through the listener handed to `trustedUi`; the returned state exposes
 * no approval transition.
 */
export function createSemanticApprovalState(
	trustedUi: TrustedApprovalUi,
	options: SemanticApprovalOptions = {},
): SemanticApprovalState {
	const now = options.now ?? Date.now;
	const maxTtlMs = options.maxTtlMs ?? MAX_APPROVAL_TTL_MS;
	if (!Number.isSafeInteger(maxTtlMs) || maxTtlMs <= 0) throw new RangeError("maxTtlMs must be a positive safe integer");

	const records = new Map<string, ApprovalRecord>();
	let sequence = 0;
	let connected = false;
	let disposed = false;
	let unsubscribe: (() => void) | undefined;

	const currentTime = (): number | undefined => {
		const value = now();
		return Number.isFinite(value) ? value : undefined;
	};
	const uiAvailable = (): boolean => {
		if (!connected || disposed) return false;
		try {
			return trustedUi.isAvailable() === true;
		} catch {
			return false;
		}
	};
	const expire = (requestId: string, record: ApprovalRecord, time: number): boolean => {
		if (time < record.expiresAt) return false;
		records.delete(requestId);
		return true;
	};
	const onTrustedDecision = (decision: TrustedUiApprovalDecision): void => {
		if (!uiAvailable() || !decision || typeof decision.requestId !== "string") return;
		const record = records.get(decision.requestId);
		const time = currentTime();
		if (!record || time === undefined || expire(decision.requestId, record, time)) return;
		if (decision.decision === "approve") record.approved = true;
		else if (decision.decision === "reject") records.delete(decision.requestId);
	};

	try {
		const cleanup = trustedUi.subscribe(onTrustedDecision);
		if (typeof cleanup === "function") {
			unsubscribe = cleanup;
			connected = true;
		}
	} catch {
		// A missing or broken UI is an unavailable UI, never an authorization.
	}

	const requestId = (): string | undefined => {
		const candidate = options.createRequestId?.() ?? `semantic-approval-${++sequence}`;
		if (typeof candidate !== "string" || candidate.length === 0 || records.has(candidate)) return undefined;
		return candidate;
	};

	return {
		request(binding, ttlMs = DEFAULT_APPROVAL_TTL_MS) {
			if (!uiAvailable() || !validBinding(binding) || !Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > maxTtlMs) return undefined;
			const time = currentTime();
			const id = requestId();
			if (time === undefined || id === undefined || !Number.isSafeInteger(time + ttlMs)) return undefined;
			const exactBinding = Object.freeze({ ...binding });
			const pending = Object.freeze({ ...exactBinding, requestId: id, expiresAt: time + ttlMs });
			records.set(id, { binding: exactBinding, expiresAt: pending.expiresAt, approved: false });
			return pending;
		},
		consume(id, binding) {
			const record = records.get(id);
			if (!record) return false;
			const time = currentTime();
			if (time === undefined || !uiAvailable() || expire(id, record, time)) {
				records.delete(id);
				return false;
			}
			if (!sameBinding(record.binding, binding)) {
				records.delete(id);
				return false;
			}
			if (!record.approved) return false;
			records.delete(id);
			return true;
		},
		cancel(id) {
			return records.delete(id);
		},
		invalidateSession(sessionId, _reason) {
			let invalidated = 0;
			for (const [id, record] of records) {
				if (record.binding.sessionId !== sessionId) continue;
				records.delete(id);
				invalidated++;
			}
			return invalidated;
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			connected = false;
			records.clear();
			try { unsubscribe?.(); } catch { /* Disposal remains fail-closed. */ }
		},
	};
}

function validBinding(binding: SemanticApprovalBinding): boolean {
	return binding !== null
		&& typeof binding === "object"
		&& typeof binding.sessionId === "string" && binding.sessionId.length > 0
		&& typeof binding.operationId === "string" && binding.operationId.length > 0
		&& Number.isSafeInteger(binding.observationGeneration) && binding.observationGeneration >= 0
		&& typeof binding.observationHash === "string" && binding.observationHash.length > 0;
}

function sameBinding(left: SemanticApprovalBinding, right: SemanticApprovalBinding): boolean {
	return validBinding(right)
		&& left.sessionId === right.sessionId
		&& left.operationId === right.operationId
		&& left.observationGeneration === right.observationGeneration
		&& left.observationHash === right.observationHash;
}
