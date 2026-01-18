# Pi Interactive Shell

An extension for [Pi coding agent](https://github.com/badlogic/pi-mono/) that lets Pi run any interactive CLI in a TUI overlay - including other AI agents. Drive Claude, Gemini, Codex, Cursor directly from Pi. Watch it work, take over anytime. Real PTY, full terminal emulation, no tmux needed.

```typescript
interactive_shell({ command: 'agent "fix all the bugs"', mode: "hands-free" })
// Returns immediately with sessionId
// User watches in overlay, you query for status
// Session auto-closes when agent finishes
```

## Why

AI agents delegating to other AI agents is powerful but messy:

- **Visibility** - What's the subagent doing? Is it stuck?
- **Control** - User needs to intervene. How?
- **Integration** - When does the parent agent check in?

Interactive Shell solves all three:

**Real-Time Overlay** - User sees the subprocess in a TUI overlay. Full terminal emulation via xterm-headless. ANSI colors, cursor movement, everything.

**Seamless Takeover** - Type anything to take control. Scroll with Shift+Up/Down. Double-Escape to detach.

**Non-Blocking API** - Start a session, get a sessionId, query for status. Rate-limited to prevent spam. Auto-exits when output stops.

**Any CLI** - Not just AI agents. Run `htop`, `vim`, `psql`, `ssh` - anything interactive.

## Install

```bash
npx pi-interactive-shell
```

Installs to `~/.pi/agent/extensions/interactive-shell/`.

**Requires:** Node.js, build tools for `node-pty` (Xcode CLI tools on macOS).

## Quick Start

### Hands-Free (Agent-to-Agent)

```typescript
// Start - returns immediately
interactive_shell({
  command: 'pi "Refactor the auth module"',
  mode: "hands-free"
})
// → { sessionId: "calm-reef", status: "running" }

// Query status (rate-limited to 60s)
interactive_shell({ sessionId: "calm-reef" })
// → { status: "running", output: "...", runtime: 45000 }

// Get more output
interactive_shell({ sessionId: "calm-reef", outputLines: 100 })

// Kill when done (or let autoExitOnQuiet handle it)
interactive_shell({ sessionId: "calm-reef", kill: true })
```

### Interactive (User Control)

```typescript
interactive_shell({ command: 'vim package.json' })
```

### Send Input

```typescript
interactive_shell({ sessionId: "calm-reef", input: "/help\n" })
interactive_shell({ sessionId: "calm-reef", input: { keys: ["ctrl+c"] } })
interactive_shell({ sessionId: "calm-reef", input: { keys: ["down", "down", "enter"] } })
```

## CLI Reference

| Agent | Interactive | With Prompt | Headless (use bash) |
|-------|-------------|-------------|---------------------|
| `claude` | `claude` | `claude "prompt"` | `claude -p "prompt"` |
| `gemini` | `gemini` | `gemini -i "prompt"` | `gemini "prompt"` |
| `codex` | `codex` | `codex "prompt"` | `codex exec "prompt"` |
| `agent` | `agent` | `agent "prompt"` | `agent -p "prompt"` |
| `pi` | `pi` | `pi "prompt"` | `pi -p "prompt"` |

## Features

### Auto-Exit on Quiet

Sessions auto-close after 5s of silence. Disable with `handsFree: { autoExitOnQuiet: false }`.

### Timeout for TUI Capture

```typescript
interactive_shell({
  command: "pi --help",
  mode: "hands-free",
  timeout: 5000  // Kill after 5s, return captured output
})
```

### Configurable Output

```typescript
// Default: 20 lines, 5KB
interactive_shell({ sessionId: "calm-reef" })

// More lines (max: 200)
interactive_shell({ sessionId: "calm-reef", outputLines: 100 })

// More content (max: 50KB)
interactive_shell({ sessionId: "calm-reef", outputMaxChars: 30000 })
```

### Input Methods

| Method | Example |
|--------|---------|
| Text | `input: "/model\n"` |
| Keys | `input: { keys: ["enter", "ctrl+c"] }` |
| Hex | `input: { hex: ["0x1b", "0x5b", "0x41"] }` |
| Paste | `input: { paste: "multi\nline" }` |

### Background Sessions

1. Double-Escape → "Run in background"
2. `/attach` or `/attach <id>` to reattach

## Config

`~/.pi/agent/interactive-shell.json`

```json
{
  "overlayHeightPercent": 45,
  "overlayWidthPercent": 95,
  "scrollbackLines": 5000,
  "minQueryIntervalSeconds": 60,
  "handsFreeQuietThreshold": 5000
}
```

## Keys

| Key | Action |
|-----|--------|
| Double-Escape | Detach dialog |
| Shift+Up/Down | Scroll history |
| Any key (hands-free) | Take over control |

## Token Efficiency

Unlike the standard tmux workflow where you `capture-pane` the entire terminal on every poll, Interactive Shell minimizes token waste:

**Incremental Aggregation** - Output is accumulated as it arrives, not re-captured on each query.

**Tail by Default** - Status queries return only the last 20 lines (configurable), not the full history.

**ANSI Stripping** - All escape codes are stripped before sending output to the agent. Clean text only.

**Drain Mode** - Use `drain: true` to get only NEW output since last query. No re-reading old content.

```typescript
// First query: get recent output
interactive_shell({ sessionId: "calm-reef" })
// → returns last 20 lines

// Subsequent queries: get only new output (incremental)
interactive_shell({ sessionId: "calm-reef", drain: true })
// → returns only output since last query
```

**Offset/Limit Pagination** - Read specific ranges of the full output log.

```typescript
// Read lines 0-49
interactive_shell({ sessionId: "calm-reef", outputOffset: 0, outputLines: 50 })

// Read lines 50-99
interactive_shell({ sessionId: "calm-reef", outputOffset: 50, outputLines: 50 })
```

## How It Works

```
interactive_shell → node-pty → subprocess
                  ↓
            xterm-headless (terminal emulation)
                  ↓
            TUI overlay (pi rendering)
```

Full PTY. The subprocess thinks it's in a real terminal.

## Limitations

- macOS tested, Linux experimental
- 60s rate limit between queries (configurable)
- Some TUI apps may have rendering quirks
