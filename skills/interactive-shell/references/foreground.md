# Foreground sessions

Sessions with an overlay the user can see: `interactive`, `hands-free`, and non-background `dispatch`.

## Interactive

The overlay opens and returns a `sessionId` at once. The user types directly, and you can send input to the same shell:

```js
const { sessionId } = interactive_shell({ command: "pi" })
interactive_shell({ sessionId, input: "/help", submit: true })
```

## Hands-free

You delegate, query for progress, and decide when the task is done:

```js
interactive_shell({ command: 'pi "Fix all TypeScript errors in src/"', mode: "hands-free", reason: "Fixing TS errors" })
// → details.sessionId = "calm-reef", status "running"
interactive_shell({ sessionId: "calm-reef" })              // → status, output, runtime
interactive_shell({ sessionId: "calm-reef", input: "Now fix the tests", submit: true })
interactive_shell({ sessionId: "calm-reef", kill: true })  // output captured at cancellation; may be incomplete
```

- **Status** is `running`, `monitoring`, `user-takeover`, `exited`, `killed`, or `backgrounded`. `killed` means local cancellation after best-effort termination, not confirmed exit.
- **Rate limit.** Queries of a running session are limited to one per 60 seconds. An early query waits out the limit, or returns as soon as the session ends. The user is watching the overlay live; you only check in.
- **Takeover.** When the user types into a monitored hands-free or dispatch session, they own it until they press Ctrl+G to return control.
- **Auto-exit.** For a single task, `handsFree: { autoExitOnQuiet: true }` ends supervision after ~8s of quiet (after the startup grace period). Tell the agent to save results to a file, since the session closes on its own. Leave it off (the hands-free default) for multi-turn work.
- **Update timing.** `settings: { updateInterval, quietThreshold }` changes how often hands-free updates arrive mid-session.

## Reading output

Queries return the rendered screen, not the raw stream, so spinners and redraws don't show up. `outputLines` (max 200) and `outputMaxChars` (max 50KB) raise the limits. `incremental: true` pages forward through the log, returning `hasMore` until you reach the end; `drain: true` returns only raw stream output that is new since the last query.

## Handoff

- **Transfer (Ctrl+T).** The user presses Ctrl+T in the overlay and the session output (default 200 lines, 20KB; `transferLines`, `transferMaxChars`) arrives as your context.
- **Tail preview.** The tool result includes the last 30 lines by default.
- **Snapshot.** `handoffSnapshot: { enabled: true, lines: 200 }` writes the transcript to `~/.pi/agent/cache/interactive-shell/snapshot-*.log`.
- **Artifact.** For complex work, tell the agent to write a handoff file: what it did, files changed, errors, next steps.

## Background and reattach

```js
interactive_shell({ sessionId: "calm-reef", background: true })      // close the overlay, keep running
interactive_shell({ attach: "calm-reef" })                           // reopen; blocks until the overlay closes
interactive_shell({ attach: "calm-reef", mode: "hands-free" })       // reattach and query
interactive_shell({ attach: "calm-reef", mode: "dispatch" })         // reattach and get a completion wake-up
```

The user can also background with Ctrl+B, open the session menu with Ctrl+Q, and reattach with `/attach`.
