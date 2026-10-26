# Recoverable selected output

Command-only opt-in. For a finite, raw-command background dispatch only, capture a recoverable source and later request conservative selection:

```js
const launch = await interactive_shell({
  command: "npm test -- --runInBand", mode: "dispatch", background: true,
  outputSelection: { enabled: true, goal: "retain failing test details, totals, and report paths" }
})
const sourceId = launch.details.outputSource.sourceId
interactive_shell({ sourceId, outputView: "selected" })
interactive_shell({ sourceId, outputView: "status" })
interactive_shell({ sourceId, outputView: "raw", sourceOffset: 0, sourceLimit: 5120 })
```

This does not apply to `spawn`, live overlays/TUIs, coding agents, auth, monitor, or hands-free modes, and never changes notifications or ordinary queries. Capture/raw/status are local and make no Jev call. Selected sends eligible redacted completed-log blocks only on that explicit query and only when the launch opted in, the user's global config enables `jev.enabled`, and Pi inherited `TYPESAFE_API_KEY`; project config and semantic monitoring cannot enable it. It selects excerpts, not generated summaries, and grants no command/input authority.

Results are `selected`, `unchanged`, `unavailable`, or `pagination-required`; semantic omissions and physical recovery ranges are separate. Provider/config/credential/error/request-cap cases cannot authorize omission and fall back to bounded completion output plus `{ outputView: "raw", sourceId }`. Short, exact/exhaustive, structured/diff, binary/control-heavy, interactive/auth, secret-like, and incomplete sources bypass conservatively. Selected requires retained in-process launch metadata, so after restart it is unavailable while raw source-ID recovery remains available until expiry.

Raw `normalized-merged-pty-text-v1` is exact merged PTY JS text after device-query removal, including ANSI/CR, addressed by half-open UTF-16 ranges—not bytes or separated stdout/stderr. Selected `safe-normalized-terminal-text-v1` removes controls and applies narrow same-line CR overwrite while preserving raw mappings. Fixed bounds: 8 MiB/source, 64 MiB aggregate, one-hour completed TTL, 51,200 UTF-16 chars/raw read; 5,120 visible selected chars; `jev-1.13.0`; eight logical/sixteen possible physical attempts; 10 s/call and 90 s outer deadline; canonical UTF-8 preflight below 24 KiB single-question and 48 KiB all-question payloads. Usage is audit-only; authoritative price is not exposed.
