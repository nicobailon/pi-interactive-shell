# Jev semantic supervision and launch policy

## Activation and data

Jev is optional and off by default. It sends bounded terminal viewport/recent text to TypeSafe AI only when (1) global `~/.pi/agent/interactive-shell.json` has `jev.enabled: true`, (2) `TYPESAFE_API_KEY` is present in Pi's startup environment, and (3) this session supplies `monitor.semantic`. Never put the key in a tool call or project config. Project config cannot enable Jev or change the model; it can only narrow timeout/retry/text limits and add redactions.

Data handling: TypeSafe says customer requests/responses are not used to train Jev ([models](https://docs.typesafe.ai/models), [legal](https://docs.typesafe.ai/legal)), while its [privacy policy](https://typesafe.ai/legal/privacy-policy) retains personal data as reasonably necessary. Do not assume default zero retention. Enterprise ZDR is a separate TypeSafe arrangement, not enabled by this SDK integration.

## Launch policy

Separately from Jev, the global top-level `launchPolicy` (for example `[{ "command": "npm test", "decision": "allow" }]`) opts launches through `interactive_shell` into exact-command policy; it needs no Jev setup or API call. When the field is omitted, existing launches are unchanged. When present, matching `deny` blocks before PTY/process/session/worktree creation, `ask` requires Pi's confirmation dialog, and `allow` proceeds; unmatched commands ask. Raw commands and resolved structured spawns are covered. Existing-session queries and controls are not. Project config and tool arguments cannot define or weaken this policy, and it is not a system-wide shell sandbox.

## Shapes

Observe without authorizing terminal input:

```js
interactive_shell({
  command: 'pi "Review this change"', mode: "dispatch",
  monitor: { semantic: { goal: "Report a visible result or blocker" } }
})
```

Semantic attention/watch events:

```js
interactive_shell({
  command: "npm test -- --watch", mode: "monitor",
  monitor: { strategy: "semantic", semantic: {
    attention: true,
    watches: [{ id: "failed", condition: "A test failure is visibly present", threshold: 0.85 }],
    uncertain: "notify"
  } }
})
```

One immutable exact-input action:

```js
interactive_shell({
  command: "deploy-tool", mode: "monitor",
  monitor: { strategy: "semantic", semantic: { actions: {
    enabled: true, maxActions: 1,
    items: [{ id: "confirm", description: "Confirm the visible ordinary prompt", input: "yes", submit: true, maxExecutions: 1 }]
  } } }
})
```

## Actions and events

Actions must be predeclared exact text or strict named keys. Model confidence is not authorization. Secret/credential/payment and process-lifecycle actions are forbidden; process exit remains PTY-owned. User takeover pauses semantics and fresh rendered output is required after control returns. In addition to per-action/session limits, a non-configurable process-wide cap allows 10 semantic action attempts across sessions; refused and throwing writes consume it.

`quietIntervalMs` performs exactly one observe-only reassessment per inactivity episode (default 2,000ms, bounded 250–60,000 and still gated by `minIntervalMs`), including no-output sessions. Quiet evaluation never writes bytes.

Semantic events include a bounded redacted excerpt of the screen Jev evaluated. Answer a question with ordinary `input` or `inputKeys` on the session.

Query decisions with `{ semanticDecisions: true, semanticSessionId }`; query delivered events with `{ monitorEvents: true, monitorSessionId }`; query monitor state with `{ monitorStatus: true, monitorSessionId }`. Provider failure, uncertainty, staleness, or a visible final answer never means completion or permission.

Built-in notifications use a confident mutually exclusive attention state: `working` continues, `other` stays uncertain, and input, approval, result, or blocked states emit their matching bounded event. Repeated attention events are suppressed until the primary state changes or new input is written to the session, so screen churn does not wake Pi again but a follow-up question after an answer does; watches and action-control events keep their separate delivery semantics. Independent Noul answers remain metadata and support watches/action readiness; they do not authorize input or veto a confident primary attention event.

## Diagnostics and incidents

Optional global `jev.diagnostics` is a local, content-free flight recorder. It is off by default (`enabled: false`, 14-day retention, 20 MB per-process cap) and adds no terminal polling or model calls. Query its bounded summary with `{ semanticDiagnostics: true }`. It records only fixed categories, timing/token counts, versions, sanitized model names, and random run/incident IDs—never terminal text, commands, paths, session IDs, hashes, goals, watch conditions, credentials, raw responses, or notes. Each process owns its journal, so recording needs no shared lock.

When normal task work independently reveals a supported discrepancy, report it against the live semantic session with `{ semanticSessionId, semanticIncident: { kind, decisionId?, expectedEvent?, observedEvent? } }`. Kinds are `missed-notification`, `unnecessary-notification`, `wrong-notification-type`, `duplicate-notification`, `premature-result`, and `stale-notification`. Do not inspect the terminal solely to audit Jev. Treat reports as suspected issues until an observable outcome or sanitized reproduction confirms them; add confirmed cases to the corpus and run `npm run eval:jev`. Silent misses remain unobservable unless another normal check exposes them.

## Configuration

Defaults/bounds: model `jev-1.13.0`; timeout 10,000 ms (1,000–30,000); retries 1 (0–2); viewport 40 lines (5–80); recent output 4,000 chars (500–8,000); up to 50 global-first/project-added RE2-compatible redaction patterns of 1–512 characters each; global diagnostic retention 1–90 days and storage 1–100 MB. Backreferences, lookaround, nested repetition, and invalid syntax reject config; matches are case-insensitive and replaced literally. Full scrollback, request bodies, action bytes, and keys are not stored in semantic history. Redaction is defense in depth.

Evaluate model changes with explicit `npm run eval:jev`; it reads only the packaged corpus and never runs in normal tests. The pass gate checks attention plus the default user-visible event outcome, while `atomicAccuracy` reports every secondary Noul as a diagnostic.
