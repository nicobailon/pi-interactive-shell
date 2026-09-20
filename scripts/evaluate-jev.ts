#!/usr/bin/env node
import { loadConfig } from "../config.ts";
import { createJevClient } from "../jev-client.ts";
import { evaluateSemanticCorpus, isCorpusEvaluationPassing } from "../semantic-evaluator.ts";

async function main(): Promise<void> {
	const config = loadConfig(process.cwd());
	const jev = config.jev;
	if (!jev?.enabled) throw new Error("Live corpus evaluation requires global jev.enabled: true.");
	// createJevClient enforces TYPESAFE_API_KEY in this process environment without exposing it.
	const client = createJevClient({ enabled: jev.enabled, model: jev.model, maxRetries: jev.maxRetries });
	const report = await evaluateSemanticCorpus({ client, model: jev.model, requestTimeoutMs: jev.requestTimeoutMs });
	for (const item of report.predictions) {
		const prediction = item.status === "evaluated" ? `${item.attention}/${item.route}` : item.status;
		console.log(`${item.fixtureId}: ${prediction}${item.correct ? " [expected]" : " [mismatch]"}`);
	}
	console.log(JSON.stringify({
		model: report.model, fixtures: report.fixtureCount, evaluated: report.evaluatedCount,
		accuracy: report.accuracy, atomicAccuracy: report.atomicAccuracy, confusion: report.confusion, uncertainty: report.uncertaintyCount,
		errors: report.errorCount, secretSkipped: report.secretSkippedCount,
		latency: report.latency, inputTokens: report.inputTokens,
	}, null, 2));
	if (!isCorpusEvaluationPassing(report)) process.exitCode = 1;
}

main().catch((error) => {
	const message = error instanceof Error && /global jev\.enabled/.test(error.message)
		? error.message
		: "Live corpus evaluation could not start; verify global Jev enablement and Pi environment credentials.";
	console.error(message);
	process.exitCode = 1;
});
