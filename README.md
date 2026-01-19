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
interactive_shell({ sessionId: "calm-reef", input: { keys: ["ctrl+c"] } })

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

Sessions auto-close after 5s of silence. Disable with `handsFree: { autoExitOnQuiet: false }`.

### Send Input

```typescript
// Text
interactive_shell({ sessionId: "calm-reef", input: "SELECT * FROM users;\n" })

// Named keys
interactive_shell({ sessionId: "calm-reef", input: { keys: ["ctrl+c"] } })
interactive_shell({ sessionId: "calm-reef", input: { keys: ["down", "down", "enter"] } })

// Bracketed paste (multiline without execution)
interactive_shell({ sessionId: "calm-reef", input: { paste: "line1\nline2\nline3" } })
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

### Background Sessions

1. Ctrl+Q → "Run in background"
2. `/attach` or `/attach <id>` to reattach

## Keys

| Key | Action |
|-----|--------|
| Ctrl+Q | Detach dialog |
| Shift+Up/Down | Scroll history |
| Any key (hands-free) | Take over control |

## Config

`~/.pi/agent/settings.json` under `extensions.interactive-shell`:

```json
{
  "overlayHeightPercent": 45,
  "overlayWidthPercent": 95,
  "scrollbackLines": 5000,
  "minQueryIntervalSeconds": 60,
  "handsFreeQuietThreshold": 5000
}
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

## Advanced: Multi-Agent Workflows

For orchestrating multi-agent chains (scout → planner → worker → reviewer) with file-based handoff and auto-continue support, see:

**[pi-foreground-chains](https://github.com/nicobailon/pi-foreground-chains)** - A separate skill that builds on interactive-shell for complex agent workflows.

## Limitations

- macOS tested, Linux experimental
- 60s rate limit between queries (configurable)
- Some TUI apps may have rendering quirks
