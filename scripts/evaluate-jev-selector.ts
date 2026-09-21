#!/usr/bin/env node
import { loadConfig } from "../config.ts";
import { createJevClient } from "../jev-client.ts";
import { SELECTOR_CORPUS_HASH } from "../selector-corpus.ts";
import { evaluateLiveSelector, evaluateOfflineBaselines, SELECTOR_SETTINGS, type SelectorRow } from "../selector-evaluator.ts";

function summarize(rows: readonly SelectorRow[]) {
	return ["tuning", "held-out"].flatMap((split) => ["tail", "protected-context", "jev"].flatMap((arm) => {
		const selected = rows.filter((row) => row.split === split && row.arm === arm);
		if (!selected.length) return [];
		const required = selected.reduce((sum, row) => sum + row.requiredRetained, 0);
		const requiredTotal = selected.reduce((sum, row) => sum + row.requiredTotal, 0);
		const relevant = selected.reduce((sum, row) => sum + row.relevantRetained, 0);
		const selectedTotal = selected.reduce((sum, row) => sum + row.selectedIndices.length, 0);
		return [{
			split, arm, fixtures: selected.length,
			microRequiredRecall: requiredTotal ? required / requiredTotal : 1,
			macroRequiredRecall: selected.reduce((sum, row) => sum + row.requiredRecall, 0) / selected.length,
			microRelevantPrecision: selectedTotal ? relevant / selectedTotal : 1,
			averageVisibleChars: selected.reduce((sum, row) => sum + row.visibleChars, 0) / selected.length,
		}];
	}));
}

async function main(): Promise<void> {
	const offline = evaluateOfflineBaselines();
	console.log(JSON.stringify({ corpusHash: SELECTOR_CORPUS_HASH, settings: SELECTOR_SETTINGS, offline: summarize(offline.rows), rows: offline.rows }, null, 2));
	const args = new Set(process.argv.slice(2));
	if (!args.has("--live-jev")) {
		console.log("verdict: blocked-live-evaluation (explicit --live-jev activation absent; no provider call attempted)");
		return;
	}
	const confirmation = process.argv.slice(2).find((arg) => arg.startsWith("--confirm-corpus-hash="))?.slice("--confirm-corpus-hash=".length);
	if (confirmation !== SELECTOR_CORPUS_HASH) throw new Error("Live evaluation requires --confirm-corpus-hash matching the printed corpus hash.");
	const config = loadConfig(process.cwd());
	if (!config.jev?.enabled) throw new Error("Live evaluation requires user-owned global jev.enabled: true.");
	if (!process.env.TYPESAFE_API_KEY?.trim()) throw new Error("Live evaluation requires TYPESAFE_API_KEY in this process environment.");
	if (config.jev.model !== SELECTOR_SETTINGS.model) throw new Error(`Live evaluation is pinned to ${SELECTOR_SETTINGS.model}.`);
	const client = createJevClient({ enabled: true, model: SELECTOR_SETTINGS.model, maxRetries: SELECTOR_SETTINGS.maxRetries });
	const live = await evaluateLiveSelector({ client, redactionPatterns: config.jev.redactionPatterns });
	console.log(JSON.stringify({ live: summarize(live.rows), requests: live.requests, usage: live.usage, cost: live.cost }, null, 2));
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : "Live evaluation could not start.");
	process.exitCode = 1;
});
