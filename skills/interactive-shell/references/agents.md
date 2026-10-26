# Launching coding agents

## Structured spawn

For Pi, Codex, Claude, Cursor, and user-defined agents, structured `spawn` uses the same resolver and config defaults as the `/spawn` command, the agent's native startup prompt form, and Pi-only fork and worktree support:

```js
interactive_shell({ spawn: { agent: "pi" }, mode: "interactive" })
interactive_shell({ spawn: { agent: "codex" }, mode: "dispatch" })
interactive_shell({ spawn: { agent: "cursor", prompt: "Review the diffs" }, mode: "dispatch" })
interactive_shell({ spawn: { agent: "claude", prompt: "Review the diffs" }, mode: "dispatch" })
interactive_shell({ spawn: { agent: "claude", worktree: true }, mode: "hands-free" })
interactive_shell({ spawn: { mode: "fork" }, mode: "interactive" })   // Pi only
```

Users can add agents under `spawn.commands` in `interactive-shell.json`; those keys work in `spawn: { agent }` like the built-ins, and an unknown key returns the configured list. Cursor defaults to `--model composer-2-fast`. Use a raw `command` for any other CLI or a custom launch string.

## Raw commands

Put the prompt in the command; `reason` is display text only.

| Agent | Interactive | With prompt | Headless (bash) |
|---|---|---|---|
| `pi` | `pi` | `pi "prompt"` | `pi -p "prompt"` |
| `claude` | `claude` | `claude "prompt"` | `claude -p "prompt"` |
| `codex` | `codex` | `codex "prompt"` | `codex exec "prompt"` |
| `gemini` | `gemini` | `gemini -i "prompt"` | `gemini "prompt"` |
| `agent` (Cursor) | `agent` | `agent "prompt"` | `agent -p "prompt"` |

## `/spawn` for users

Users type `/spawn` for the configured default agent, or name one: `/spawn codex`, `/spawn cursor`, `/spawn claude`, `/spawn pi`, `/spawn fork`, `/spawn pi fork`, or any `spawn.commands` key. Add `--worktree` for a separate git worktree. A quoted prompt plus `--hands-free` or `--dispatch` makes it a monitored delegated run:

```bash
/spawn claude "review the diffs" --dispatch
/spawn codex "fix the failing tests" --hands-free
/spawn pi fork "continue from here" --dispatch
```
