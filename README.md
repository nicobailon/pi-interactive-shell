<p>
  <img src="banner.png" alt="pi-interactive-shell" width="1100">
</p>

# Pi Interactive Shell

An extension for [Pi coding agent](https://github.com/badlogic/pi-mono/) that lets Pi autonomously run interactive CLIs in an observable TUI overlay. Pi controls the subprocess while you watch - take over anytime.

https://github.com/user-attachments/assets/76f56ecd-fc12-4d92-a01e-e6ae9ba65ff4

```typescript
interactive_shell({ command: 'vim config.yaml' })
```

Important: the `interactive_shell({...})` snippets in this README are tool calls made by Pi (or extension/prompt authors). End users do not type these directly into chat. As a user, ask Pi to run something (for example: "run this in dispatch mode") or use `/spawn`, `/attach`, and `/dismiss` commands.

## Why

Some tasks need interactive CLIs - editors, REPLs, database shells, long-running processes. Pi can launch them in an overlay where:

- **User watches** - See exactly what's happening in real-time
- **User takes over** - Type anything to gain control
- **Agent monitors** - Query status, send input, decide when done

Works with any CLI: `vim`, `htop`, `psql`, `ssh`, `docker logs -f`, `npm run dev`, `git rebase -i`, etc.

## Install

```bash
pi install npm:pi-interactive-shell
```

The `interactive-shell` skill is automatically symlinked to `~/.pi/agent/skills/interactive-shell/`.

**Requires:** Node.js. PTY support uses `zigpty` prebuilt binaries (no `node-gyp` toolchain required on supported platforms).

## Modes

| Mode | Agent waits? | How output reaches agent | Best for |
|---|---|---|---|
| **Interactive** (default) | No | Stable `sessionId` for input/status | Editors, REPLs, SSH — when the agent or user will drive the shell |
| **Hands-free** | No | Poll with `sessionId` plus quiet updates | Dev servers, builds — when you want to watch progress and send follow-up commands |
| **Dispatch** | No | Notification on completion via `triggerTurn` | Delegating tasks to subagents — fire and forget |
| **Monitor** | No | Notification on structured monitor trigger events | Watchers, logs, tests, and state checks — wake only when something specific happens |

**Interactive** — The overlay opens and returns a stable `sessionId` immediately. The user can type directly, and the agent can send `input` with `submit: true`, check status, or background the same id. Use for editors (`vim`), database shells (`psql`), SSH, or manual CLI flows where the next step is still interactive.

**Hands-free** — The overlay opens and returns a stable `sessionId` immediately. The agent polls periodically with `sessionId` and also receives quiet/output updates. Good for long-running builds or dev servers where you want to react mid-flight (send input, check logs, or locally cancel supervision when ready).

**Dispatch** — Returns immediately. No polling. The agent gets woken up via `triggerTurn` only when the session completes or local supervision ends (natural exit, timeout, quiet detection, or user cancellation). The notification includes a captured tail of the output. This is the default for delegating work to subagents. Add `background: true` to skip the overlay entirely.

**Monitor** — Returns immediately. The agent gets woken up when a configured monitor trigger emits an event, and when the monitor lifecycle stops. Supports stream triggers, poll-diff checks, first-class file watching, optional cooldowns, persistence controls, detector commands, and event history queries. Runs headless; attach to inspect if needed.

## Quick Start

The examples below show agent-side tool calls. They are not chat commands for end users.

### Structured Spawn

For Pi, Codex, Claude, and Cursor, the agent can use structured spawn params instead of building command strings by hand:

```typescript
// User says: "Spawn pi so I can edit files interactively"
interactive_shell({ spawn: { agent: "pi" }, mode: "interactive" })

// User says: "Delegate this refactor to codex and notify me when it's done"
interactive_shell({ spawn: { agent: "codex" }, mode: "dispatch" })

// User says: "Ask cursor to review the diffs in dispatch mode"
interactive_shell({ spawn: { agent: "cursor", prompt: "Review the diffs" }, mode: "dispatch" })

// User says: "Ask claude to review the diffs in dispatch mode"
interactive_shell({ spawn: { agent: "claude", prompt: "Review the diffs" }, mode: "dispatch" })

// User says: "Start claude in a worktree for hands-free monitoring"
interactive_shell({ spawn: { agent: "claude", worktree: true }, mode: "hands-free" })

// User says: "Fork my current pi session" (Pi-only)
interactive_shell({ spawn: { mode: "fork" }, mode: "interactive" })
```

Structured `spawn` uses the same resolver and config defaults as the user-facing `/spawn` command. Raw `command` is still supported for arbitrary CLIs and custom launch strings. For unattended coding-agent work in a repository, prefer structured `spawn` with `worktree: true` or set an explicitly isolated `cwd`; a raw agent command runs in the supplied working directory and can change its Git state.

Any extra key you add under `spawn.commands` becomes a first-class spawn agent, usable as `spawn: { agent: "aider" }` and `/spawn aider`, with its own `spawn.defaultArgs` entry, worktree support, and prompt passthrough. `fork` stays Pi-only. Agent names must start with a letter or digit, may contain letters, digits, `.`, `_`, and `-`, and cannot be `fresh` or `fork`, because those are `/spawn` keywords.

For Codex image or design work, Codex can invoke `gpt-image-2` directly from the prompt. Natural language is usually enough, and `$imagegen` forces the image-generation tool when you need it. Attach references with `-i` for edits and iterations. See the bundled `codex-cli` skill for concrete examples. For Cursor CLI-specific command references, see the optional `examples/skills/cursor-cli` skill. Cursor structured spawn defaults to `--model composer-2-fast`, which explicitly selects Cursor's Composer 2 Fast model.

### Interactive

```typescript
// User says: "Open package.json in vim"
interactive_shell({ command: 'vim package.json' })

// User says: "Connect to the postgres database"
interactive_shell({ command: 'psql -d mydb' })

// User says: "SSH into the server"
interactive_shell({ command: 'ssh user@server' })
```

The tool returns a stable `sessionId` immediately. The agent can drive the same shell with `interactive_shell({ sessionId, input, submit: true })`, while the user can still type directly in the focused overlay.

### Hands-Free

```typescript
// Start a long-running process
interactive_shell({
  command: 'npm run dev',
  mode: "hands-free",
  reason: "Dev server"
})
// → { sessionId: "calm-reef", status: "running" }

// User says: "Check on the dev server status"
interactive_shell({ sessionId: "calm-reef" })
// → { status: "running", output: "Server ready on :3000", runtime: 45000 }

// Send input when needed
interactive_shell({ sessionId: "calm-reef", input: "/run review", submit: true })
interactive_shell({ sessionId: "calm-reef", inputKeys: ["ctrl+c"] })

// Cancel local supervision when done (termination is best-effort)
interactive_shell({ sessionId: "calm-reef", kill: true })
// → { status: "killed", output: "..." } // locally cancelled; subprocess exit is not confirmed
```

The overlay opens for the user to watch. The agent checks in periodically. User can type anything to take over control. After taking over a monitored hands-free or dispatch session, press `Ctrl+G` to return control to the agent.

### Dispatch

```typescript
// User says: "Delegate refactoring the auth module to pi and notify me when done"
interactive_shell({
  command: 'pi "Refactor the auth module"',
  mode: "dispatch",
  reason: "Auth refactor"
})
// → Returns immediately: { sessionId: "calm-reef" }
// → Agent ends turn or does other work.
```

When the session completes, the agent receives a compact notification on a new turn:

```
Session calm-reef completed successfully (5m 23s). 847 lines of output.

Step 9 of 10
Step 10 of 10
All tasks completed.

Attach to review full output: interactive_shell({ attach: "calm-reef" })
```

The notification includes a brief tail (last 5 lines) and a reattach instruction. The PTY is preserved for 5 minutes so the agent can attach to review full scrollback.

Dispatch defaults `autoExitOnQuiet: true` — the session gets a 15s startup grace period, then auto-closes after output goes silent (8s by default). The completion notification and details set `completionReason: "auto-close-quiet"`; this is not a terminal command verdict. Tune the grace period with `handsFree: { gracePeriod: 60000 }` or opt out entirely with `handsFree: { autoExitOnQuiet: false }`.

### Recoverable selected output (explicit opt-in)

Recoverable selection is deliberately narrow: it supports only a raw `command` launched as a headless `mode: "dispatch"` session with `background: true`. It does not filter live TUI output, coding-agent/spawn sessions, auth flows, monitor or hands-free sessions, completion notifications, or ordinary output queries. It does not authorize commands or terminal input, and it does not generate a summary.

```typescript
const launch = await interactive_shell({
  command: "npm test -- --runInBand",
  mode: "dispatch",
  background: true,
  outputSelection: {
    enabled: true,
    goal: "retain failing test details, totals, and report paths"
  }
})
// launch.details.outputSource = {
//   sourceId: "<stable source id>",
//   representation: "normalized-merged-pty-text-v1",
//   available: true
// }

interactive_shell({ sourceId: launch.details.outputSource.sourceId, outputView: "selected" })
interactive_shell({ sourceId: launch.details.outputSource.sourceId, outputView: "status" })
interactive_shell({
  sourceId: launch.details.outputSource.sourceId,
  outputView: "raw",
  sourceOffset: 0,
  sourceLimit: 5120
})
```

Capture starts only from the per-launch `outputSelection` consent above. Capture, `status`, and local-only `raw` reads do not call Jev. An eligible completed-log block reaches TypeSafe only when an agent explicitly queries `outputView: "selected"` and the other two consent gates are also open: the user's **global** config has `jev.enabled: true`, and `TYPESAFE_API_KEY` was inherited by the Pi process. Project config, a credential by itself, and `monitor.semantic` cannot enable selected-output transmission. Never put the credential in a tool call, config example, or project file.

Selected queries return `selected`, `unchanged`, `unavailable`, or `pagination-required`. Semantic omission ranges identify blocks omitted after evaluation; physical recovery ranges identify retained evidence that does not fit the selected display budget. In every case, use `outputView: "raw"` with the stable source ID to recover the local source. Short, exact/exhaustive, JSON/XML/YAML/diff, binary/control-heavy, interactive/auth, secret-like, or incomplete sources conservatively bypass transmission. Disabled configuration, a missing credential, provider/parse/timeout/abort failure, or request-cap exhaustion never authorizes omission: the response is unavailable with the bounded ordinary completion fallback and raw recovery metadata.

The raw source representation, `normalized-merged-pty-text-v1`, is the exact merged PTY JavaScript text received after terminal device-query removal. It preserves ANSI and carriage returns and uses half-open UTF-16 ranges; it is not original bytes and does not separate stdout from stderr. Provider/model and selected display text use `safe-normalized-terminal-text-v1`: controls are removed and carriage returns apply narrow same-line overwrite semantics, while every excerpt retains its exact raw range.

Fixed safety/retention bounds are not configuration knobs: 8 MiB per complete source, 64 MiB process-local aggregate storage, one-hour completed-source recovery, and at most 51,200 UTF-16 characters per raw read. Selection has a 5,120-visible-character budget, uses `jev-1.13.0`, and permits at most eight logical/sixteen possible physical attempts, 10 seconds per call, and one 90-second outer deadline. Canonical UTF-8 preflight stays strictly below 24 KiB for state plus a full single question and below 48 KiB for state plus all questions, conservative headroom under the provider's official 32K/64K token limits. Returned token usage is audit evidence only; this integration does not expose an authoritative price.

Selection requires process-retained launch consent/goal metadata. After a Pi process restart, selected view is explicitly unavailable, but raw recovery by `sourceId` remains available until expiry. The frozen calibration corpus (`747b075e4ad3d49411a12c3775d5316e7ad32bdd3e3ef231670b750facd37a45`) is kept as a reproducible regression: three accepted frozen live runs each scored held-out 15/15 versus deterministic 14/15 and tail 11/15; all 18/18 requests succeeded with no failure/retry statuses, p50 216.5 ms/p95 309 ms, and 17,993 input plus 2,660 output tokens per run. Cost was unavailable. This bounded corpus evidence does not establish universal accuracy or generalization.

For an external gate, use this provider-agnostic watch-until-terminal pattern. The watcher must print one of the terminal lines and exit only after it has a verdict:

```typescript
interactive_shell({
  command: "your-watch-command",
  mode: "monitor",
  handsFree: { autoExitOnQuiet: false },
  timeout: 20 * 60_000,
  monitor: {
    strategy: "stream",
    triggers: [
      { id: "ready", literal: "ready" },
      { id: "blocked", literal: "blocked" },
      { id: "stale-head", literal: "stale-head" }
    ]
  }
})
```

This works with CI, deploy, health, and custom CLI watchers. If raw dispatch is required, disable quiet auto-close and treat `completionReason: "auto-close-quiet"` as non-terminal.

The overlay still shows for the user, who can Ctrl+T to transfer output, Ctrl+B to background, take over by typing, or Ctrl+Q for more options. `Ctrl+G` only becomes meaningful after the user has taken over a monitored hands-free or dispatch session.

### Background Dispatch (Headless)

```typescript
// No overlay — runs completely invisibly
interactive_shell({
  command: 'pi "Fix all lint errors"',
  mode: "dispatch",
  background: true
})
// → { sessionId: "calm-reef" }
// → User can /attach calm-reef to peek
// → Agent notified on completion, same as regular dispatch
```

Multiple headless dispatches can run concurrently alongside a single interactive overlay. This is how you parallelize subagent work — fire off three background dispatches and process results as each completion notification arrives.

### Monitor (Event-Driven)

These examples are **agent tool calls**. End users should ask in natural language (for example: "watch my tests and alert me on failures"), and Pi should invoke `interactive_shell` with the monitor config.

Wake the agent when monitor triggers emit events — no polling and no waiting for process completion.

```typescript
// User says: "Watch my tests and alert me on failures or errors"
interactive_shell({
  command: 'npm test --watch',
  mode: "monitor",
  monitor: {
    strategy: "stream",
    triggers: [
      { id: "failed", literal: "FAIL" },
      { id: "error", regex: "/error|exception/i" }
    ],
    throttle: { dedupeExactLine: true },
    persistence: { stopAfterFirstEvent: false }
  }
})

// User says: "Monitor the health endpoint and tell me when it changes"
interactive_shell({
  command: 'curl -sf http://localhost:3000/health',
  mode: "monitor",
  monitor: {
    strategy: "poll-diff",
    triggers: [{ id: "changed", regex: "/./" }],
    poll: { intervalMs: 5000 }
  }
})

// User says: "Alert me when NVDA drops below $120"
interactive_shell({
  command: 'curl -s https://api.example.com/quote/NVDA',
  mode: "monitor",
  monitor: {
    strategy: "stream",
    triggers: [
      {
        id: "nvda-below-120",
        regex: "/NVDA:\\s*\\$?(\\d+(?:\\.\\d+)?)/",
        threshold: { captureGroup: 1, op: "lt", value: 120 }
      }
    ]
  }
})

// User says: "Watch the uploads folder for new PDF files and notify me"
interactive_shell({
  mode: "monitor",
  monitor: {
    strategy: "file-watch",
    fileWatch: { path: "./uploads", recursive: true, events: ["rename", "change"] },
    triggers: [{ id: "pdf", regex: "/\\.pdf$/i" }]
  }
})
```

`file-watch` generates and authorizes its own watcher command. Do not combine it with top-level `command` or `spawn`; mixed requests are rejected before spawn resolution or worktree creation.

Monitor mode emits structured payloads (`sessionId`, `eventId`, `timestamp`, `strategy`, `triggerId`, `matchedText`, `lineOrDiff`, `stream`) and now also emits lifecycle notifications when a monitor stops (stream ended, script failed, stopped, or timed out). `monitorFilter` was removed in favor of the structured `monitor` object.

```typescript
interactive_shell({ monitorStatus: true, monitorSessionId: "calm-reef" })
interactive_shell({ monitorEvents: true, monitorSessionId: "calm-reef" })
interactive_shell({ monitorEvents: true, monitorSessionId: "calm-reef", monitorSinceEventId: 42 })
interactive_shell({ monitorEvents: true, monitorSessionId: "calm-reef", monitorTriggerId: "error" })
interactive_shell({ monitorEvents: true, monitorSessionId: "calm-reef", monitorEventLimit: 50, monitorEventOffset: 20 })
```

Monitor sessions run headless and can be managed like other background sessions (`listBackground`, `/attach`, `dismissBackground`).

### Timeout

Capture output from TUI apps that don't exit cleanly:

```typescript
interactive_shell({
  command: "htop",
  mode: "hands-free",
  timeout: 3000  // Cancel after 3s, attempt termination, return captured output
})
```

## Features

### Auto-Exit on Quiet

For fire-and-forget single-task delegations, enable auto-exit to cancel local supervision after 8s of output silence and attempt termination:

```typescript
interactive_shell({
  command: 'pi "Fix the bug in auth.ts"',
  mode: "hands-free",
  handsFree: { autoExitOnQuiet: true }
})
```

A 15s startup grace period prevents local cancellation before the subprocess has time to produce output. Customize it per-call with `gracePeriod`:

```typescript
interactive_shell({
  command: 'pi "Run the full test suite"',
  mode: "hands-free",
  handsFree: { autoExitOnQuiet: true, gracePeriod: 60000 }
})
```

The default grace period is also configurable globally via `autoExitGracePeriod` in the config file.

For multi-turn sessions where you need back-and-forth interaction, leave it disabled (default) and use `kill: true` to cancel local supervision when done.

### Send Input

```typescript
// Text only (types text but does not submit)
interactive_shell({ sessionId: "calm-reef", input: "SELECT * FROM users;" })

// Type text and press Enter
interactive_shell({ sessionId: "calm-reef", input: "SELECT * FROM users;", submit: true })

// Named keys
interactive_shell({ sessionId: "calm-reef", inputKeys: ["ctrl+c"] })
interactive_shell({ sessionId: "calm-reef", inputKeys: ["down", "down", "enter"] })

// Bracketed paste (multiline without execution)
interactive_shell({ sessionId: "calm-reef", inputPaste: "line1\nline2\nline3" })

// Hex bytes (raw escape sequences)
interactive_shell({ sessionId: "calm-reef", inputHex: ["0x1b", "0x5b", "0x41"] })

// Combine text with keys
interactive_shell({ sessionId: "calm-reef", input: "y", inputKeys: ["enter"] })
```

For editor-based TUIs like pi, raw `input` only types text. It does not submit the prompt. Prefer `submit: true` or `inputKeys: ["enter"]` instead of relying on `\n`.

### Configurable Output

```typescript
// Default: 20 lines, 5KB
interactive_shell({ sessionId: "calm-reef" })

// More lines (max: 200)
interactive_shell({ sessionId: "calm-reef", outputLines: 100 })

// Incremental pagination (server tracks position)
interactive_shell({ sessionId: "calm-reef", outputLines: 50, incremental: true })

// Drain mode (raw stream since last query)
interactive_shell({ sessionId: "calm-reef", drain: true })
```

### Transfer Output to Agent

When a subagent finishes work, press **Ctrl+T** to capture its output and send it directly to the main agent:

```
[Subagent finishes work]
        ↓
[Press Ctrl+T]
        ↓
[Overlay closes, main agent receives full output]
```

The main agent then has the subagent's response in context and can continue working with that information.

**Configuration:**
- `transferLines`: Max lines to capture (default: 200)
- `transferMaxChars`: Max characters (default: 20KB)

### Background Sessions

Sessions can be backgrounded by the user (Ctrl+B, or Ctrl+Q → "Run in background") or by the agent:

```typescript
// Agent backgrounds an active session
interactive_shell({ sessionId: "calm-reef", background: true })
// → Overlay closes, process keeps running

// List background sessions
interactive_shell({ listBackground: true })

// Reattach with a specific mode
interactive_shell({ attach: "calm-reef" })                      // interactive (blocking)
interactive_shell({ attach: "calm-reef", mode: "hands-free" })  // hands-free (poll)
interactive_shell({ attach: "calm-reef", mode: "dispatch" })    // dispatch (notified)

// Dismiss background sessions
interactive_shell({ dismissBackground: true })               // all sessions
interactive_shell({ dismissBackground: "calm-reef" })        // specific session
```

Monitor sessions work the same way — they're headless background sessions that wake you on monitor events instead of completion.

The background-session list below the editor shows only running sessions, uses at most 20% of the terminal height (up to six rows), and collapses overflow into a summary. Completed sessions disappear from the widget immediately but remain temporarily queryable. Use `/attach` to view the retained full list.

Running background sessions and monitors survive `/reload` and reappear under the new extension instance. Quitting Pi or switching sessions still terminates them.

User can also `/spawn` to launch the configured default spawn agent, `/spawn codex`, `/spawn cursor`, `/spawn claude`, `/spawn pi`, `/spawn fork`, `/spawn pi fork`, or `/spawn <custom-agent>` for any agent added to `spawn.commands`. Add `--worktree` to spawn in a separate git worktree, for example `/spawn cursor --worktree`, `/spawn codex --worktree`, or `/spawn pi fork --worktree`. Plain `/spawn cursor` stays a normal interactive overlay. `fork` is Pi-only. Worktrees are left in place and the overlay will tell you where they were created. `/attach` or `/attach <id>` reattaches, and `/dismiss` or `/dismiss <id>` cleans up from the chat. The keyboard spawn shortcut is separate from `/spawn` and uses `spawn.shortcut`.

### Prompt-Bearing `/spawn`

Quoted prompt text plus `--hands-free` or `--dispatch` turns `/spawn` into a monitored delegated run instead of a plain interactive overlay. This shares the same resolver and defaults as structured `interactive_shell({ spawn: ... })`. Plain `/spawn` stays interactive. `Ctrl+G` only applies after you take over one of these monitored sessions.

```bash
/spawn cursor "review the diffs" --dispatch
/spawn claude "review the diffs" --dispatch
/spawn codex "fix the failing tests" --hands-free
/spawn pi fork "continue from here" --dispatch
```

## Keys

| Key | Action |
|-----|--------|
| Ctrl+T | **Transfer & close** - capture output and send to main agent |
| Ctrl+B | Background session (dismiss overlay, keep running) |
| Ctrl+Q | Session menu (transfer/background/kill/cancel) |
| Shift+Up/Down | Scroll history |
| Alt+Shift+F (default) | Toggle focus between overlay and main chat (`focusShortcut`) |
| Ctrl+G | Return to agent monitoring (only after taking over a monitored hands-free or dispatch session) |
| Alt+Shift+P (default) | Launch the configured default spawn agent (`spawn.shortcut`) |
| Any key (hands-free) | Take over control |

## Deferred tool loading

`interactive_shell` is active by default. Set `"defer": true` to keep its large tool definition out of the initial model request:

```json
{
  "defer": true
}
```

Pi then exposes the small `enable_interactive_shell` loader. When a task needs the shell, the agent calls the loader and `interactive_shell` becomes available on the next model turn. `/spawn`, `/attach`, `/dismiss`, and the keyboard shortcuts continue to work directly.

Each reloaded, new, resumed, or forked session starts with `interactive_shell` inactive again. Pi versions without the active-tool API print a warning and keep the tool active. A CLI `--tools` allowlist must include both `enable_interactive_shell` and `interactive_shell`; deferred activation cannot override an allowlist that excludes the target tool.

Deferred mode omits `interactive_shell`'s `promptSnippet`; the same operating guidance remains in the tool description. This keeps the system-prompt prefix stable when Pi uses native deferred loading.

## Optional Jev semantic supervision

Jev integration is optional and off by default. Terminal data reaches TypeSafe AI only when all three gates are open: the user enables `jev.enabled` in the **global** config, `TYPESAFE_API_KEY` exists in Pi's process environment, and a tool call explicitly supplies `monitor.semantic`. Put the environment variable in the shell that starts Pi or inject it with your secret manager; it is never a tool argument or an `interactive-shell.json` field. A project config cannot enable Jev or switch its model.

Example global opt-in (the default is `false`):

```json
{
  "jev": {
    "enabled": true,
    "model": "jev-1.13.0",
    "requestTimeoutMs": 10000,
    "maxRetries": 1,
    "maxViewportLines": 40,
    "maxRecentChars": 4000,
    "redactionPatterns": [],
    "diagnostics": { "enabled": false, "retentionDays": 14, "maxBytes": 20000000 }
  }
}
```

| Jev field | Default | Implemented bounds/ownership |
|---|---:|---|
| `enabled` | `false` | Global config only |
| `model` | `jev-1.13.0` | Nonempty global value only; project model is ignored |
| `requestTimeoutMs` | `10000` | 1,000–30,000; project may only lower the global value |
| `maxRetries` | `1` | 0–2; project may only lower the global value |
| `maxViewportLines` | `40` | 5–80; project may only lower the global value |
| `maxRecentChars` | `4000` | 500–8,000; project may only lower the global value |
| `redactionPatterns` | `[]` | Up to 50 global-first, project-added RE2-compatible patterns; each source is 1–512 characters |
| `semanticPermissions` | omitted | Global config only; enables launch policy when present. Exact rules use `allow`, `ask`, or `deny`, with `deny > ask > allow`; unmatched operations ask |
| `diagnostics.enabled` | `false` | Global config only; records local structured metadata without another model call |
| `diagnostics.retentionDays` | `14` | 1–90 days; global config only |
| `diagnostics.maxBytes` | `20000000` | 1–100 MB per process across its retained journals; global config only |

Per-session `monitor.semantic` supports: `goal` (optional task context, sent bounded to 1,000 characters), `attention` (built-in events, default `false`), `watches` (safe unique IDs, nonempty conditions, optional threshold 0–1 with default `0.8`), `minIntervalMs` (default `1000`, clamped 250–60,000), `uncertain` (`"continue"` by default or `"notify"`), optional configured `actions`, and optional `dynamicChoices`. Dynamic choices require literal `enabled: true` and a nonblank `goal`; they are unavailable in headless/background supervision and can execute at most once per session. Actions require literal `enabled: true`, 1–10 items, session `maxActions` default 1/max 10, safe unique IDs, descriptions up to 500 characters, exactly one text input (1–2,000 characters, optional `submit`) or strict key array (1–32 keys), encoded bytes up to 4,096, cooldown 0–86,400,000 ms, and per-action executions 1–10. A code-owned process-wide cap permits at most 10 semantic action attempts across all sessions; refused or throwing writes consume an attempt, and the cap is not caller-configurable.

Quiet-state integration adds `quietIntervalMs`: one observe-only reassessment per inactivity episode (default 2,000ms, bounded 250–60,000 and still subject to `minIntervalMs`). It also covers sessions that produce no output. An unchanged quiet observation can notify but cannot execute fixed/dynamic actions or write terminal bytes.

`semanticPermissions` is also the explicit opt-in boundary for commands launched through `interactive_shell`. Omitting the field preserves existing launch behavior. Once present, each raw command or resolved structured-spawn command is matched exactly before PTY, session, process, or worktree creation. `deny` blocks, `ask` requires Pi's confirmation dialog, and `allow` proceeds; an empty array asks for every launch. Unavailable UI, rejection, or dialog failure blocks an `ask`. Query, input, attach, and lifecycle calls for existing sessions are unaffected. This is an `interactive_shell` launch policy, not a shell, Bash, Pi, or operating-system sandbox.

```json
{
  "jev": {
    "semanticPermissions": [
      { "decision": "allow", "operation": { "kind": "launch-command", "command": "npm test" } },
      { "decision": "deny", "operation": { "kind": "launch-command", "command": "deploy --production" } },
      { "decision": "ask", "operation": { "kind": "dynamic-terminal-choice" } }
    ]
  }
}
```

Launch policy is local and does not require `jev.enabled`, an API key, or a model call. Structured spawn rules match the final resolved command, including configured default arguments and prompt.

Bounded viewport/recent terminal text is sent to TypeSafe AI. ANSI/control text is stripped and built-in plus configured redaction runs first, but redaction is defense in depth—not a promise to identify every secret. Custom patterns use linear-time RE2-compatible syntax (no backreferences, lookaround, or nested repetition), are validated at config load, and replace every case-insensitive match with literal `[REDACTED]`. Invalid selected patterns reject configuration rather than being skipped. Full scrollback, request bodies, exact action input/bytes, and the API key are not stored in semantic history. Provider failures, uncertainty, stale responses, or a visible result never imply process completion or permission to act; PTY exit remains deterministic authority.

Built-in attention notifications use the model's confident, mutually exclusive primary state. Confident `working` continues silently, confident `other` remains uncertain, and confident input, approval, result, or blocked states emit their corresponding bounded event. The same attention event is suppressed until the primary state changes; independent watches and action-control events retain their own delivery semantics. Independent Noul answers remain inspectable metadata and drive watches or action readiness where configured; they do not duplicate-veto the primary attention event. This routing never grants terminal-action authority.

Observe a hands-free or dispatch session without authorizing input:

```typescript
interactive_shell({
  command: 'pi "Review the changes"',
  mode: "hands-free", // mode: "dispatch" also works
  monitor: { semantic: { goal: "Review changes and report blockers" } }
})
```

Emit built-in attention events and an independent watch:

```typescript
interactive_shell({
  command: "npm test -- --watch",
  mode: "monitor",
  monitor: {
    strategy: "semantic",
    semantic: {
      attention: true,
      uncertain: "notify",
      watches: [{ id: "tests-failed", condition: "A test failure is visibly present", threshold: 0.85 }]
    }
  }
})
```

Authorize one bounded, immutable exact response:

```typescript
interactive_shell({
  command: "deploy-tool",
  mode: "monitor",
  monitor: {
    strategy: "semantic",
    semantic: {
      attention: true,
      actions: {
        enabled: true,
        maxActions: 1,
        items: [{ id: "confirm", description: "Confirm the visible ordinary deployment prompt", input: "yes", submit: true, maxExecutions: 1 }]
      }
    }
  }
})
```

Actions are predeclared immutable `input` (+ optional `submit`) or strict `inputKeys`, never generated text, hex, paste, credentials, secret/payment entry, or lifecycle commands. Confidence is one required safety gate, not authorization. User takeover pauses supervision; returning control requires fresh rendered output before evaluation/action resumes. Semantic events never mark a process exited.

Goal-driven choices are a separate opt-in for foreground hands-free/dispatch overlays:

```typescript
interactive_shell({
  command: "release-tool", mode: "hands-free",
  monitor: { semantic: {
    goal: "Select the stable release channel",
    dynamicChoices: { enabled: true }
  } }
})
```

The extension conservatively extracts a fresh bounded multi-select before attempting a sequential numbered/lettered menu, an explicitly keyboard-navigable menu, or one strict inline `(Y/n)`/`(y/N)` confirmation. A multi-select requires 2–8 fully visible `[x]`/`[ ]` or `◉`/`◯` rows, one cursor, and exactly `↑↓ navigate • space select • ⏎ submit`; malformed or unsupported multi-select evidence never downgrades to a single-choice menu. Wrapped ordinary-menu descriptions and a single visible selection marker remain supported. This foreground-only feature can execute one dynamic interaction per session. For multi-selects, Jev receives only ordered opaque IDs/labels, one bounded apply-or-abstain question, and one typed desired-state question per item—not terminal bytes or executable bindings. An intentionally empty desired set differs from abstention; apply confidence and each selected item require 0.90, while unselected items require at most 0.10. Because the schema depends on exact ordered descriptors, provider caches must include those IDs/labels and the question-schema version. Yes/No menus and inline confirmations are `dynamic-terminal-confirmation`, multi-selects are `dynamic-terminal-multi-select`, and other supported menus use `dynamic-terminal-choice`.

An approved multi-select is one serialized transaction and one global reservation. Immediately before starting, the supervisor re-extracts the exact full trusted viewport, then writes one code-owned ArrowUp, ArrowDown, Space, or final Enter per verified transition (at most `3*N+1`). Every redraw before submit must exactly match the expected cursor/check mutation; completion requires the prompt to disappear after Enter. Any mismatch, refused write, takeover, reload, pause, exit, secret state, ownership/epoch change, or automation stop clears the transaction without retry, rollback, replay, or blind byte sequence and reports an incomplete follow-up after a started transaction. Pre-action denial, unavailable ask UI, stale state, malformed targets, and unsupported structure write nothing. Inline confirmations retain their existing bounded echo transaction. Global `jev.semanticPermissions` rules are trusted and project/tool configuration cannot weaken them. Prefer `ask` for all three dynamic operation kinds; deny wins, unmatched asks, and allow uses the same real one-time UI bridge. Existing configured fixed actions and budgets are unchanged.

Semantic events carry a bounded, source-grounded, already-redacted terminal excerpt and a content-sensitive `handoffIdentity`; the same unresolved state dedupes while a new same-type question wakes Pi. For an ordinary input handoff, Pi may send one `semanticReply` with that event's exact session, decision, generation, identity, and one bounded single-line response. Immediately before writing, runtime rechecks ownership, current observation, reload/takeover/exit state, secret state, response restrictions, and trusted global `semantic-reply` permission. Unmatched permission asks, deny wins, and unavailable UI fails closed. Ordinary manual `input` is unchanged.

Inspect semantic decisions with `interactive_shell({ semanticDecisions: true, semanticSessionId: sessionId })`. Inspect delivered events with `interactive_shell({ monitorEvents: true, monitorSessionId: sessionId })`; `monitorStatus: true` returns monitor lifecycle state.

Optional diagnostics write private per-process JSONL journals under Pi's agent directory. Each process owns and bounds its own files, so writers need no shared lock. Records contain only fixed schema/version identifiers, random run and incident IDs, timestamps, bounded timing/token counts, fixed decision/event/outcome categories, and sanitized model names. They never contain terminal text, commands, paths, session IDs, observation hashes, configured goals or watches, credentials, API keys, raw provider responses, or free-form notes. Files are mode `0600`; expired records are excluded from summaries immediately, and old journals are pruned on later writes. Diagnostics add no terminal polling, provider request, notification, action, or automatic tuning.

Summarize recent diagnostics without reading terminal content:

```typescript
interactive_shell({ semanticDiagnostics: true, semanticDiagnosticDays: 7 })
```

When ordinary task handling supplies observable evidence of a discrepancy, the agent can attach one fixed-category incident to a live semantic run:

```typescript
interactive_shell({
  semanticSessionId: sessionId,
  semanticIncident: {
    kind: "wrong-notification-type",
    decisionId: 12,
    expectedEvent: "input-required",
    observedEvent: "result-ready"
  }
})
```

Supported incident categories are `missed-notification`, `unnecessary-notification`, `wrong-notification-type`, `duplicate-notification`, `premature-result`, and `stale-notification`. A report is a suspected problem, not ground truth. Confirm recurring incidents with an observable outcome or sanitized reproduction, add the reproduction to the corpus, then run `npm run eval:jev` before changing calibration. Diagnostics cannot discover a silent missed notification unless normal work or an explicit check causes the terminal state to be observed.

Troubleshooting:
- **Disabled globally:** set global `jev.enabled: true`; project configuration cannot enable transmission.
- **Missing credential:** start Pi from an environment containing `TYPESAFE_API_KEY`; do not put it in tool or project configuration.
- **Timeout/rate limit/provider failure:** the decision fails closed with a bounded diagnostic; increase only the global timeout within its bound or retry after provider recovery.
- **Uncertain result:** default behavior is continue silently; set `uncertain: "notify"` to emit a bounded event. Uncertainty never authorizes input.
- **Model change:** run the repository corpus explicitly with `npm run eval:jev` before relying on the new globally configured model. This command reads only packaged fixtures, requires the same global enablement and environment credential, and never runs in normal tests/CI. Its pass gate measures the expected attention state and default user-visible event outcome; `atomicAccuracy` separately reports agreement with every secondary Noul.

TypeSafe states that customer requests/responses are not used to train Jev; see [Models](https://docs.typesafe.ai/models) and [Legal](https://docs.typesafe.ai/legal). Its [public privacy policy](https://typesafe.ai/legal/privacy-policy) says personal data is retained as reasonably necessary, so do not assume default zero retention. Enterprise zero-data-retention is a separate arrangement described by TypeSafe and is not enabled by this direct SDK integration.

## Config

Configuration files (project overrides global):
- **Global:** `~/.pi/agent/interactive-shell.json`
- **Project:** `.pi/interactive-shell.json`

### Shell selection

New sessions use the same Bash resolver as Pi rather than the ambient `$SHELL`
or `COMSPEC`. On Unix, this changes the default from `$SHELL`/`/bin/sh` to
Pi's Bash selection (`/bin/bash`, then `bash` on `PATH`, with Pi's documented
fallback). On Windows, Pi discovers Git Bash in its standard install
locations, then `bash.exe` on `PATH`.

To choose a specific Bash executable, set Pi's `shellPath` in
`~/.pi/agent/settings.json` (or trusted project `.pi/settings.json`):

```json
{
  "shellPath": "C:/Program Files/Git/bin/bash.exe"
}
```

Project settings follow Pi's trust rules: a trusted project's `shellPath`
overrides the global setting, while an untrusted project's setting is ignored.
`shellPath` must select a Bash-compatible executable; PowerShell and `cmd.exe`
are not interactive-shell transports. Pi's legacy WSL `bash.exe` uses
stdin-only command transport and is rejected for interactive PTYs; select Git
Bash instead.

Deferred loading and shortcut settings are pinned at startup. If you change `defer`, `focusShortcut`, or `spawn.shortcut`, reload or restart Pi to apply them.

```json
{
  "defer": false,
  "overlayWidthPercent": 95,
  "overlayHeightPercent": 60,
  "overlayAnchor": "center",
  "focusShortcut": "alt+shift+f",
  "spawn": {
    "defaultAgent": "pi",
    "shortcut": "alt+shift+p",
    "commands": {
      "pi": "pi",
      "codex": "codex",
      "claude": "claude",
      "cursor": "agent",
      "aider": "aider"
    },
    "defaultArgs": {
      "pi": [],
      "codex": [],
      "claude": [],
      "cursor": ["--model", "composer-2-fast"],
      "aider": ["--yes-always"]
    },
    "worktree": false,
    "worktreeBaseDir": "../repo-worktrees"
  },
  "scrollbackLines": 5000,
  "exitAutoCloseDelay": 10,
  "minQueryIntervalSeconds": 60,
  "transferLines": 200,
  "transferMaxChars": 20000,
  "completionNotifyLines": 50,
  "completionNotifyMaxChars": 5000,
  "handsFreeUpdateMode": "on-quiet",
  "handsFreeUpdateInterval": 60000,
  "handsFreeQuietThreshold": 8000,
  "autoExitGracePeriod": 15000,
  "handsFreeUpdateMaxChars": 1500,
  "handsFreeMaxTotalChars": 100000,
  "handoffPreviewEnabled": true,
  "handoffPreviewLines": 30,
  "handoffPreviewMaxChars": 2000,
  "handoffSnapshotEnabled": false,
  "ansiReemit": true
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `defer` | `false` | Start each session with only `enable_interactive_shell`; the full tool loads on demand |
| `overlayWidthPercent` | 95 | Overlay width (10-100%) |
| `overlayHeightPercent` | 60 | Overlay height (20-90%) |
| `overlayAnchor` | "center" | Overlay position: `center`, `top-left`, `top-center`, `top-right`, `left-center`, `right-center`, `bottom-left`, `bottom-center`, `bottom-right` |
| `focusShortcut` | "alt+shift+f" | Toggle focus between overlay and main chat |
| `spawn.defaultAgent` | "pi" | Configured default spawn agent for `/spawn`, the spawn shortcut, and agent-side structured spawn |
| `spawn.shortcut` | "alt+shift+p" | Keyboard shortcut that launches the configured default spawn agent |
| `spawn.commands.<agent>` | `pi` / `codex` / `claude` / `agent` (cursor) | Executable or path per spawn agent. Extra keys define custom spawn agents |
| `spawn.defaultArgs.<agent>` | `[]` (Cursor defaults to `--model composer-2-fast`) | Extra default CLI args per spawn agent |
| `spawn.worktree` | `false` | Launch spawns in a separate git worktree by default |
| `spawn.worktreeBaseDir` | unset | Optional base directory for generated worktrees |
| `scrollbackLines` | 5000 | Terminal scrollback buffer |
| `exitAutoCloseDelay` | 10 | Seconds before auto-close after exit |
| `minQueryIntervalSeconds` | 60 | Rate limit between agent queries |
| `transferLines` | 200 | Lines to capture on Ctrl+T transfer (10-1000) |
| `transferMaxChars` | 20000 | Max chars for transfer (1KB-100KB) |
| `completionNotifyLines` | 50 | Lines in dispatch completion notification (10-500) |
| `completionNotifyMaxChars` | 5000 | Max chars in completion notification (1KB-50KB) |
| `handsFreeUpdateMode` | "on-quiet" | "on-quiet" or "interval" |
| `handsFreeQuietThreshold` | 8000 | Silence duration before update (ms) |
| `autoExitGracePeriod` | 15000 | Startup grace before `autoExitOnQuiet` cancellation (ms) |
| `handsFreeUpdateInterval` | 60000 | Max interval between updates (ms) |
| `handsFreeUpdateMaxChars` | 1500 | Max chars per update |
| `handsFreeMaxTotalChars` | 100000 | Total char budget for updates |
| `handoffPreviewEnabled` | true | Include tail in tool result |
| `handoffPreviewLines` | 30 | Lines in tail preview (0-500) |
| `handoffPreviewMaxChars` | 2000 | Max chars in tail preview (0-50KB) |
| `handoffSnapshotEnabled` | false | Write transcript on detach/exit |
| `ansiReemit` | true | Preserve ANSI colors in output |

## How It Works

```
interactive_shell → zigpty → subprocess
                  ↓
            xterm-headless (terminal emulation)
                  ↓
            TUI overlay (pi rendering)
```

Full PTY. The subprocess thinks it's in a real terminal.

## Example Workflow: Plan, Implement, Review

The `examples/prompts/` directory includes three opt-in prompt templates that chain together into a complete development workflow using Codex CLI. Each template loads the example `gpt-5-4-prompting` skill by default, falls back to `codex-5-3-prompting` when the user explicitly asks for Codex 5.3, and launches Codex in an interactive overlay with Codex CLI's preferred `gpt-5.5` model.

### The Pipeline

```
Write a plan
    ↓
/codex-review-plan path/to/plan.md        ← Codex verifies every assumption against the codebase
    ↓
/codex-implement-plan path/to/plan.md     ← Codex implements the reviewed plan faithfully
    ↓
/codex-review-impl path/to/plan.md        ← Codex reviews the diff against the plan, fixes issues
```

### Installing the Templates

Install the package first for the extension and core `pi-interactive-shell` skill:

```bash
pi install npm:pi-interactive-shell
```

The Codex workflow prompts and supporting skills are opt-in examples. Copy them into your agent config if you want to use them:

```bash
# Prompt templates (slash commands)
cp ~/.pi/agent/extensions/pi-interactive-shell/examples/prompts/*.md ~/.pi/agent/prompts/

# Optional skills used by the templates
cp -r ~/.pi/agent/extensions/pi-interactive-shell/examples/skills/codex-cli ~/.pi/agent/skills/
cp -r ~/.pi/agent/extensions/pi-interactive-shell/examples/skills/gpt-5-4-prompting ~/.pi/agent/skills/
cp -r ~/.pi/agent/extensions/pi-interactive-shell/examples/skills/codex-5-3-prompting ~/.pi/agent/skills/

# Optional CLI reference skill
cp -r ~/.pi/agent/extensions/pi-interactive-shell/examples/skills/cursor-cli ~/.pi/agent/skills/
```

### Usage

Say you have a plan at `docs/auth-redesign-plan.md`:

**Step 1: Review the plan** — Codex reads your plan, then verifies every file path, API shape, data flow, and integration point against the actual codebase. Fixes issues directly in the plan file.

```
/codex-review-plan docs/auth-redesign-plan.md
/codex-review-plan docs/auth-redesign-plan.md pay attention to the migration steps
```

**Step 2: Implement the plan** — Codex reads all relevant code first, then implements bottom-up: shared utilities first, then dependent modules, then integration code. No stubs, no TODOs.

```
/codex-implement-plan docs/auth-redesign-plan.md
/codex-implement-plan docs/auth-redesign-plan.md skip test files for now
```

**Step 3: Review the implementation** — Codex diffs the changes, reads every changed file in full (plus imports and dependents), traces code paths across file boundaries, and fixes every issue it finds. Pass the plan to verify completeness, or omit it to just review the diff.

```
/codex-review-impl docs/auth-redesign-plan.md              # review diff against plan
/codex-review-impl docs/auth-redesign-plan.md check cleanup ordering
/codex-review-impl                                          # just review the diff, no plan
/codex-review-impl focus on error handling and race conditions
```

### How They Work

These templates demonstrate a "meta-prompt generation" pattern:

1. **Pi gathers context** — reads the plan, runs git diff, and loads the copied local `gpt-5-4-prompting` or `codex-5-3-prompting` skill
2. **Pi generates a calibrated prompt** — tailored to the specific plan/diff, following the selected skill's best practices
3. **Pi launches Codex in the overlay** — defaulting to `-m gpt-5.5 -a never` and switching to `-m gpt-5.3-codex -a never` only when the user explicitly asks for Codex 5.3

The user watches Codex work in the overlay and can take over anytime (type to intervene, Ctrl+T to transfer output back to pi, Ctrl+Q for options).

### Customizing

These are starting points. Fork them and adjust:

- **Model/flags** — swap `gpt-5.3-codex` for another model, change reasoning effort
- **Review criteria** — add project-specific checks (security policies, style rules)
- **Implementation rules** — change the 500-line file limit, add framework-specific patterns
- **Other agents** — adapt the pattern for Claude (`claude "prompt"`), Gemini (`gemini -i "prompt"`), or any CLI

See the [pi prompt templates docs](https://github.com/badlogic/pi-mono/) for the full `$1`, `$@` placeholder syntax.

## Advanced: Multi-Agent Workflows

For orchestrating multi-agent chains (scout → planner → worker → reviewer) with file-based handoff and auto-continue support, see:

**[pi-foreground-chains](https://github.com/nicobailon/pi-foreground-chains)** - A separate skill that builds on interactive-shell for complex agent workflows.

## Limitations

- macOS tested, Linux experimental
- 60s rate limit between queries (configurable)
- Some TUI apps may have rendering quirks
