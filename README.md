# Pi Interactive Shell Overlay

An extension for [pi-coding-agent](https://github.com/badlogic/pi-mono/) that runs AI coding agents (Claude Code, Gemini CLI, Codex, Aider, etc.) as **foreground subagents** inside a TUI overlay. The user sees the agent working in real-time and can take over control at any time.

This is distinct from **background subagents** (the `subagent` tool) which run pi instances invisibly.

## Foreground vs Background Subagents

| | Foreground (`interactive_shell`) | Background (`subagent`) |
|---|---|---|
| **Visibility** | User sees overlay | Hidden |
| **Agents** | Any CLI agent | Pi only |
| **Output** | Incremental updates | Full capture |
| **User control** | Can intervene | None |

## Install

```bash
npx pi-interactive-shell
```

This installs the extension to `~/.pi/agent/extensions/interactive-shell/`, runs `npm install` for dependencies, and creates the skill symlink.

**Requirements:** `node-pty` requires build tools (Xcode Command Line Tools on macOS).

**Manual install:** If you prefer, clone/copy the files manually and run `npm install` in the extension directory.

## Usage

### Tool: `interactive_shell`

**Start a new session:**
- `command` (string, required): CLI agent command
- `cwd` (string): working directory
- `name` (string): session name (used in sessionId)
- `reason` (string): shown in overlay header (UI-only, not passed to subprocess)
- `mode` (string): `"interactive"` (default) or `"hands-free"`
- `timeout` (number): auto-kill after N milliseconds (for TUI commands that don't exit)
- `handsFree` (object): options for hands-free mode
  - `updateMode` (string): `"on-quiet"` (default) or `"interval"`
  - `updateInterval` (number): max ms between updates, fallback for on-quiet (default: 60000)
  - `quietThreshold` (number): ms of silence before emitting update in on-quiet mode (default: 5000)
  - `updateMaxChars` (number): max chars per update (default: 1500)
  - `maxTotalChars` (number): total char budget for all updates (default: 100000)
- `handoffPreview` (object): tail preview in tool result
- `handoffSnapshot` (object): write transcript to file

**Send input to active session:**
- `sessionId` (string, required): session ID from hands-free updates
- `input` (string | object): input to send
  - As string: raw text/keystrokes (e.g., `"/model\n"`)
  - As object: `{ text?, keys?, hex?, paste? }`

**Change settings mid-session:**
- `sessionId` (string, required): session ID
- `settings` (object): `{ updateInterval?, quietThreshold? }`

**Query session status:**
- `sessionId` (string, required): session ID
- `outputLines` (number): lines to return (default: 20, max: 200)
- `outputMaxChars` (number): max chars to return (default: 5KB, max: 50KB)
- `kill` (boolean): kill the session and return final output

### Command: `/attach`

Reattach to background sessions:
```
/attach
/attach <id>
```

## Modes

### Interactive (default)

User supervises and controls the session directly.

```typescript
interactive_shell({ command: 'pi "Review this code"' })
```

### Hands-Free (Foreground Subagent)

Agent monitors with periodic updates. User sees the overlay and can take over by typing. **Default to `pi`** unless user requests a different agent.

```typescript
interactive_shell({
  command: 'pi "Fix all lint errors in src/"',
  mode: "hands-free",
  reason: "Fixing lint errors"
})
```

**Update modes:**
- `on-quiet` (default): Emit update after 5s of output silence. Perfect for agent-to-agent delegation.
- `interval`: Emit on fixed schedule (every 60s). Use when continuous output is expected.

**Context budget:**
- Updates include only NEW output since last update (incremental)
- Default: 1500 chars per update, 100KB total budget
- When budget exhausted, updates continue but without content

**Status updates (all include `sessionId`):**
- Initial update - sent immediately when session starts
- `status: "running"` - incremental output
- `status: "user-takeover"` - user typed something
- `status: "exited"` - process finished

### Sending Input to Active Sessions

Use `sessionId` from updates to send input:

```typescript
// Text input
interactive_shell({ sessionId: "calm-reef", input: "/help\n" })

// Named keys
interactive_shell({ sessionId: "calm-reef", input: { text: "/model", keys: ["enter"] } })

// Navigate menus
interactive_shell({ sessionId: "calm-reef", input: { keys: ["down", "down", "enter"] } })

// Hex bytes for raw escape sequences
interactive_shell({ sessionId: "calm-reef", input: { hex: ["0x1b", "0x5b", "0x41"] } })

// Bracketed paste (prevents auto-execution)
interactive_shell({ sessionId: "calm-reef", input: { paste: "multi\nline\ntext" } })
```

**Named keys:** `up`, `down`, `left`, `right`, `enter`, `escape`, `tab`, `backspace`, `delete`, `home`, `end`, `pageup`, `pagedown`, `f1`-`f12`, `ctrl+c`, `ctrl+d`, etc.

**Keypad keys:** `kp0`-`kp9`, `kp/`, `kp*`, `kp-`, `kp+`, `kp.`, `kpenter`

**tmux-style aliases:** `ppage`/`npage` (PageUp/PageDown), `ic`/`dc` (Insert/Delete), `bspace` (Backspace), `btab` (Shift+Tab)

**Modifiers:** `ctrl+x`, `alt+x`, `shift+tab`, `ctrl+alt+delete` (or shorthand: `c-x`, `m-x`, `s-tab`)

### Change Settings Mid-Session

```typescript
interactive_shell({ sessionId: "calm-reef", settings: { updateInterval: 30000 } })
interactive_shell({ sessionId: "calm-reef", settings: { quietThreshold: 3000 } })
```

## Config

Global: `~/.pi/agent/interactive-shell.json`
Project: `<cwd>/.pi/interactive-shell.json`

```json
{
  "doubleEscapeThreshold": 300,
  "exitAutoCloseDelay": 10,
  "overlayWidthPercent": 95,
  "overlayHeightPercent": 45,
  "scrollbackLines": 5000,
  "ansiReemit": true,
  "handoffPreviewEnabled": true,
  "handoffPreviewLines": 30,
  "handoffPreviewMaxChars": 2000,
  "handoffSnapshotEnabled": false,
  "handoffSnapshotLines": 200,
  "handoffSnapshotMaxChars": 12000,
  "handsFreeUpdateMode": "on-quiet",
  "handsFreeUpdateInterval": 60000,
  "handsFreeQuietThreshold": 5000,
  "handsFreeUpdateMaxChars": 1500,
  "handsFreeMaxTotalChars": 100000
}
```

## Keys

| Key | Action |
|-----|--------|
| `Esc` twice | Detach dialog (kill/background/cancel) |
| `Shift+Up/Down` | Scroll (no takeover in hands-free) |
| `Ctrl+C` | Forwarded to subprocess |
| Any other key (hands-free) | Triggers user takeover |
