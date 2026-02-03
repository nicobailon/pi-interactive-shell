# Changelog

All notable changes to the `pi-interactive-shell` extension will be documented in this file.

## [Unreleased]

## [0.7.1] - 2026-02-03

### Changed
- Added demo video and `pi.video` field to package.json for pi package browser.

## [0.7.0] - 2026-02-03

### Added
- **Dispatch mode** (`mode: "dispatch"`) - Fire-and-forget sessions where the agent is notified on completion via `triggerTurn` instead of polling. Defaults `autoExitOnQuiet: true`.
- **Background dispatch** (`mode: "dispatch", background: true`) - Headless sessions with no overlay. Multiple can run concurrently alongside an interactive overlay.
- **Agent-initiated background** (`sessionId, background: true`) - Dismiss an active overlay while keeping the process running.
- **Attach** (`attach: "session-id"`) - Reattach to background sessions with any mode (interactive, hands-free, dispatch).
- **List background sessions** (`listBackground: true`) - Query all background sessions with status and duration.
- **Ctrl+B shortcut** - Direct keyboard shortcut to background a session (dismiss overlay, keep process running) without navigating the Ctrl+Q menu.
- **HeadlessDispatchMonitor** - Lightweight monitor for background PTY sessions handling quiet timer, timeout, exit detection, and output capture.
- **Completion output capture** - `completionOutput` captured before PTY disposal in all `finishWith*` methods for dispatch notifications.
- `completionNotifyLines` and `completionNotifyMaxChars` config options for notification output size.
- **Dismiss background sessions** - `/dismiss [id]` user command and `dismissBackground` tool param to kill running / remove exited sessions without opening an overlay.
- **Background sessions widget** - Persistent widget below the editor showing all background sessions with status indicators (`●` running / `○` exited), session ID, command, reason, and live duration. Auto-appears/disappears. Responsive layout wraps to two lines on narrow terminals.
- **Additive listeners on PtyTerminalSession** - `addDataListener()` and `addExitListener()` allow multiple subscribers alongside the primary `setEventHandlers()`. Headless monitor and overlay coexist without conflicts.

### Changed
- `sessionManager.add()` now accepts optional `{ id, noAutoCleanup }` options for headless dispatch sessions.
- `sessionManager.take()` removes sessions from background registry without disposing PTY (for attach flow).
- `ActiveSession` interface now includes `background()` method.
- Overlay `onExit` handler broadened: non-blocking modes (dispatch and hands-free) auto-close immediately on exit instead of showing countdown.
- `finishWithBackground()` reuses sessionId as backgroundId for non-blocking modes.
- `getOutputSinceLastCheck()` returns `completionOutput` as fallback when session is finished.
- `/attach` command coordinates with headless monitors via additive listeners (monitor stays active during overlay).
- Headless dispatch completion notifications are compact: status line, duration, 5-line tail, and reattach instruction. Full output available via `details.completionOutput` or by reattaching.
- Completed headless sessions preserve their PTY for 5 minutes (`scheduleCleanup`) instead of disposing immediately, allowing the agent to reattach and review full scrollback.
- Notification tail strips trailing blank lines from terminal buffer before slicing.

### Fixed
- Interval timer in `startHandsFreeUpdates()` and `setUpdateInterval()` no longer kills autoExitOnQuiet detection in dispatch mode (guarded on-quiet branch with `onHandsFreeUpdate` null check).
- Hands-free non-blocking polls returning empty output for completed sessions now return captured `completionOutput`.

## [0.6.4] - 2026-02-01

### Fixed
- Adapt execute signature to pi v0.51.0: insert signal as 3rd parameter

## [0.6.3] - 2026-01-30

### Fixed
- **Garbled output on Ctrl+T transfer** - Transfer and handoff preview captured raw PTY output via `getRawStream()`, which includes every intermediate frame of TUI spinners (e.g., Codex's "Working" spinner produced `WorkingWorking•orking•rking•king•ing...`). Switched both `captureTransferOutput()` and `maybeBuildHandoffPreview()` to use `getTailLines()` which reads from the xterm terminal emulator buffer. The emulator correctly processes carriage returns and cursor movements, so only the final rendered state of each line is captured. Fixed in both `overlay-component.ts` and `reattach-overlay.ts`.
- **Removed dead code** - Cleaned up unused private fields (`timedOut`, `lastDataTime`) and unreachable method (`getSessionId()`) from `InteractiveShellOverlay`.

## [0.6.2] - 2026-01-28

### Fixed
- **Ctrl+T transfer now works in hands-free mode** - When using Ctrl+T to transfer output in non-blocking hands-free mode, the captured output is now properly sent back to the main agent using `pi.sendMessage()` with `triggerTurn: true`. Previously, the transfer data was captured but never delivered to the agent because the tool had already returned. The fix uses the event bus pattern to wake the agent with the transferred content.
- **Race condition when Ctrl+T during polling** - Added guard in `getOutputSinceLastCheck()` to return empty output if the session is finished. This prevents errors when a query races with Ctrl+T transfer (PTY disposed before query completes).

### Added
- **New event: `interactive-shell:transfer`** - Emitted via `pi.events` when Ctrl+T transfer occurs, allowing other extensions to hook into transfer events.

## [0.6.1] - 2026-01-27

### Added
- **Banner image** - Added fancy banner to README for consistent branding with other pi extensions

## [0.6.0] - 2026-01-27

### Added
- **Transfer output to agent (Ctrl+T)** - New action to capture subagent output and send it directly to the main agent. When a subagent finishes work, press Ctrl+T to close the overlay and transfer the output as primary content (not buried in details). The main agent immediately has the subagent's response in context.
- **Transfer option in Ctrl+Q menu** - "Transfer output to agent" is now the first option in the session menu, making it the default selection.
- **Configurable transfer settings** - `transferLines` (default: 200, range: 10-1000) and `transferMaxChars` (default: 20KB, range: 1KB-100KB) control how much output is captured.

### Changed
- **Ctrl+Q menu redesigned** - Options are now: Transfer output → Run in background → Kill process → Cancel. Transfer is the default selection since it's the most common action when a subagent finishes.
- **Footer hints updated** - Now shows "Ctrl+T transfer • Ctrl+Q menu" for discoverability.

## [0.5.3] - 2026-01-26

### Changed
- Added `pi-package` keyword for npm discoverability (pi v0.50.0 package system)

## [0.5.2] - 2026-01-23

### Fixed
- **npx installation missing files** - The install script had a hardcoded file list that was missing 4 critical files (`key-encoding.ts`, `types.ts`, `tool-schema.ts`, `reattach-overlay.ts`). Now reads from `package.json`'s `files` array as the single source of truth, ensuring all files are always copied.
- **Broken symlink handling** - Fixed skill symlink creation failing when a broken symlink already existed at the target path. `existsSync()` returns `false` for broken symlinks, causing the old code to skip removal. Now unconditionally attempts removal, correctly handling broken symlinks.

## [0.5.1] - 2026-01-22

### Fixed
- **Prevent overlay stacking** - Starting a new `interactive_shell` session or using `/attach` while an overlay is already open now returns an error instead of causing undefined behavior with stacked/stuck overlays.

## [0.5.0] - 2026-01-22

### Changed
- **BREAKING: Split `input` into separate fields for Vertex AI compatibility** - The `input` parameter which previously accepted either a string or an object with `text/keys/hex/paste` fields has been split into separate parameters:
  - `input` - Raw text/keystrokes (string only)
  - `inputKeys` - Named keys array (e.g., `["ctrl+c", "enter"]`)
  - `inputHex` - Hex bytes array for raw escape sequences
  - `inputPaste` - Text for bracketed paste mode
  
  This change was required because Claude's Vertex AI API (`google-antigravity` provider) rejects `anyOf` JSON schemas with mixed primitive/object types.

### Migration
```typescript
// Before (0.4.x)
interactive_shell({ sessionId: "abc", input: { keys: ["ctrl+c"] } })
interactive_shell({ sessionId: "abc", input: { paste: "code" } })

// After (0.5.0)
interactive_shell({ sessionId: "abc", inputKeys: ["ctrl+c"] })
interactive_shell({ sessionId: "abc", inputPaste: "code" })

// Combining text with keys (still works)
interactive_shell({ sessionId: "abc", input: "y", inputKeys: ["enter"] })
```

## [0.4.9] - 2026-01-21

### Fixed
- **Multi-line command overflow in header** - Commands containing newlines (e.g., long prompts passed via `-f` flag) now properly collapse to a single line in the overlay header instead of overflowing and leaking behind the overlay.
- **Reason field overflow** - The `reason` field in the hint line is also sanitized to prevent newline overflow.
- **Session list overflow** - The `/attach` command's session list now sanitizes command and reason fields for proper display.

## [0.4.8] - 2026-01-19

### Changed
- **node-pty ^1.1.0** - Updated minimum version to 1.1.0 which includes prebuilt binaries for macOS (arm64, x64) and Windows (x64, arm64). No more Xcode or Visual Studio required for installation on these platforms. Linux still requires build tools (`build-essential`, `python3`).

## [0.4.7] - 2026-01-18

### Added
- **Incremental mode** - New `incremental: true` parameter for server-tracked pagination. Agent calls repeatedly and server tracks position automatically. Returns `hasMore` to indicate when more output is available.
- **hasMore in offset mode** - Offset pagination now returns `hasMore` field so agents can know when they've finished reading all output.

### Fixed
- **Session ID leak on user takeover** - In streaming mode, session ID was unregistered but never released when user took over. Now properly releases ID since agent was notified and won't query.
- **Session ID leak in dispose()** - When overlay was disposed without going through finishWith* methods (error cases), session ID was never released. Now releases ID in all cleanup paths.

### Changed
- **autoExitOnQuiet now defaults to false** - Sessions stay alive for multi-turn interaction by default. Enable with `handsFree: { autoExitOnQuiet: true }` for fire-and-forget single-task delegations.
- **Config documentation** - Fixed incorrect config path in README. Config files are `~/.pi/agent/interactive-shell.json` (global) and `.pi/interactive-shell.json` (project), not under `settings.json`. Added full settings table with all options documented.
- **Detach key** - Changed from double-Escape to Ctrl+Q for more reliable detection.

## [0.4.6] - 2026-01-18

### Added
- **Offset/limit pagination** - New `outputOffset` parameter for reading specific ranges of output:
  - `outputOffset: 0, outputLines: 50` reads lines 0-49
  - `outputOffset: 50, outputLines: 50` reads lines 50-99
  - Returns `totalLines` in response for pagination
- **Drain mode for incremental output** - New `drain: true` parameter returns only NEW output since last query:
  - More token-efficient than re-reading the tail each time
  - Ideal for repeated polling of long-running sessions
- **Token Efficiency section in README** - Documents advantages over tmux workflow:
  - Incremental aggregation vs full capture-pane
  - Tail by default (20 lines, not full history)
  - ANSI stripping before sending to agent
  - Drain mode for only-new-output

### Changed
- **getLogSlice() method in pty-session** - New low-level method for offset/limit pagination through raw output buffer

## [0.4.3] - 2026-01-18

### Added
- **Configurable output limits** - New `outputLines` and `outputMaxChars` parameters when querying sessions:
  - `outputLines`: Request more lines (default: 20, max: 200)
  - `outputMaxChars`: Request more content (default: 5KB, max: 50KB)
  - Example: `interactive_shell({ sessionId: "calm-reef", outputLines: 50 })`
- **Escape hint feedback** - After pressing first Escape, shows "Press Escape again to detach..." in footer for 300ms

### Fixed
- **Escape hint not showing** - Fixed bug where `clearEscapeHint()` was immediately resetting `showEscapeHint` to false after setting it to true
- **Negative output limits** - Added clamping to ensure `outputLines` and `outputMaxChars` are at least 1
- **Reduced flickering during rapid output** - Three improvements:
  1. Scroll position calculated at render time via `followBottom` flag (not on each data event)
  2. Debounced render requests (16ms) to batch rapid updates before drawing
  3. Explicit scroll-to-bottom after resize to prevent flash to top during dimension changes

## [0.4.2] - 2026-01-17

### Added
- **Query rate limiting** - Queries are limited to once every 60 seconds by default. If you query too soon, the tool automatically waits until the limit expires before returning (blocking behavior). Configurable via `minQueryIntervalSeconds` in settings (range: 5-300 seconds). Note: Rate limiting does not apply to completed sessions or kills - you can always query the final result immediately.

### Changed
- **autoExitOnQuiet now defaults to true** - In hands-free mode, sessions auto-kill when output stops (~5s of quiet). Set `handsFree: { autoExitOnQuiet: false }` to disable.
- **Smaller default overlay** - Height reduced from 90% to 45%. Configurable via `overlayHeightPercent` in settings (range: 20-90%).

### Fixed
- **Rate limit wait now interruptible** - When waiting for rate limit, the wait is interrupted immediately if the session completes (user kills, process exits, etc.). Uses Promise.race with onComplete callback instead of blocking sleep.
- **scrollbackLines NaN handling** - Config now uses `clampInt` like other numeric fields, preventing NaN from breaking xterm scrollback.
- **autoExitOnQuiet status mismatch** - Now sends "killed" status (not "exited") to match `finishWithKill()` behavior.
- **hasNewOutput semantics** - Renamed to `hasOutput` since we use tail-based output, not incremental tracking.
- **dispose() orphaned sessions** - Now kills running processes before unregistering to prevent orphaned sessions.
- **killAll() premature ID release** - IDs now released via natural cleanup after process exit, not immediately after kill() call.

## [0.4.1] - 2026-01-17

### Changed
- **Rendered output for queries** - Status queries now return rendered terminal output (last 20 lines) instead of raw stream. This eliminates TUI animation noise (spinners, progress bars) and gives clean, readable content.
- **Reduced output size** - Max 20 lines and 5KB per query (down from 100 lines and 10KB). Queries are for checking in, not dumping full output.

### Fixed
- **TUI noise in query output** - Raw stream captured all terminal animation (spinner text fragments like "Working", "orking", "rking"). Now uses xterm rendered buffer which shows clean final state.

## [0.4.0] - 2026-01-17

### Added
- **Non-blocking hands-free mode** - Major change: `mode: "hands-free"` now returns immediately with a sessionId. The overlay opens for the user but the agent gets control back right away. Use `interactive_shell({ sessionId })` to query status/output and `interactive_shell({ sessionId, kill: true })` to end the session when done.
- **Session status queries** - Query active session with just `sessionId` to get current status and any new output since last check.
- **Kill option** - `interactive_shell({ sessionId, kill: true })` to programmatically end a session.
- **autoExitOnQuiet** option - Auto-kill session when output stops (after quietThreshold). Use `handsFree: { autoExitOnQuiet: true }` for sessions that should end when the nested agent goes quiet.
- **Output truncation** - Status queries now truncate output to 10KB (keeping the most recent content) to prevent overwhelming agent context. Truncation is indicated in the response.

### Fixed
- **Non-blocking mode session lifecycle** - Sessions now stay registered after completion so agent can query final status. Previously, sessions were unregistered before agent could query completion result.
- **User takeover in non-blocking mode** - Agent can now see "user-takeover" status when querying. Previously, session was immediately unregistered when user took over.
- **Type mismatch in registerActive** - Fixed `getOutput` return type to match `OutputResult` interface.
- **Agent output position after buffer trim** - Fixed `agentOutputPosition` becoming stale when raw buffer is trimmed. When the 1MB buffer limit is exceeded and old content discarded, the agent query position is now clamped to prevent returning empty output or missing data.
- **killAll() map iteration** - Fixed modifying maps during iteration in `killAll()`. Now collects IDs/entries first to avoid unpredictable behavior when killing sessions triggers unregistration callbacks.
- **ActiveSessionResult type** - Fixed type mismatch where `output` field was required but never populated. Updated interface to match actual return type from `getResult()`.
- **Unbounded raw output growth** - rawOutput buffer now capped at 1MB, trimming old content to prevent memory growth in long-running sessions
- **Session ID reuse** - IDs are only released when session fully terminates, preventing reuse while session still running after takeover
- **DSR cursor responses** - Fixed stale cursor position when DSR appears mid-chunk; now processes chunks in order, writing to xterm before responding
- **Active sessions on shutdown** - Hands-free sessions are now killed on `session_shutdown`, preventing orphan processes
- **Quiet threshold timer** - Changing threshold now restarts any active quiet timer with the new value
- **Empty string input** - Now shows "(empty)" instead of blank in success message
- **Hands-free auto-close on exit** - Overlay now closes immediately when process exits in hands-free mode, returning control to the agent instead of waiting for countdown
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

