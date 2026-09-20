import { TypeSafeClient } from "@typesafe-ai/sdk";
import type { EntryType, Questions, SystemOneResult } from "@typesafe-ai/sdk";
import { DEFAULT_JEV_MODEL } from "./semantic-policy.ts";

export { DEFAULT_JEV_MODEL } from "./semantic-policy.ts";

export interface JevEvaluationRequest {
	state: EntryType;
	questions: Questions;
	model: string;
}

export interface JevClient {
	evaluate(request: JevEvaluationRequest, options: { signal: AbortSignal; timeoutMs: number }): Promise<unknown>;
}

/** The only external-network seam. Construction and calls happen only after all activation gates pass. */
export class TypeSafeJevClient implements JevClient {
	private readonly client: TypeSafeClient;
	constructor(apiKey: string, model: string, maxRetries: number) {
		this.client = new TypeSafeClient({
			apiKey,
			defaultModel: model,
			logLevel: "off",
			retry: { maxRetries },
		});
	}

	async evaluate(request: JevEvaluationRequest, options: { signal: AbortSignal; timeoutMs: number }): Promise<SystemOneResult<Questions>> {
		return this.client.systemOne(request, {
			signal: options.signal,
			timeout: options.timeoutMs,
			retry: { maxRetries: this.client.retry.maxRetries },
		});
	}
}

export function createJevClient(
	options: { enabled: boolean; model: string; maxRetries: number },
	environment: { TYPESAFE_API_KEY?: string } = process.env,
): JevClient {
	if (!options.enabled) {
		throw new Error("Jev semantic supervision is disabled. Enable jev.enabled in ~/.pi/agent/interactive-shell.json.");
	}
	const apiKey = environment.TYPESAFE_API_KEY;
	if (!apiKey?.trim()) {
		throw new Error("Jev semantic supervision requires TYPESAFE_API_KEY in Pi's environment.");
	}
	return new TypeSafeJevClient(apiKey, options.model, options.maxRetries);
}
