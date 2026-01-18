# Changelog

All notable changes to the `pi-interactive-shell` extension will be documented in this file.

## [0.3.3] - 2026-01-17

### Fixed
- Handoff preview now uses raw output stream instead of xterm buffer. TUI apps using alternate screen buffer (like Codex, Claude, etc.) would show misleading/stale content in the preview.

## [0.3.0] - 2026-01-17

### Added
- Hands-free mode (`mode: "hands-free"`) for agent-driven monitoring with periodic tail updates.
- User can take over hands-free sessions by typing anything (except scroll keys).
- Configurable update settings for hands-free mode (defaults: on-quiet mode, 5s quiet threshold, 60s max interval, 1500 chars/update, 100KB total budget).
- **Input injection**: Send input to active hands-free sessions via `sessionId` + `input` parameters.
- Named key support: `up`, `down`, `enter`, `escape`, `ctrl+c`, etc.
- "Foreground subagents" terminology to distinguish from background subagents (the `subagent` tool).
- `sessionId` now available in the first update (before overlay opens) for immediate input injection.
- **Timeout**: Auto-kill process after N milliseconds via `timeout` parameter. Useful for TUI commands that don't exit cleanly (e.g., `pi --help`).
- **DSR handling**: Automatically responds to cursor position queries (`ESC[6n` / `ESC[?6n`) with actual xterm cursor position. Prevents TUI apps from hanging when querying cursor.
- **Enhanced key encoding**: Full modifier support (`ctrl+alt+x`, `shift+tab`, `c-m-delete`), hex bytes (`hex: ["0x1b"]`), bracketed paste mode (`paste: "text"`), and all F1-F12 keys.
- **Human-readable session IDs**: Sessions now get memorable names like `calm-reef`, `swift-cove` instead of `shell-1`, `shell-2`.
- **Process tree killing**: Kill entire process tree on termination, preventing orphan child processes.
- **Session name derivation**: Better display names in `/attach` list showing command summary.
- **Write queue**: Ordered writes to terminal emulator prevent race conditions.
- **Raw output streaming**: `getRawStream()` method for incremental output reading with `sinceLast` option.
- **Exit message in terminal**: Process exit status appended to terminal buffer when process exits.
- **EOL conversion**: Added `convertEol: true` to xterm for consistent line ending handling.
- **Incremental updates**: Hands-free updates now send only NEW output since last update, not full tail. Dramatically reduces context bloat.
- **Activity-driven updates (on-quiet mode)**: Default behavior now waits for 5s of output silence before emitting update. Perfect for agent-to-agent delegation where you want complete "thoughts" not fragments.
- **Update modes**: `handsFree.updateMode` can be `"on-quiet"` (default) or `"interval"`. On-quiet emits when output stops; interval emits on fixed schedule.
- **Context budget**: Total character budget (default: 100KB, configurable via `handsFree.maxTotalChars`). Updates stop including content when exhausted.
- **Dynamic settings**: Change update interval and quiet threshold mid-session via `settings: { updateInterval, quietThreshold }`.
- **Keypad keys**: Added `kp0`-`kp9`, `kp/`, `kp*`, `kp-`, `kp+`, `kp.`, `kpenter` for numpad input.
- **tmux-style key aliases**: Added `ppage`/`npage` (PageUp/PageDown), `ic`/`dc` (Insert/Delete), `bspace` (Backspace) for compatibility.

### Changed
- ANSI stripping now uses Node.js built-in `stripVTControlCharacters` for cleaner, more robust output processing.

### Fixed
- Double unregistration in hands-free session cleanup (now idempotent via `sessionUnregistered` flag).
- Potential double `done()` call when timeout fires and process exits simultaneously (added `finished` guard).
- ReattachOverlay: untracked setTimeout for initial countdown could fire after dispose (now tracked).
- Input type annotation missing `hex` and `paste` fields.
- Background session auto-cleanup could dispose session while user is viewing it via `/attach` (now cancels timer on reattach).
- On-quiet mode now flushes pending output before sending "exited" or "user-takeover" notifications (prevents data loss).
- Interval mode now also flushes pending output on user takeover (was missing the `|| updateMode === "interval"` check).
- Timeout in hands-free mode now flushes pending output and sends "exited" notification before returning.
- Exit handler now waits for writeQueue to drain, ensuring exit message is in rawOutput before notification is sent.

### Removed
- `handsFree.updateLines` option (was defined but unused after switch to incremental char-based updates).

## [0.2.0] - 2026-01-17

### Added
- Interactive shell overlay tool `interactive_shell` for supervising interactive CLI agent sessions.
- Detach dialog (double `Esc`) with kill/background/cancel.
- Background session reattach command: `/attach`.
- Scroll support: `Shift+Up` / `Shift+Down`.
- Tail handoff preview included in tool result (bounded).
- Optional snapshot-to-file transcript handoff (disabled by default).

### Fixed
- Prevented TUI width crashes by avoiding unbounded terminal escape rendering.
- Reduced flicker by sanitizing/redrawing in a controlled overlay viewport.

