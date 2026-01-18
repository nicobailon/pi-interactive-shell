---
name: interactive-shell
description: Cheat sheet + workflow for launching interactive coding-agent CLIs (Claude Code, Gemini CLI, Codex CLI, Cursor CLI, and pi itself) via the interactive_shell overlay. The overlay is for interactive supervision only - headless commands should use the bash tool instead.
---

# Interactive Shell (Skill)

Last verified: 2026-01-17

## Foreground vs Background Subagents

Pi has two ways to delegate work to other AI coding agents:

| | Foreground Subagents | Background Subagents |
|---|---|---|
| **Tool** | `interactive_shell` | `subagent` |
| **Visibility** | User sees overlay in real-time | Hidden from user |
| **Default agent** | `pi` (others if user requests) | Pi only |
| **Output** | Minimal (tail preview) | Full output captured |
| **User control** | Can take over anytime | No intervention |
| **Best for** | Long tasks needing supervision | Parallel tasks, structured delegation |

**Foreground subagents** run in an overlay where the user watches (and can intervene). Use `interactive_shell` with `mode: "hands-free"` to monitor while receiving periodic updates.

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
// result.sessionId = "calm-reef"
// result.status = "running"
```

The user sees the overlay immediately. You get control back to continue working.

### Querying Status
```typescript
interactive_shell({ sessionId: "calm-reef" })
```

Returns:
- `status`: "running" | "user-takeover" | "exited" | "killed" | "backgrounded"
- `output`: Last 20 lines of rendered terminal (clean, no TUI animation noise)
- `runtime`: Time elapsed in ms

**Don't query too frequently!** Wait 30-60 seconds between checks. The user is watching the overlay in real-time - you're just checking in periodically to see progress.

### Ending a Session
```typescript
interactive_shell({ sessionId: "calm-reef", kill: true })
```

Kill when you see the task is complete in the output. Returns final status and output.

### Sending Input
```typescript
interactive_shell({ sessionId: "calm-reef", input: "/help\n" })
interactive_shell({ sessionId: "calm-reef", input: { keys: ["ctrl+c"] } })
```

### Query Output

Status queries return **rendered terminal output** (what's actually on screen), not raw stream:
- Last 20 lines of the terminal, clean and readable
- No TUI animation noise (spinners, progress bars, etc.)
- Max 5KB per query to keep context manageable
- Configure via `handsFree.maxTotalChars`

```typescript
// Custom budget for a long task
interactive_shell({
  command: 'pi "Refactor entire codebase"',
  mode: "hands-free",
  handsFree: { maxTotalChars: 200000 }  // 200KB budget
})
```

## Sending Input to Active Sessions

Use the `sessionId` from updates to send input to a running hands-free session:

### Basic Input
```typescript
// Send text
interactive_shell({ sessionId: "shell-1", input: "/help\n" })

// Send with named keys
interactive_shell({ sessionId: "shell-1", input: { text: "/model", keys: ["enter"] } })

// Navigate menus
interactive_shell({ sessionId: "shell-1", input: { keys: ["down", "down", "enter"] } })

// Interrupt
interactive_shell({ sessionId: "shell-1", input: { keys: ["ctrl+c"] } })
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
{ keys: ["ctrl+c"] }

// Alt+Tab
{ keys: ["alt+tab"] }

// Ctrl+Alt+Delete
{ keys: ["ctrl+alt+delete"] }

// Shorthand syntax
{ keys: ["c-c", "m-x", "s-tab"] }
```

### Hex Bytes (Advanced)
Send raw escape sequences:
```typescript
{ hex: ["0x1b", "0x5b", "0x41"] }  // ESC[A (up arrow)
```

### Bracketed Paste
Paste multiline text without triggering autocompletion/execution:
```typescript
{ paste: "function foo() {\n  return 42;\n}" }
```

### Model Selection Example
```typescript
// Step 1: Open model selector
interactive_shell({ sessionId: "shell-1", input: { text: "/model", keys: ["enter"] } })

// Step 2: Filter and select (after ~500ms delay)
interactive_shell({ sessionId: "shell-1", input: { text: "sonnet", keys: ["enter"] } })

// Or navigate with arrows:
interactive_shell({ sessionId: "shell-1", input: { keys: ["down", "down", "down", "enter"] } })
```

### Context Compaction
```typescript
interactive_shell({ sessionId: "shell-1", input: { text: "/compact", keys: ["enter"] } })
```

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

## CLI Cheat Sheet

### Claude Code (`claude`)

| Mode | Command |
|------|---------|
| Interactive (idle) | `claude` |
| Interactive (prompted) | `claude "Explain this project"` |
| Headless (use bash, not overlay) | `claude -p "Explain this function"` |

### Gemini CLI (`gemini`)

| Mode | Command |
|------|---------|
| Interactive (idle) | `gemini` |
| Interactive (prompted) | `gemini -i "Explain this codebase"` |
| Headless (use bash, not overlay) | `gemini -p "What is fine tuning?"` |

### Codex CLI (`codex`)

| Mode | Command |
|------|---------|
| Interactive (idle) | `codex` |
| Interactive (prompted) | `codex "Explain this codebase"` |
| Headless (use bash, not overlay) | `codex exec "summarize the repo"` |

### Cursor CLI (`cursor-agent`)

| Mode | Command |
|------|---------|
| Interactive (idle) | `cursor-agent` |
| Interactive (prompted) | `cursor-agent "review this repo"` |
| Headless (use bash, not overlay) | `cursor-agent -p "find issues" --output-format text` |

### Pi (`pi`)

| Mode | Command |
|------|---------|
| Interactive (idle) | `pi` |
| Interactive (prompted) | `pi "List all .ts files"` |
| Headless (use bash, not overlay) | `pi -p "List all .ts files"` |

Note: Delegating pi to pi is recursive - usually prefer `subagent` for pi-to-pi delegation.

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

### Artifact Handoff (recommended for complex tasks)
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

## Quick Reference

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
interactive_shell({ sessionId: "calm-reef", input: "/compact\n" })

// Named keys
interactive_shell({ sessionId: "calm-reef", input: { text: "/model", keys: ["enter"] } })

// Menu navigation
interactive_shell({ sessionId: "calm-reef", input: { keys: ["down", "down", "enter"] } })
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
