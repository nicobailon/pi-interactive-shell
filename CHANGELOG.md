# Changelog

All notable changes to the `pi-interactive-shell` extension will be documented in this file.

## [Unreleased]

### Changed
- Bundled runtime skills now live under `skills/`, with only the canonical `pi-interactive-shell` skill auto-registered. The Codex workflow skills remain packaged under `examples/skills/` as opt-in copies alongside the example prompt templates.
- Codex docs now include `gpt-image-2` guidance across the optional `codex-cli` example skill plus the shared README and interactive-shell skill, covering natural-language prompting, `$imagegen`, and `-i` reference-image workflows.
- Replaced the legacy `@sinclair/typebox` runtime dependency with `typebox`.
- Upgraded `zigpty` from `^0.0.6` to `^0.1.6` to pick up newer PTY prebuilds, including the Linux x64 path affected by the reported SIGILL crash.

### Fixed
- Migrated the interactive-shell tool schema from `@sinclair/typebox` to `typebox` 1.x so packaged installs follow Pi's current extension runtime contract.

### Removed
- Removed the legacy npm bin installer (`scripts/install.js`) and its package metadata. `pi install npm:pi-interactive-shell` is now the only supported installation path.

## [0.12.0] - 2026-04-12

### Added
- Inline threshold trigger support for regex monitors via `threshold: { captureGroup, op, value }` with `lt`, `lte`, `gt`, and `gte` operators.
- First-class `file-watch` monitor strategy with `monitor.fileWatch` config (`path`, `recursive`, `events`) and compact event lines (`EVENT path`).
- Monitor lifecycle notifications (`interactive-shell-monitor-lifecycle`) with explicit terminal reasons: `stream-ended`, `script-failed`, `stopped`, and `timed-out`.
- New monitor query fields: `monitorStatus`, `monitorSinceEventId`, and `monitorTriggerId`.

### Changed
- Monitor mode now allows generated internal commands for `file-watch`, so users can start file watchers without providing a shell `command`.
- Monitor validation is now stricter for strategy-specific config (`fileWatch` and `poll` usage) and threshold trigger requirements.
- Monitor coordinator now tracks per-session monitor state (status, strategy, trigger ids, event count, last event metadata, terminal reason).
- Background session UI/listing now renders monitor sessions with monitor-specific context (strategy/event count) instead of plain generic running/exited labels.

## [0.11.1] - 2026-04-12

### Changed
- Monitor event callback now guards against emitting after the monitor is disposed, preventing stale queued notifications from a dismissed session.
- Poll-diff strategy now wraps the command in a recurring loop and diffs per-interval samples instead of accumulating full PTY output.
- Monitor event history cleanup retries until referenced monitor/session/active entries are gone, preventing history leaks from one-shot timers firing too early.

### Fixed
- Fixed `await` on already-resolved detector command promise (removed unnecessary `await` on non-async return).

## [0.11.0] - 2026-04-11

### Added
- New `mode: "monitor"` for `interactive_shell` to run headless background commands and wake the agent only when output lines match `monitorFilter`.
- New `monitorFilter` tool parameter supporting plain-text substring matching and `/regex/flags` matching.
- Monitor event notifications now wake the agent with `triggerTurn` and include `sessionId`, matched text, and the matched line.
- Regression coverage for monitor mode startup validation and ANSI-stripped line matching.
- Regression coverage for suppressing repeated wakeups when the exact same cleaned matching line is emitted more than once in a single monitor session.

### Changed
- README, tool help, and the bundled `examples/skills/interactive-shell/SKILL.md` now document monitor mode usage, event-driven behavior, and monitor session lifecycle with existing background-session APIs.
- Monitor mode now suppresses repeated wakeups for the exact same cleaned matching line within a single monitor session, while still waking on distinct matching lines.

### Fixed
- Slash-prefixed plain-text filters like `/tmp/log` are now treated as literal text instead of being misparsed as regex literals.
- Invalid monitor regex errors now preserve the underlying parser message for easier debugging.

## [0.10.8] - 2026-04-09

### Added
- `submit` tool parameter for `interactive_shell` session input so the agent can type text and press Enter in one call, avoiding the common failure mode where commands are left sitting in editor-based TUIs like pi.
- Regression tests covering `submit: true` for plain text input and bracketed paste input.

### Changed
- PTY backend switched from `node-pty` to `zigpty` in `pty-session.ts`, keeping the existing `PtyTerminalSession` behavior and higher-level `interactive_shell` API unchanged.
- Input docs now explicitly state that raw `input` only types text and does not submit it.
- README, `SKILL.md`, and tool help now prefer `submit: true` or `inputKeys: ["enter"]` over relying on `\n` for command submission.
- The registered `interactive_shell` prompt snippet now nudges agents to use `submit=true` when sending slash commands or prompts to an existing session.
- Structured input now emits bracketed paste content before trailing key presses, so combinations like paste-plus-Enter submit in the expected order.

### Removed
- Removed the `node-pty` macOS spawn-helper permission workaround from runtime and install scripts (`spawn-helper.ts`, `scripts/fix-spawn-helper.cjs`, and the `postinstall` hook).

## [0.10.7] - 2026-04-04

### Added
- Prompt-bearing monitored spawn for `/spawn`, so users can launch delegated hands-free or dispatch sessions like `/spawn claude "review the diffs" --dispatch` without dropping down to raw tool calls.
- Native startup prompt support on structured `interactive_shell` spawn params via `spawn.prompt` for Pi, Codex, and Claude.

### Changed
- `/spawn` now parses quoted positional prompt text plus `--hands-free` or `--dispatch`, while plain `/spawn` remains an interactive overlay launch.
- README and tool docs now spell out that `/spawn` and structured `spawn` share the same resolver semantics, and that `Ctrl+G` only applies after taking over a genuinely monitored session.
- README now includes a dedicated prompt-bearing `/spawn` subsection so the interactive vs monitored split is easier to find.

## [0.10.6] - 2026-04-04

### Added
- Multi-agent spawn support for `pi`, Codex CLI, and Claude Code. `/spawn` can now launch the configured default agent, accept explicit agent overrides like `/spawn codex`, and support `--worktree` for spawning into a separate git worktree.
- First-class `spawn` params on the `interactive_shell` tool so the agent can use the same spawn abstraction directly instead of building raw command strings by hand.
- Regression coverage for dispatch background recovery when a backgrounded session cannot be looked up after overlay teardown.

### Changed
- Spawn config now lives under a nested `spawn` object with `defaultAgent`, `shortcut`, `commands`, `defaultArgs`, `worktree`, and `worktreeBaseDir`.
- The spawn shortcut now launches the configured default spawn agent instead of always launching Pi.
- Pi-only fork validation is shared between `/spawn` and the `interactive_shell` tool, so `fork` now fails fast with a clear error for Codex and Claude.
- README and tool schema examples now document structured spawn usage, multi-agent `/spawn` commands, and worktree settings.

### Fixed
- Pi fork now validates the persisted source session before creating a worktree, so failed fork attempts no longer leave stray worktrees behind.
- Dispatch background recovery now releases the source session and disposes stale monitor state if the expected background session entry is missing after handoff.
- Generated worktree paths now include enough uniqueness to avoid collisions during rapid repeated spawns.

## [0.10.5] - 2026-04-04

### Added
- `spawnShortcut` config setting for the fresh-session overlay shortcut. Defaults to `alt+shift+p` and is pinned at startup like `focusShortcut`, so changes apply on reload or restart.

### Changed
- Fresh-session shortcut registration now reads from config at startup instead of a hardcoded constant, so custom `spawnShortcut` values are applied consistently.
- Docs and config parity tests now cover `spawnShortcut` defaults and README alignment.

### Fixed
- Overlay row/header rendering now clamps metadata and row content at narrow widths, preventing visual overflow when focus badge + PID metadata are wider than the available space.

## [0.10.4] - 2026-04-04

### Fixed
- Focus shortcut handling now uses a terminal input listener while the overlay is open, so the configured `focusShortcut` toggles focus/unfocus reliably even when editor-level shortcuts would not fire. The default shortcut is now `alt+shift+f` instead of `alt+\`` for better terminal compatibility on macOS and to avoid Pi keybinding conflicts.
- Overlay shortcut interception now ignores raw key release and key repeat events, which prevents the focus toggle from firing twice on Kitty-enabled terminals and cancelling itself out.
- Overlay focus state is now more obvious visually: the shell shows a persistent `SHELL FOCUSED` or `EDITOR FOCUSED` badge and switches to a stronger border treatment when focused.
- `alt+/` side chat is blocked while `pi-interactive-shell` is open and shows a warning instead of opening on top of the shell overlay.

## [0.10.3] - 2026-04-04

### Changed
- Added a `promptSnippet` for `interactive_shell` so Pi 0.59+ includes the tool in the default prompt tool list and keeps delegation guidance explicit (`dispatch` preferred by default).

## [0.10.2] - 2026-04-04

### Added
- **Focus switching** — configurable `focusShortcut` (default `alt+shift+f`) toggles focus between overlay and main chat. Same shortcut inside the overlay unfocuses back. Overlay uses `nonCapturing` mode with handle-based focus control.
- **`/spawn` command** — launch pi in an overlay with `/spawn` (fresh session) or `/spawn fork` (fork current session with platform-aware shell quoting).
- **`Alt+Shift+P` shortcut** — quick-launch a fresh pi session overlay.
- **Return-to-agent control** — after taking over a hands-free session, press `Ctrl+G` or select "Return control to agent" from the `Ctrl+Q` menu to resume agent monitoring. Re-registers session in streaming mode and restarts hands-free update timers.
- **`agent-resumed` status** — new `HandsFreeUpdate.status` value emitted when the user returns control to the agent. Handled in both streaming and non-blocking notification paths.
- **Transfer output from commands** — `Ctrl+T` transfer results from `/spawn` and `/attach` now flow back into the agent conversation via shared `emitTransferredOutput()` helper, matching the tool-call behavior.
- **Per-session completion suppression** — `agentHandledCompletion` moved from a single flag to a `Set<string>` on the coordinator, so concurrent sessions can't interfere with each other's notification paths.
- **Stale monitor cleanup** — `disposeStaleMonitor()` helper cleans up orphan headless monitors and their active-session registrations when a background session has already been removed.
- **3 new test files** (10 tests): `spawn-command.test.ts` (fresh, fork, quoting, persist guard, transfer forwarding), `command-session-selection.test.ts` (IDs containing delimiters), `kill-session-suppression.test.ts` (conditional mark on incomplete/complete sessions).

### Changed
- `/attach` and `/dismiss` selection uses structured `{ id, label }` option mapping with `.find()` instead of parsing rendered label strings by delimiter. Session IDs containing ` - ` or ` (` no longer break selection.
- Kill suppression is conditional on completion state — `markAgentHandledCompletion` only set when `session.getResult()` is not yet available, preventing leaked suppression tokens for already-completed sessions.
- `spawn-helper.ts` uses inline ENOENT narrowing instead of single-use `getErrnoCode` helper.
- Dynamic dialog footer height (`dialogOptions.length + 2`) in the overlay accommodates the variable return-to-agent option. Reattach overlay keeps the static `FOOTER_LINES_DIALOG` constant (always 4 options).
- Flattened nested if/else in footer rendering for both overlay components.
- `createOverlayUiOptions()` deduplicates overlay UI configuration across all call sites.
- `runtime-coordinator.ts` manages overlay focus via `OverlayHandle` (focus, unfocus, set, clear).
- Config parse errors now pass the full error object to `console.error` instead of `String(error)`.
- Shutdown kill failure preserves slug reservation to prevent ID collision with potentially still-running sessions.
- Removed legacy `session_switch` lifecycle setup and rely on immutable-session `session_start` reinitialization for background widget setup.

### Fixed
- Duplicate completion notifications on monitored attach + transfer (transfer now marks `agentHandledCompletion` before monitor fires).
- Cancelled dispatch sessions reported as "completed" — now correctly reports "was killed".
- Stale headless monitors leaked when the corresponding background session was already cleaned up.
- Zombie active-session registrations left behind on stale monitor disposal.
- PTY event handlers not reset on attach failure recovery, causing stale overlay callbacks on disposed components.

## [0.10.1] - 2026-03-13

### Fixed
- **Skill name mismatch** - SKILL.md declared `name: interactive-shell` but pi expects it to match the parent directory `pi-interactive-shell`. Fixed skill name to match package name.

## [0.10.0] - 2026-03-13

### Added
- **Test harness** - Added vitest with 20 tests covering session queries, key encoding, notification formatting, headless monitor lifecycle, session manager, config/docs parity, and module loading.
- **`gpt-5-4-prompting` skill** - New bundled skill with GPT-5.4 prompting best practices for Codex workflows.

### Changed
- **Architecture refactor** - Extracted shared logic into focused modules for better maintainability:
  - `session-query.ts` - Unified output/query logic (rate limiting, incremental, drain, offset modes)
  - `notification-utils.ts` - Message formatting for dispatch/hands-free notifications
  - `handoff-utils.ts` - Snapshot/preview capture on session exit/transfer
  - `runtime-coordinator.ts` - Centralized overlay/monitor/widget state management
  - `pty-log.ts` - Raw output trimming and line slicing
  - `pty-protocol.ts` - DSR cursor position query handling
  - `spawn-helper.ts` - macOS node-pty permission fix
  - `background-widget.ts` - TUI widget for background sessions
- README, `SKILL.md`, install output, and the packaged Codex workflow examples now tell the same story about dispatch being the recommended delegated mode, the current 8s quiet threshold / 15s grace-period defaults, and the bundled prompt-skill surface.
- The Codex workflow docs now point at the packaged `gpt-5-4-prompting`, `codex-5-3-prompting`, and `codex-cli` skills instead of describing a runtime fetch of the old 5.2 prompting guide.
- Example prompts and skill docs are aligned around `gpt-5.4` as the default Codex model, with `gpt-5.3-codex` remaining the explicit opt-in fallback.
- Renamed `codex-5.3-prompting` → `codex-5-3-prompting` example skill (filesystem-friendly path).

### Fixed
- **Map iteration bug** - Fixed `disposeAllMonitors()` modifying Map during iteration, which could cause unpredictable behavior.
- **Array iteration bug** - Fixed PTY listener notifications modifying arrays during iteration if a listener unsubscribed itself.
- **Missing runtime dependency** - Added `@sinclair/typebox` to dependencies (was imported but not declared).
- Documented the packaged prompt/skill onboarding path more clearly so users can either rely on the exported package metadata or copy the bundled examples into their own prompt and skill directories.

## [0.9.0] - 2026-02-23

### Added
- `examples/skills/codex-5.3-prompting/` skill with GPT-5.3-Codex prompting guide -- self-contained best practices for verbosity control, scope discipline, forced upfront reading, plan mode, mid-task steering, context management, and reasoning effort recommendations.
- **`interactive-shell:update` event** — All hands-free update callbacks now emit `pi.events.emit("interactive-shell:update", update)` with the full `HandsFreeUpdate` payload. Extensions can listen for quiet, exit, kill, and user-takeover events regardless of which code path started the session (blocking, non-blocking, or reattach).
- **`triggerTurn` on terminal events** — Non-blocking hands-free sessions now send `pi.sendMessage` with `triggerTurn: true` when the session exits, is killed, or the user takes over. Periodic "running" updates emit only on the event bus (cheap for extensions) without waking the agent.

### Fixed
- **Quiet detection broken for TUI apps** — Ink-based CLIs (Claude Code, etc.) emit periodic ANSI-only PTY data (cursor blink, frame redraws) that reset the quiet timer on every event, preventing quiet detection from ever triggering. Now filters data through `stripVTControlCharacters` and only resets the quiet timer when there's visible content. Fixed in both the overlay (`overlay-component.ts`) and headless dispatch monitor (`headless-monitor.ts`). Also seeds the quiet timer at startup when `autoExitOnQuiet` is enabled, so sessions that never produce visible output still get killed after the grace period.
- **Lifecycle guard decoupled from callback** — The overlay used `onHandsFreeUpdate` presence as a proxy for "blocking tool call" to decide whether to unregister sessions on completion. Wiring the callback in non-blocking paths (for event emission) would cause premature session cleanup. Introduced `streamingMode` flag to separate "has update callback" from "should unregister on completion," so non-blocking sessions stay queryable after the callback fires.
- **`autoExitOnQuiet` broken in interval update mode** — The `onData` handler only reset the quiet timer in `on-quiet` mode, so `autoExitOnQuiet` never fired with `updateMode: "interval"`. Also, the interval timer's safety-net flush unconditionally stopped the quiet timer, preventing `autoExitOnQuiet` from firing if the interval flushed before the quiet threshold. Both fixed: data handler now resets the timer whenever `autoExitOnQuiet` is enabled regardless of update mode, and the interval flush restarts (rather than stops) the quiet timer when `autoExitOnQuiet` is active.
- **RangeError on narrow terminals** — `render()` computed `width - 2` for border strings without a lower bound, causing `String.prototype.repeat()` to throw with negative counts when terminal width < 4. Clamped in both the main overlay and reattach overlay. Fixes #2.
- **Hardcoded `~/.pi/agent` path** — Config loading, snapshot writing, and the install script all hardcoded `~/.pi/agent`, ignoring `PI_CODING_AGENT_DIR`. Now uses `getAgentDir()` from pi's API in all runtime paths and reads the env var in the install script. Fixes #1.

### Changed
- Default `handsFreeQuietThreshold` increased from 5000ms to 8000ms and `autoExitGracePeriod` reduced from 30000ms to 15000ms. Both remain adjustable per-call via `handsFree.quietThreshold` and `handsFree.gracePeriod`, and via config file.
- Dispatch mode is now the recommended default for delegated Codex runs. Updated `README.md`, `SKILL.md`, `tool-schema.ts`, `examples/skills/codex-cli/SKILL.md`, and all three codex prompt templates to prefer `mode: "dispatch"` over hands-free for fire-and-forget delegations.
- Rewrote `codex-5.3-prompting` skill from a descriptive model-behavior guide into a directive prompt-construction reference. Cut behavioral comparison, mid-task steering, and context management prose sections; reframed each prompt block with a one-line "include when X" directive so the agent knows what to inject and when.
- Added "Backwards compatibility hedging" section to `codex-5.3-prompting` skill covering the "cutover" keyword trick -- GPT-5.3-Codex inserts compatibility shims and fallback code even when told not to; using "cutover" + "no backwards compatibility" + "do not preserve legacy code" produces cleaner breaks than vague "don't worry about backwards compatibility" phrasing.
- Example prompts (`codex-implement-plan`, `codex-review-impl`, `codex-review-plan`) updated for GPT-5.3-Codex: load `codex-5.3-prompting` and `codex-cli` skills instead of fetching the 5.2 guide URL at runtime, added scope fencing instructions to counter 5.3's aggressive refactoring, added "don't ask clarifying questions" and "brief updates" constraints, strengthened `codex-review-plan` to force reading codebase files referenced in the plan and constrain edit scope.

## [0.8.2] - 2026-02-10

### Added
- `examples/prompts/` with three Codex CLI prompt templates: `codex-review-plan`, `codex-implement-plan`, `codex-review-impl`. Demonstrates a plan → implement → review workflow using meta-prompt generation and interactive shell overlays.
- `examples/skills/codex-cli/` skill that teaches pi Codex CLI flags, config, sandbox caveats, and interactive_shell usage patterns.
- README section documenting the workflow pipeline, installation, usage examples, and customization.

## [0.8.1] - 2026-02-08

### Fixed
- README: documented `handsFree.gracePeriod` tool parameter and startup grace period behavior in Auto-Exit on Quiet and Dispatch sections.
- README: added missing `handoffPreviewLines` and `handoffPreviewMaxChars` to config settings table.

## [0.8.0] - 2026-02-08

### Added
- `autoExitGracePeriod` config option (default: 30000ms, clamped 5000-120000ms) and `handsFree.gracePeriod` tool parameter override for startup quiet-kill grace control.

### Changed
- Default `overlayHeightPercent` increased from 45 to 60 for improved usable terminal rows on smaller displays.
- Overlay sizing now uses dynamic footer chrome: compact 2-line footer in normal states and full 6-line footer in detach dialog, increasing terminal viewport height during normal operation.

### Fixed
- Dispatch/hands-free `autoExitOnQuiet` no longer kills sessions during startup silence; quiet timer now re-arms during grace period and applies auto-kill only after grace expires.
- README config table missing `handoffPreviewLines` and `handoffPreviewMaxChars` entries despite appearing in the JSON example.

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
