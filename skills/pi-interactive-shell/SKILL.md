---
name: pi-interactive-shell
description: Cheat sheet + workflow for launching interactive coding-agent CLIs (Claude Code, Gemini CLI, Codex CLI, Cursor CLI, and pi itself) via the interactive_shell overlay, headless dispatch, or monitor mode. Use for TUI agents and long-running processes that need supervision, fire-and-forget delegation, or event-driven background monitoring. If interactive_shell is unavailable, enable it with enable_interactive_shell first. Regular bash commands should use the bash tool instead.
---

# Interactive Shell (Skill)

## Deferred activation

When `interactive_shell` is unavailable, call `enable_interactive_shell` first. The tool becomes callable on the next turn and stays active until Pi reloads or the session changes; reloaded, new, resumed, and forked sessions reset it to inactive. Do not call the loader when `interactive_shell` is already available.

Users opt in with `"defer": true` in `interactive-shell.json`. Older Pi versions without active-tool APIs warn and keep eager loading. A CLI `--tools` allowlist must include both `enable_interactive_shell` and `interactive_shell`.

## Foreground vs Background Subagents

Pi has two ways to delegate work to other AI coding agents:

| | Foreground Subagents | Dispatch Subagents | Background Subagents |
|---|---|---|---|
| **Tool** | `interactive_shell` | `interactive_shell` (dispatch) | `subagent` |
| **Visibility** | User sees overlay | User sees overlay (or headless) | Hidden from user |
| **Agent model** | Polls for status | Notified on completion | Full output captured |
| **Default agent** | `pi` (others if user requests) | `pi` (others if user requests) | Pi only |
| **User control** | Can take over anytime | Can take over anytime | No intervention |
| **Best for** | Long tasks needing supervision | Fire-and-forget delegations | Parallel tasks, structured delegation |

**Foreground subagents** run in an overlay where the user watches and can intervene. Use `interactive_shell` with `mode: "interactive"` when the agent or user will drive the shell by session id, `mode: "hands-free"` to monitor while receiving periodic updates, or `mode: "dispatch"` to be notified on completion without polling.

**Dispatch subagents** also use `interactive_shell` but with `mode: "dispatch"`. The agent fires the session and moves on. When the session completes, the agent is woken up via `triggerTurn` with the output in context. Add `background: true` for headless execution (no overlay).

**Monitor mode** (`mode: "monitor"`) runs headless and event-driven. It wakes the agent on structured monitor trigger events (stream or poll-diff), so there is no polling loop.

**Background subagents** run invisibly via the `subagent` tool. Pi-only, but captures full output and supports parallel execution.

## When to Use Foreground Subagents

Use `interactive_shell` (foreground) when:
- The task is **long-running** and the user should see progress
- The user might want to **intervene or guide** the agent
- You want **hands-free monitoring** with periodic status updates
- You need a **different agent's capabilities** (only if user specifies)

Use `subagent` (background) when:
- You need **parallel execution** of multiple tasks
- You want **full output capture** for processing
- The task is **quick and deterministic**
- User doesn't need to see the work happening

### Default Agent Choice

**Default to `pi`** for foreground subagents unless the user explicitly requests a different agent:

| User says | Agent to use |
|-----------|--------------|
| "Run this in hands-free" | `pi` |
| "Delegate this task" | `pi` |
| "Use Claude to review this" | `claude` |
| "Have Gemini analyze this" | `gemini` |
| "Run aider to fix this" | `aider` |

Pi is the default because it's already available, has the same capabilities, and maintains consistency. Only use Claude, Gemini, Codex, or other agents when the user specifically asks for them.

## Structured Spawn and `/spawn`

For Pi, Codex, Claude, and Cursor, prefer structured `spawn` params when you want the extension's shared resolver, config defaults, native startup prompt forms, or Pi-only fork/worktree behavior. For unattended coding-agent work in a repository, use `worktree: true` or an explicitly isolated `cwd`; raw commands run in their supplied working directory and can change its Git state:

```typescript
interactive_shell({ spawn: { agent: "pi" }, mode: "interactive" })
interactive_shell({ spawn: { agent: "codex" }, mode: "dispatch" })
interactive_shell({ spawn: { agent: "cursor", prompt: "Review the diffs" }, mode: "dispatch" })
interactive_shell({ spawn: { agent: "claude", prompt: "Review the diffs" }, mode: "dispatch" })
interactive_shell({ spawn: { agent: "claude", worktree: true }, mode: "hands-free" })
interactive_shell({ spawn: { mode: "fork" }, mode: "interactive" }) // Pi-only
```

Structured `spawn` uses the same resolver and defaults as the user-facing `/spawn` command. Raw `command` is still the right choice for arbitrary CLIs and custom launch strings. Users can add their own agents under `spawn.commands`; those keys work in `spawn: { agent: "..." }` just like the built-ins, and an unknown key returns the configured agent list as an error. Cursor structured spawn defaults to `--model composer-2-fast`, which explicitly selects Composer 2 Fast.

For Codex image or design work, Codex can invoke `gpt-image-2` directly from the prompt. Natural language is usually enough, and `$imagegen` forces the image-generation tool when you need it. Attach references with `-i` for edits and iterations. See the bundled `codex-cli` skill for concrete examples.

For users in chat, `/spawn` now supports the configured default agent plus explicit overrides like `/spawn codex`, `/spawn cursor`, `/spawn claude`, `/spawn pi`, `/spawn fork`, `/spawn pi fork`, and any custom agent key from `spawn.commands`. Add `--worktree` to run in a separate git worktree.

Quoted prompt text plus `--hands-free` or `--dispatch` turns `/spawn` into a monitored delegated run instead of a plain interactive overlay:

```bash
/spawn cursor "review the diffs" --dispatch
/spawn claude "review the diffs" --dispatch
/spawn codex "fix the failing tests" --hands-free
/spawn pi fork "continue from here" --dispatch
```

## Foreground Subagent Modes

### Interactive (default)
The overlay opens and returns a stable `sessionId` immediately. The user can type directly, and the agent can send input to the same shell.
```typescript
const { sessionId } = interactive_shell({ command: 'pi' })
interactive_shell({ sessionId, input: '/help', submit: true })
```

### Interactive with Initial Prompt
Agent starts working immediately, user supervises.
```typescript
interactive_shell({ command: 'pi "Review this codebase for security issues"' })
```

### Dispatch (Fire-and-Forget) - NON-BLOCKING, NO POLLING
Agent fires a session and moves on. Notified automatically on completion via `triggerTurn`.

```typescript
// Start session - returns immediately, no polling needed
interactive_shell({
  command: 'pi "Fix all TypeScript errors in src/"',
  mode: "dispatch",
  reason: "Fixing TS errors"
})
// Returns: { sessionId: "calm-reef", mode: "dispatch" }
// → Do other work. When session completes, you receive notification with output.
```

Dispatch defaults `autoExitOnQuiet: true`. A quiet TUI stops local supervision after the threshold, attempts termination, and reports `completionReason: "auto-close-quiet"` separately from user cancellation. Subprocess exit is not confirmed, and this is not a terminal command verdict. The agent can still query the sessionId if needed, but doesn't have to.

For a provider-agnostic external gate watcher, use `mode: "monitor"`, set `handsFree: { autoExitOnQuiet: false }`, set a hard `timeout`, and match explicit terminal lines such as `ready`, `blocked`, and `stale-head`. The watcher command must exit only after it emits a terminal line. If raw dispatch is required, disable quiet auto-close and treat `completionReason: "auto-close-quiet"` as non-terminal.

For fire-and-forget delegated runs (including QA-style delegated checks), prefer dispatch as the default mode.

#### Background Dispatch (Headless)
No overlay opens. Multiple headless dispatches can run concurrently:

```typescript
interactive_shell({
  command: 'pi "Fix lint errors"',
  mode: "dispatch",
  background: true
})
// → No overlay. User can /attach to watch. Agent notified on completion.
```

#### Recoverable selected output (command-only opt-in)

For a finite, raw-command background dispatch only, capture a recoverable source and later request conservative selection:

```typescript
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

### Monitor (Event-Driven, Headless)
Run a background process and wake the agent on structured monitor triggers.

```typescript
interactive_shell({
  command: 'npm test --watch',
  mode: "monitor",
  monitor: {
    strategy: "stream",
    triggers: [
      { id: "failed", literal: "FAIL" },
      { id: "error", regex: "/error|warn/i" }
    ],
    throttle: { dedupeExactLine: true }
  }
})

interactive_shell({
  command: 'curl -sf http://localhost:3000/health',
  mode: "monitor",
  monitor: {
    strategy: "poll-diff",
    triggers: [{ id: "changed", regex: "/./" }],
    poll: { intervalMs: 5000 }
  }
})
```

Use monitor mode for log watchers and long-running checks where polling would be noisy or expensive.

### Optional Jev semantic supervision

Jev is off by default. It sends bounded terminal viewport/recent text to TypeSafe AI only when (1) global `~/.pi/agent/interactive-shell.json` has `jev.enabled: true`, (2) `TYPESAFE_API_KEY` is present in Pi's startup environment, and (3) this session supplies `monitor.semantic`. Never put the key in a tool call or project config. Project config cannot enable Jev or change the model; it can only narrow timeout/retry/text limits and add redactions.

Observe without authorizing terminal input:

```typescript
interactive_shell({
  command: 'pi "Review this change"', mode: "dispatch",
  monitor: { semantic: { goal: "Report a visible result or blocker" } }
})
```

Semantic attention/watch events:

```typescript
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

```typescript
interactive_shell({
  command: "deploy-tool", mode: "monitor",
  monitor: { strategy: "semantic", semantic: { actions: {
    enabled: true, maxActions: 1,
    items: [{ id: "confirm", description: "Confirm the visible ordinary prompt", input: "yes", submit: true, maxExecutions: 1 }]
  } } }
})
```

Actions must be predeclared exact text or strict named keys. Model confidence is not authorization. Secret/credential/payment and process-lifecycle actions are forbidden; process exit remains PTY-owned. User takeover pauses semantics and fresh rendered output is required after control returns. In addition to per-action/session limits, a non-configurable process-wide cap allows 10 semantic action attempts across sessions; refused and throwing writes consume it.

Query decisions with `{ semanticDecisions: true, semanticSessionId }`; query delivered events with `{ monitorEvents: true, monitorSessionId }`; query monitor state with `{ monitorStatus: true, monitorSessionId }`. Provider failure, uncertainty, staleness, or a visible final answer never means completion or permission.

Optional global `jev.diagnostics` is a local, content-free flight recorder. It is off by default (`enabled: false`, 14-day retention, 20 MB per-process cap) and adds no terminal polling or model calls. Query its bounded summary with `{ semanticDiagnostics: true }`. It records only fixed categories, timing/token counts, versions, sanitized model names, and random run/incident IDs—never terminal text, commands, paths, session IDs, hashes, goals, watch conditions, credentials, raw responses, or notes. Each process owns its journal, so recording needs no shared lock.

When normal task work independently reveals a supported discrepancy, report it against the live semantic session with `{ semanticSessionId, semanticIncident: { kind, decisionId?, expectedEvent?, observedEvent? } }`. Kinds are `missed-notification`, `unnecessary-notification`, `wrong-notification-type`, `duplicate-notification`, `premature-result`, and `stale-notification`. Do not inspect the terminal solely to audit Jev. Treat reports as suspected issues until an observable outcome or sanitized reproduction confirms them; add confirmed cases to the corpus and run `npm run eval:jev`. Silent misses remain unobservable unless another normal check exposes them.

Built-in notifications use a confident mutually exclusive attention state: `working` continues, `other` stays uncertain, and input, approval, result, or blocked states emit their matching bounded event. Repeated attention events are suppressed until the primary state changes; watches and action-control events keep their separate delivery semantics. Independent Noul answers remain metadata and support watches/action readiness; they do not authorize input or veto a confident primary attention event.

Configuration defaults/bounds: model `jev-1.13.0`; timeout 10,000 ms (1,000–30,000); retries 1 (0–2); viewport 40 lines (5–80); recent output 4,000 chars (500–8,000); up to 50 global-first/project-added RE2-compatible redaction patterns of 1–512 characters each; global diagnostic retention 1–90 days and storage 1–100 MB. Backreferences, lookaround, nested repetition, and invalid syntax reject config; matches are case-insensitive and replaced literally. Full scrollback, request bodies, action bytes, and keys are not stored in semantic history. Redaction is defense in depth.

Evaluate model changes with explicit `npm run eval:jev`; it reads only the packaged corpus and never runs in normal tests. The pass gate checks attention plus the default user-visible event outcome, while `atomicAccuracy` reports every secondary Noul as a diagnostic.

Data handling: TypeSafe says customer requests/responses are not used to train Jev ([models](https://docs.typesafe.ai/models), [legal](https://docs.typesafe.ai/legal)), while its [privacy policy](https://typesafe.ai/legal/privacy-policy) retains personal data as reasonably necessary. Do not assume default zero retention. Enterprise ZDR is a separate TypeSafe arrangement, not enabled by this SDK integration.

### Hands-Free (Foreground Subagent) - NON-BLOCKING
Agent works autonomously, **returns immediately** with sessionId. You query for status/output and cancel local supervision when done.

```typescript
// 1. Start session - returns immediately
interactive_shell({
  command: 'pi "Fix all TypeScript errors in src/"',
  mode: "hands-free",
  reason: "Fixing TS errors"
})
// Returns: { sessionId: "calm-reef", status: "running" }

// 2. Check status and get new output
interactive_shell({ sessionId: "calm-reef" })
// Returns: { status: "running", output: "...", runtime: 30000 }

// 3. When you see task is complete, cancel local supervision
interactive_shell({ sessionId: "calm-reef", kill: true })
// Returns: { status: "killed", output: "captured output..." } // local cancellation; subprocess exit is not confirmed
```

This is the primary pattern for **foreground subagents** - you delegate to pi (or another agent), query for progress, and decide when the task is done.

## Hands-Free Workflow

### Starting a Session
```typescript
const result = interactive_shell({
  command: 'codex "Review this codebase"',
  mode: "hands-free"
})
// result.details.sessionId = "calm-reef"
// result.details.status = "running"
```

The user sees the overlay immediately. You get control back to continue working. If the user types to take over a monitored hands-free or dispatch session, they can press `Ctrl+G` to return control to the agent.

### Querying Status
```typescript
interactive_shell({ sessionId: "calm-reef" })
```

Returns:
- `status`: "running" | "monitoring" | "user-takeover" | "exited" | "killed" | "backgrounded" (`killed` is local cancellation after best-effort termination signaling, not confirmed subprocess exit)
- `output`: Last 20 lines of rendered terminal (clean, no TUI animation noise)
- `runtime`: Time elapsed in ms

**Rate limited:** Queries are limited to once every 60 seconds. If you query too soon, the tool will automatically wait until the limit expires before returning. The user is watching the overlay in real-time - you're just checking in periodically.

### Ending a Session
```typescript
interactive_shell({ sessionId: "calm-reef", kill: true })
```

Use `kill: true` when the task looks complete to cancel local supervision and attempt termination. Returned output is captured at cancellation and may be incomplete.

### Fire-and-Forget Tasks

For single-task delegations where you don't need multi-turn interaction, enable auto-exit so local supervision stops and termination is attempted when the agent goes quiet:

```typescript
interactive_shell({
  command: 'pi "Review this codebase for security issues. Save your findings to /tmp/security-review.md"',
  mode: "hands-free",
  reason: "Security review",
  handsFree: { autoExitOnQuiet: true }
})
// Session auto-cancels after ~8s of quiet (after the startup grace period)
// Read results from file:
// read("/tmp/security-review.md")
```

**Instruct subagent to save results to a file** since the session closes automatically.

### Multi-Turn Sessions (default)

For back-and-forth interaction, leave auto-exit disabled (the default). Query status and cancel manually when done:

```typescript
interactive_shell({
  spawn: { agent: "cursor" },
  mode: "hands-free",
  reason: "Interactive refactoring"
})

// Send follow-up prompts
interactive_shell({ sessionId: "calm-reef", input: "Now fix the tests", submit: true })

// Cancel local supervision when done
interactive_shell({ sessionId: "calm-reef", kill: true })
```

### Sending Input
```typescript
interactive_shell({ sessionId: "calm-reef", input: "/help", submit: true })
interactive_shell({ sessionId: "calm-reef", inputKeys: ["ctrl+c"] })
interactive_shell({ sessionId: "calm-reef", inputPaste: "multi\nline\ncode" })
interactive_shell({ sessionId: "calm-reef", input: "y", inputKeys: ["enter"] })  // combine text + keys
```

### Query Output

Status queries return **rendered terminal output** (what's actually on screen), not raw stream:
- Default: 20 lines, 5KB max per query
- No TUI animation noise (spinners, progress bars, etc.)
- Configurable via `outputLines` (max: 200) and `outputMaxChars` (max: 50KB)

```typescript
// Get more output when reviewing a session
interactive_shell({ sessionId: "calm-reef", outputLines: 50 })

// Get even more for detailed review
interactive_shell({ sessionId: "calm-reef", outputLines: 100, outputMaxChars: 30000 })
```

### Incremental Reading

Use `incremental: true` to paginate through output without re-reading:

```typescript
// First call: get first 50 lines
interactive_shell({ sessionId: "calm-reef", outputLines: 50, incremental: true })
// → { output: "...", hasMore: true }

// Next call: get next 50 lines (server tracks position)
interactive_shell({ sessionId: "calm-reef", outputLines: 50, incremental: true })
// → { output: "...", hasMore: true }

// Keep calling until hasMore: false
interactive_shell({ sessionId: "calm-reef", outputLines: 50, incremental: true })
// → { output: "...", hasMore: false }
```

The server tracks your read position - just keep calling with `incremental: true` to get the next chunk.

### Reviewing Output

Query sessions to see progress. Increase limits when you need more context:

```typescript
// Default: last 20 lines
interactive_shell({ sessionId: "calm-reef" })

// Get more lines when you need more context
interactive_shell({ sessionId: "calm-reef", outputLines: 50 })

// Get even more for detailed review
interactive_shell({ sessionId: "calm-reef", outputLines: 100, outputMaxChars: 30000 })
```

## Sending Input to Active Sessions

Use the `sessionId` from updates to send input to a running hands-free session:

### Basic Input
```typescript
// Send text and submit it
interactive_shell({ sessionId: "shell-1", input: "/help", submit: true })

// Send text with keys
interactive_shell({ sessionId: "shell-1", input: "/model", inputKeys: ["enter"] })

// Navigate menus
interactive_shell({ sessionId: "shell-1", inputKeys: ["down", "down", "enter"] })

// Interrupt
interactive_shell({ sessionId: "shell-1", inputKeys: ["ctrl+c"] })
```

### Named Keys
| Key | Description |
|-----|-------------|
| `up`, `down`, `left`, `right` | Arrow keys |
| `enter`, `return` | Enter/Return |
| `escape`, `esc` | Escape |
| `tab`, `shift+tab` (or `btab`) | Tab / Back-tab |
| `backspace`, `bspace` | Backspace |
| `delete`, `del`, `dc` | Delete |
| `insert`, `ic` | Insert |
| `home`, `end` | Home/End |
| `pageup`, `pgup`, `ppage` | Page Up |
| `pagedown`, `pgdn`, `npage` | Page Down |
| `f1`-`f12` | Function keys |
| `kp0`-`kp9`, `kp/`, `kp*`, `kp-`, `kp+`, `kp.`, `kpenter` | Keypad keys |
| `ctrl+c`, `ctrl+d`, `ctrl+z` | Control sequences |
| `ctrl+a` through `ctrl+z` | All control keys |

Note: `ic`/`dc`, `ppage`/`npage`, `bspace` are tmux-style aliases for compatibility.

### Modifier Combinations
Supports `ctrl+`, `alt+`, `shift+` prefixes (or shorthand `c-`, `m-`, `s-`):
```typescript
// Cancel
inputKeys: ["ctrl+c"]

// Alt+Tab
inputKeys: ["alt+tab"]

// Ctrl+Alt+Delete
inputKeys: ["ctrl+alt+delete"]

// Shorthand syntax
inputKeys: ["c-c", "m-x", "s-tab"]
```

### Hex Bytes (Advanced)
Send raw escape sequences:
```typescript
inputHex: ["0x1b", "0x5b", "0x41"]  // ESC[A (up arrow)
```

### Bracketed Paste
Paste multiline text without triggering autocompletion/execution:
```typescript
inputPaste: "function foo() {\n  return 42;\n}"
```

### Model Selection Example
```typescript
// Step 1: Open model selector
interactive_shell({ sessionId: "shell-1", input: "/model", inputKeys: ["enter"] })

// Step 2: Filter and select (after ~500ms delay)
interactive_shell({ sessionId: "shell-1", input: "sonnet", inputKeys: ["enter"] })

// Or navigate with arrows:
interactive_shell({ sessionId: "shell-1", inputKeys: ["down", "down", "down", "enter"] })
```

### Context Compaction
```typescript
interactive_shell({ sessionId: "shell-1", input: "/compact", submit: true })
```

For editor-based TUIs like pi, raw `input` only types text. It does not submit the prompt. Prefer `submit: true` or `inputKeys: ["enter"]` instead of relying on `\n`.

### Changing Update Settings
Adjust timing during a session:
```typescript
// Change max interval (fallback for on-quiet mode)
interactive_shell({ sessionId: "calm-reef", settings: { updateInterval: 120000 } })

// Change quiet threshold (how long to wait after output stops)
interactive_shell({ sessionId: "calm-reef", settings: { quietThreshold: 3000 } })

// Both at once
interactive_shell({ sessionId: "calm-reef", settings: { updateInterval: 30000, quietThreshold: 2000 } })
```

## CLI Quick Reference

| Agent | Interactive | With Prompt | Headless (bash) | Dispatch |
|-------|-------------|-------------|-----------------|----------|
| `claude` | `claude` | `claude "prompt"` | `claude -p "prompt"` | `mode: "dispatch"` |
| `gemini` | `gemini` | `gemini -i "prompt"` | `gemini "prompt"` | `mode: "dispatch"` |
| `codex` | `codex` | `codex "prompt"` | `codex exec "prompt"` | `mode: "dispatch"` |
| `agent` | `agent` | `agent "prompt"` | `agent -p "prompt"` | `mode: "dispatch"` |
| `pi` | `pi` | `pi "prompt"` | `pi -p "prompt"` | `mode: "dispatch"` |

**Gemini model:** `gemini -m gemini-3-flash-preview -i "prompt"`

## Prompt Packaging Rules

The `reason` parameter is **UI-only** - it's shown in the overlay header but NOT passed to the subprocess.

To give the agent an initial prompt, embed it in the `command`:
```typescript
// WRONG - agent starts idle, reason is just UI text
interactive_shell({ command: 'claude', reason: 'Review the codebase' })

// RIGHT - agent receives the prompt
interactive_shell({ command: 'claude "Review the codebase"', reason: 'Code review' })
```

## Handoff Options

### Transfer (Ctrl+T) - Recommended
When the subagent finishes, the user presses **Ctrl+T** to transfer output directly to you:

```
[Subagent finishes work in overlay]
        ↓
[User presses Ctrl+T]
        ↓
[You receive: "Session output transferred (150 lines):
  
  Completing skill integration...
  Modified files:
  - skills.ts
  - agents/types/..."]
```

This is the cleanest workflow - the subagent's response becomes your context automatically.

**Configuration:** `transferLines` (default: 200), `transferMaxChars` (default: 20KB)

### Tail Preview (default)
Last 30 lines included in tool result. Good for seeing errors/final status.

### Snapshot to File
Write full transcript to `~/.pi/agent/cache/interactive-shell/snapshot-*.log`:
```typescript
interactive_shell({
  command: 'claude "Fix bugs"',
  handoffSnapshot: { enabled: true, lines: 200 }
})
```

### Artifact Handoff (for complex tasks)
Instruct the delegated agent to write a handoff file:
```
Write your findings to .pi/delegation/claude-handoff.md including:
- What you did
- Files changed
- Any errors
- Next steps for the main agent
```

## Safe TUI Capture

**Never run TUI agents via bash** - they hang even with `--help`. Use `interactive_shell` with `timeout` instead:

```typescript
interactive_shell({
  command: "pi --help",
  mode: "hands-free",
  timeout: 5000  // Auto-cancel after 5 seconds and attempt termination
})
```

The session is locally cancelled after timeout, termination is attempted, and captured output is returned in the handoff preview. Subprocess exit is not confirmed. This is useful for:
- Getting CLI help from TUI applications
- Capturing output from commands that don't exit cleanly
- Any TUI command where you need quick output without user interaction

For pi CLI documentation, you can also read directly: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/README.md`

## Background Session Management

```typescript
// Background an active session (close overlay, keep running)
interactive_shell({ sessionId: "calm-reef", background: true })

// List all background sessions
interactive_shell({ listBackground: true })

// Reattach to a background session
interactive_shell({ attach: "calm-reef" })                    // interactive (blocking)
interactive_shell({ attach: "calm-reef", mode: "hands-free" })  // hands-free (poll)
interactive_shell({ attach: "calm-reef", mode: "dispatch" })    // dispatch (notified)

// Dismiss background sessions (cancel running, remove exited)
interactive_shell({ dismissBackground: true })               // all
interactive_shell({ dismissBackground: "calm-reef" })        // specific

// Start an event-driven monitor session (headless)
interactive_shell({
  command: 'npm test --watch',
  mode: "monitor",
  monitor: { strategy: "stream", triggers: [{ id: "failed", literal: "FAIL" }] }
})
```

## Local Testing Hygiene

When using `interactive_shell` for one-off local testing, do **not** leave sessions running in the background unless the user explicitly wants them kept alive. A stack of background sessions in the widget usually means the agent used backgrounding as an escape hatch and never cleaned up.

Best practice:
- Prefer `kill: true` or normal process exit for finite test runs.
- Only background a session if you expect to come back to it soon or the user asked to keep it.
- Before ending the task, sweep background sessions created for testing.
- Keep background sessions only for intentional long-lived work like dev servers, watchers, or manual validation the user is actively using.

Typical cleanup flow:

```typescript
// Inspect what is still running
interactive_shell({ listBackground: true })

// Dismiss a specific leftover test session
interactive_shell({ dismissBackground: "keen-cove" })

// Or, if the background sessions were just temporary test artifacts from this task,
// dismiss all of them in one sweep
interactive_shell({ dismissBackground: true })
```

To locally cancel and dismiss all backgrounded interactive shell sessions in one sweep, use `interactive_shell({ dismissBackground: true })`. Termination is attempted but subprocess exit is not confirmed.

Decision rule:
- **One-off test / repro / validation run** → cancel or dismiss it when done.
- **Dev server / watch mode / ongoing manual check** → background only if the user wants it preserved.

If the user backgrounds a session manually with `Ctrl+B`, the agent should still clean it up later unless the user clearly wants it kept.

## Quick Reference

**Dispatch subagent (fire-and-forget, default to pi):**
```typescript
interactive_shell({
  command: 'pi "Implement the feature described in SPEC.md"',
  mode: "dispatch",
  reason: "Implementing feature"
})
// Returns immediately. You'll be notified when done.
```

**Background dispatch (headless, no overlay):**
```typescript
interactive_shell({
  command: 'pi "Fix lint errors"',
  mode: "dispatch",
  background: true,
  reason: "Fixing lint"
})
```

**Monitor watcher (event-driven, no polling):**
```typescript
interactive_shell({
  command: 'npm run dev',
  mode: "monitor",
  monitor: {
    strategy: "stream",
    triggers: [{ id: "warn", regex: "/error|warn/i" }],
    persistence: { stopAfterFirstEvent: false }
  },
  reason: "Wake me on server warnings"
})
```

**Start foreground subagent (hands-free, default to pi):**
```typescript
interactive_shell({
  command: 'pi "Implement the feature described in SPEC.md"',
  mode: "hands-free",
  reason: "Implementing feature"
})
// Returns sessionId in updates, e.g., "shell-1"
```

**Send input to active session:**
```typescript
// Text with enter
interactive_shell({ sessionId: "calm-reef", input: "/compact", submit: true })

// Text + named keys
interactive_shell({ sessionId: "calm-reef", input: "/model", inputKeys: ["enter"] })

// Menu navigation
interactive_shell({ sessionId: "calm-reef", inputKeys: ["down", "down", "enter"] })
```

**Change update frequency:**
```typescript
interactive_shell({ sessionId: "calm-reef", settings: { updateInterval: 60000 } })
```

**Foreground subagent (user requested different agent):**
```typescript
interactive_shell({
  command: 'claude "Review this code for security issues"',
  mode: "hands-free",
  reason: "Security review with Claude"
})
```

**Background subagent:**
```typescript
subagent({ agent: "scout", task: "Find all TODO comments" })
```
