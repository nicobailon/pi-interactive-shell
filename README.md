<p>
  <img src="banner.png" alt="pi-interactive-shell" width="1100">
</p>

# Pi Interactive Shell

An extension for [Pi coding agent](https://github.com/badlogic/pi-mono/) that lets Pi autonomously run interactive CLIs in an observable TUI overlay. Pi controls the subprocess while you watch - take over anytime.

https://github.com/user-attachments/assets/76f56ecd-fc12-4d92-a01e-e6ae9ba65ff4

```typescript
interactive_shell({ command: 'vim config.yaml' })
```

## Why

Some tasks need interactive CLIs - editors, REPLs, database shells, long-running processes. Pi can launch them in an overlay where:

- **User watches** - See exactly what's happening in real-time
- **User takes over** - Type anything to gain control
- **Agent monitors** - Query status, send input, decide when done

Works with any CLI: `vim`, `htop`, `psql`, `ssh`, `docker logs -f`, `npm run dev`, `git rebase -i`, etc.

## Install

```bash
npx pi-interactive-shell
```

Installs to `~/.pi/agent/extensions/interactive-shell/`.

The `interactive-shell` skill is automatically symlinked to `~/.pi/agent/skills/interactive-shell/`.

**Requires:** Node.js, build tools for `node-pty` (Xcode CLI tools on macOS).

## Quick Start

### Interactive Mode

User controls the session directly:

```typescript
interactive_shell({ command: 'vim package.json' })
interactive_shell({ command: 'psql -d mydb' })
interactive_shell({ command: 'ssh user@server' })
```

### Hands-Free Mode

Agent monitors while user watches. Returns immediately with sessionId:

```typescript
// Start a long-running process
interactive_shell({
  command: 'npm run dev',
  mode: "hands-free",
  reason: "Dev server"
})
// → { sessionId: "calm-reef", status: "running" }

// Query status (rate-limited to 60s)
interactive_shell({ sessionId: "calm-reef" })
// → { status: "running", output: "...", runtime: 45000 }

// Send input if needed
interactive_shell({ sessionId: "calm-reef", inputKeys: ["ctrl+c"] })

// Kill when done
interactive_shell({ sessionId: "calm-reef", kill: true })
```

User sees the overlay in real-time. Type anything to take over control.

### Timeout Mode

Capture output from TUI apps that don't exit cleanly:

```typescript
interactive_shell({
  command: "htop",
  mode: "hands-free",
  timeout: 3000  // Kill after 3s, return captured output
})
```

## Features

### Auto-Exit on Quiet

For fire-and-forget single-task delegations, enable auto-exit to kill the session after 5s of output silence:

```typescript
interactive_shell({
  command: 'cursor-agent -f "Fix the bug in auth.ts"',
  mode: "hands-free",
  handsFree: { autoExitOnQuiet: true }
})
```

For multi-turn sessions where you need back-and-forth interaction, leave it disabled (default) and use `kill: true` when done.

### Send Input

```typescript
// Text
interactive_shell({ sessionId: "calm-reef", input: "SELECT * FROM users;\n" })

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

1. Ctrl+Q → "Run in background"
2. `/attach` or `/attach <id>` to reattach

## Keys

| Key | Action |
|-----|--------|
| Ctrl+T | **Transfer & close** - capture output and send to main agent |
| Ctrl+Q | Session menu (transfer/background/kill/cancel) |
| Shift+Up/Down | Scroll history |
| Any key (hands-free) | Take over control |

## Config

Configuration files (project overrides global):
- **Global:** `~/.pi/agent/interactive-shell.json`
- **Project:** `.pi/interactive-shell.json`

```json
{
  "overlayWidthPercent": 95,
  "overlayHeightPercent": 45,
  "scrollbackLines": 5000,
  "exitAutoCloseDelay": 10,
  "minQueryIntervalSeconds": 60,
  "transferLines": 200,
  "transferMaxChars": 20000,
  "handsFreeUpdateMode": "on-quiet",
  "handsFreeUpdateInterval": 60000,
  "handsFreeQuietThreshold": 5000,
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
| `overlayWidthPercent` | 95 | Overlay width (10-100%) |
| `overlayHeightPercent` | 45 | Overlay height (20-90%) |
| `scrollbackLines` | 5000 | Terminal scrollback buffer |
| `exitAutoCloseDelay` | 10 | Seconds before auto-close after exit |
| `minQueryIntervalSeconds` | 60 | Rate limit between agent queries |
| `transferLines` | 200 | Lines to capture on Ctrl+T transfer (10-1000) |
| `transferMaxChars` | 20000 | Max chars for transfer (1KB-100KB) |
| `handsFreeUpdateMode` | "on-quiet" | "on-quiet" or "interval" |
| `handsFreeQuietThreshold` | 5000 | Silence duration before update (ms) |
| `handsFreeUpdateInterval` | 60000 | Max interval between updates (ms) |
| `handsFreeUpdateMaxChars` | 1500 | Max chars per update |
| `handsFreeMaxTotalChars` | 100000 | Total char budget for updates |
| `handoffPreviewEnabled` | true | Include tail in tool result |
| `handoffSnapshotEnabled` | false | Write transcript on detach/exit |
| `ansiReemit` | true | Preserve ANSI colors in output |

## How It Works

```
interactive_shell → node-pty → subprocess
                  ↓
            xterm-headless (terminal emulation)
                  ↓
            TUI overlay (pi rendering)
```

Full PTY. The subprocess thinks it's in a real terminal.

## Advanced: Multi-Agent Workflows

For orchestrating multi-agent chains (scout → planner → worker → reviewer) with file-based handoff and auto-continue support, see:

**[pi-foreground-chains](https://github.com/nicobailon/pi-foreground-chains)** - A separate skill that builds on interactive-shell for complex agent workflows.

## Limitations

- macOS tested, Linux experimental
- 60s rate limit between queries (configurable)
- Some TUI apps may have rendering quirks
