---
name: pi-interactive-shell
description: Cheat sheet + workflow for launching interactive coding-agent CLIs (Claude Code, Gemini CLI, Codex CLI, Cursor CLI, and pi itself) via the interactive_shell overlay, headless dispatch, or monitor mode. Use for TUI agents and long-running processes that need supervision, fire-and-forget delegation, or event-driven background monitoring. Regular bash commands should use the bash tool instead.
---

# Interactive Shell (Skill)

Last verified: 2026-04-11

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

**Foreground subagents** run in an overlay where the user watches (and can intervene). Use `interactive_shell` with `mode: "hands-free"` to monitor while receiving periodic updates, or `mode: "dispatch"` to be notified on completion without polling.

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

For Pi, Codex, and Claude, prefer structured `spawn` params when you want the extension's shared resolver, config defaults, native startup prompt forms, or Pi-only fork/worktree behavior:

```typescript
interactive_shell({ spawn: { agent: "pi" }, mode: "interactive" })
interactive_shell({ spawn: { agent: "codex" }, mode: "dispatch" })
interactive_shell({ spawn: { agent: "claude", prompt: "Review the diffs" }, mode: "dispatch" })
interactive_shell({ spawn: { agent: "claude", worktree: true }, mode: "hands-free" })
interactive_shell({ spawn: { mode: "fork" }, mode: "interactive" }) // Pi-only
```

Structured `spawn` uses the same resolver and defaults as the user-facing `/spawn` command. Raw `command` is still the right choice for arbitrary CLIs and custom launch strings.

For Codex image or design work, Codex can invoke `gpt-image-2` directly from the prompt. Natural language is usually enough, and `$imagegen` forces the image-generation tool when you need it. Attach references with `-i` for edits and iterations. See the bundled `codex-cli` skill for concrete examples.

For users in chat, `/spawn` now supports the configured default agent plus explicit overrides like `/spawn codex`, `/spawn claude`, `/spawn pi`, `/spawn fork`, and `/spawn pi fork`. Add `--worktree` to run in a separate git worktree.

Quoted prompt text plus `--hands-free` or `--dispatch` turns `/spawn` into a monitored delegated run instead of a plain interactive overlay:

```bash
/spawn claude "review the diffs" --dispatch
/spawn codex "fix the failing tests" --hands-free
/spawn pi fork "continue from here" --dispatch
```

## Foreground Subagent Modes

### Interactive (default)
User has full control, types directly into the agent.
```typescript
interactive_shell({ command: 'pi' })
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

Dispatch defaults `autoExitOnQuiet: true`. The agent can still query the sessionId if needed, but doesn't have to.

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

### Hands-Free (Foreground Subagent) - NON-BLOCKING
Agent works autonomously, **returns immediately** with sessionId. You query for status/output and kill when done.

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

// 3. When you see task is complete, kill session
interactive_shell({ sessionId: "calm-reef", kill: true })
// Returns: { status: "killed", output: "final output..." }
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
- `status`: "running" | "monitoring" | "user-takeover" | "exited" | "killed" | "backgrounded"
- `output`: Last 20 lines of rendered terminal (clean, no TUI animation noise)
- `runtime`: Time elapsed in ms

**Rate limited:** Queries are limited to once every 60 seconds. If you query too soon, the tool will automatically wait until the limit expires before returning. The user is watching the overlay in real-time - you're just checking in periodically.

### Ending a Session
```typescript
interactive_shell({ sessionId: "calm-reef", kill: true })
```

Kill when you see the task is complete in the output. Returns final status and output.

### Fire-and-Forget Tasks

For single-task delegations where you don't need multi-turn interaction, enable auto-exit so the session kills itself when the agent goes quiet:

```typescript
interactive_shell({
  command: 'pi "Review this codebase for security issues. Save your findings to /tmp/security-review.md"',
  mode: "hands-free",
  reason: "Security review",
  handsFree: { autoExitOnQuiet: true }
})
// Session auto-kills after ~8s of quiet (after the startup grace period)
// Read results from file:
// read("/tmp/security-review.md")
```

**Instruct subagent to save results to a file** since the session closes automatically.

### Multi-Turn Sessions (default)

For back-and-forth interaction, leave auto-exit disabled (the default). Query status and kill manually when done:

```typescript
interactive_shell({
  command: 'cursor-agent -f',
  mode: "hands-free",
  reason: "Interactive refactoring"
})

// Send follow-up prompts
interactive_shell({ sessionId: "calm-reef", input: "Now fix the tests", submit: true })

// Kill when done
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
  timeout: 5000  // Auto-kill after 5 seconds
})
```

The process is killed after timeout and captured output is returned in the handoff preview. This is useful for:
- Getting CLI help from TUI applications
- Capturing output from commands that don't exit cleanly
- Any TUI command where you need quick output without user interaction

For pi CLI documentation, you can also read directly: `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/README.md`

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

// Dismiss background sessions (kill running, remove exited)
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

To kill all backgrounded interactive shell sessions and their processes in one sweep, use `interactive_shell({ dismissBackground: true })`.

Decision rule:
- **One-off test / repro / validation run** → kill or dismiss it when done.
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
