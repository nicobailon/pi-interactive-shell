import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createSemanticApprovalState, type SemanticApprovalBinding, type TrustedUiApprovalDecision } from "./semantic-approval.ts";
import type { CompiledSemanticPermissions } from "./semantic-permissions.ts";
import type { SemanticOption } from "./semantic-options.ts";

export interface SemanticChoiceAuthorization {
	request(binding: SemanticApprovalBinding, operation: SemanticOption["operation"], label: string, complete: (approved: boolean) => void): void;
	dispose(): void;
}

export function createSemanticChoiceAuthorization(options: {
	permissions: CompiledSemanticPermissions;
	ui: Pick<ExtensionUIContext, "confirm">;
	isAvailable: () => boolean;
}): SemanticChoiceAuthorization {
	let listener: ((decision: TrustedUiApprovalDecision) => void) | undefined;
	let disposed = false;
	const approval = createSemanticApprovalState({
		isAvailable: () => !disposed && options.isAvailable(),
		subscribe(next) { listener = next; return () => { listener = undefined; }; },
	});

	return {
		request(binding, operation, label, complete) {
			if (disposed) { complete(false); return; }
			const decision = options.permissions.evaluate(operation);
			if (decision === "deny") { complete(false); return; }
			if (decision === "allow") { queueMicrotask(() => complete(!disposed)); return; }
			if (!options.isAvailable()) { complete(false); return; }
			const pending = approval.request(binding);
			if (!pending) { complete(false); return; }
			void options.ui.confirm(
				"Allow semantic terminal choice?",
				`Choose the currently visible option “${label}” once?`,
			).then((approved) => {
				listener?.({ requestId: pending.requestId, decision: approved ? "approve" : "reject" });
				complete(approval.consume(pending.requestId, binding));
			}, () => {
				listener?.({ requestId: pending.requestId, decision: "reject" });
				complete(false);
			});
		},
		dispose() { disposed = true; approval.dispose(); },
	};
}
