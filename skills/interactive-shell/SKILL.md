---
name: interactive-shell
description: Run interactive CLIs and coding-agent TUIs (pi, Claude Code, Codex, Gemini, Cursor) through the interactive_shell tool, plus long or quiet commands that should wake you when they finish or print a match. Covers background dispatch, stream monitors for CI/PR gates and log watchers, user-visible overlays, sending input to sessions, and cleanup. Use bash for ordinary short commands.
---

# Interactive Shell

`interactive_shell` runs a command in a PTY that Pi supervises. Every launch returns a `sessionId` at once. Pick the mode by who waits:

```
mode         overlay   how you hear back                   use for
dispatch     yes*      one wake-up with the output tail    delegated agents, test suites, CI watches
monitor      no        one wake-up per trigger match       PR/CI gates, log watchers
hands-free   yes       you query; quiet-time updates       an agent you will steer
interactive  yes       the user drives; you can send input user-driven TUIs, auth flows
* background: true runs dispatch headless; the user can /attach to watch
```

## If the tool is missing

When `interactive_shell` is unavailable, call `enable_interactive_shell` first. The tool becomes callable on the next turn and stays active until Pi reloads or the session changes; reloaded, new, resumed, and forked sessions reset it to inactive. A CLI `--tools` allowlist must include both tools.

## Hot shapes

```js
// Finite command, headless; the wake-up brings the tail of its output
interactive_shell({
  command: "set -o pipefail; npm test > /tmp/unit.log 2>&1; s=$?; tail -60 /tmp/unit.log; exit $s",
  cwd: "/abs/repo", mode: "dispatch", background: true, name: "unit-tests",
  timeout: 1800000, handsFree: { autoExitOnQuiet: false }, reason: "Run unit tests",
})

// Gate or watcher: wake on matching lines ("/re/flags" or a plain regex string)
interactive_shell({
  command: "./scripts/gate --report /tmp/gate.txt",
  mode: "monitor", name: "pr42-gate", timeout: 2700000,
  monitor: { strategy: "stream", triggers: [
    { id: "verdict", regex: "^(READY|BLOCKED|TIMEOUT|ERROR)\\b" },
    { id: "fail", literal: "FAIL" },
  ] },
})

// Delegate to a coding agent
interactive_shell({ spawn: { agent: "pi", prompt: "Fix the failing tests in src/", worktree: true }, mode: "dispatch" })
interactive_shell({ command: 'claude "Review the diff on this branch"', mode: "dispatch", background: true })

// Live sessions
interactive_shell({ sessionId, outputLines: 50 })                 // rendered screen; default 20 lines, 5KB
interactive_shell({ sessionId, input: "/compact", submit: true })
interactive_shell({ sessionId, inputKeys: ["down", "down", "enter"] })
interactive_shell({ sessionId, inputPaste: "multi\nline text" })   // bracketed paste
interactive_shell({ sessionId, kill: true })
interactive_shell({ listBackground: true })
interactive_shell({ dismissBackground: "unit-tests" })            // or true for all
```

`inputKeys` takes named keys (`up`, `enter`, `escape`, `tab`, `space`, `backspace`, `delete`, `home`, `end`, `pageup`, `pagedown`, `f1`–`f12`, `kp0`–`kp9`) or single characters, with `ctrl+`/`alt+`/`shift+` (or `c-`/`m-`/`s-`) prefixes. Unknown names are rejected with suggestions.

`monitor.strategy` is `stream` (match output lines), `poll-diff` (rerun `command` every `poll.intervalMs`, match changes), `file-watch` (watch `fileWatch.path`; omit `command`), or `semantic` (Jev, below). Read past events with `{ monitorEvents: true, monitorSessionId }` and state with `{ monitorStatus: true, monitorSessionId }`.

## Rules

- **Wait for the wake-up.** After launching dispatch or monitor, end the turn. Don't poll, sleep, or query it.
- **Quiet auto-close.** Dispatch stops supervising after ~8s without output (after a 15s grace) and tags the wake-up `completionReason: "auto-close-quiet"`. That is not a verdict: the command may still be running or may have failed. For anything that can go quiet (tests, builds, `gh run watch`), set `handsFree: { autoExitOnQuiet: false }` and a hard `timeout`. Monitor never auto-closes on quiet.
- **Gate watchers.** For a provider-agnostic external gate watcher, use `mode: "monitor"` with a hard `timeout` and triggers on explicit end lines such as `ready`, `blocked`, and `stale-head`. The watcher must exit only after printing one.
- **Finished sessions are gone.** After the completion wake-up, `sessionId` queries return "not found". When you need more than the tail, have the command write a log file and read it.
- **Prompt goes in the command.** `reason` is only overlay header text. `command: 'claude "Review the codebase"'` starts the agent working; `command: "claude", reason: "Review"` leaves it idle.
- **Submitting.** For editor-based TUIs like pi, raw `input` only types text. It does not submit the prompt. Use `submit: true` or `inputKeys: ["enter"]`, not a trailing `\n`.
- **No TUIs in bash.** Agent CLIs hang in bash, even for `--help`. Capture one with `interactive_shell({ command: "pi --help", mode: "hands-free", timeout: 5000 })`. Headless one-shots (`claude -p`, `codex exec`, `pi -p`) are fine in bash.
- **Isolate unattended agents.** An agent you aren't watching in a repository gets `spawn: { worktree: true }` or its own `cwd`. A raw command runs in its `cwd` and can change that checkout's Git state.
- **Pi by default.** Delegate to `pi` unless the user names Claude, Codex, Gemini, Cursor, or another CLI.
- **Clean up.** Before finishing, kill or dismiss every session you started for a finite check, including ones the user backgrounded with Ctrl+B. Keep only long-lived work the user wants, such as dev servers or watchers. `kill` and `dismissBackground` cancel locally and attempt termination; subprocess exit is not confirmed.
- **Versus `subagent`.** `interactive_shell` runs any CLI where the user can watch and take over. The `subagent` tool runs Pi children for parallel or structured delegation with captured results.
- **Jev sends terminal text off the machine.** Semantic supervision is optional and off by default; it never takes the API key in tool args or project config. Read the Jev reference before using `monitor.semantic` or `semanticIncident`.

## Look up the rest

- Hands-free supervision, takeover (Ctrl+G), transfer (Ctrl+T), snapshots, incremental reads, `settings`, `attach`, interactive mode → [references/foreground.md](references/foreground.md)
- Structured `spawn`, `/spawn`, custom agents, per-agent CLI flags → [references/agents.md](references/agents.md)
- Recoverable selected output for a finite headless dispatch (`outputSelection`, `sourceId`) → [references/output-selection.md](references/output-selection.md)
- Jev semantic monitoring, actions, diagnostics, incidents, and `launchPolicy` → [references/jev.md](references/jev.md)
