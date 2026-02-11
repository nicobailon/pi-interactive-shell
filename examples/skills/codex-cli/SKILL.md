---
name: codex-cli
description: OpenAI Codex CLI reference. Use when running codex in interactive_shell overlay or when user asks about codex CLI options.
---

# Codex CLI (OpenAI)

## Commands

| Command | Description |
|---------|-------------|
| `codex` | Start interactive TUI |
| `codex "prompt"` | TUI with initial prompt |
| `codex exec "prompt"` | Non-interactive (headless), streams to stdout. Supports `--output-schema <file>` for structured JSON output |
| `codex e "prompt"` | Shorthand for exec |
| `codex login` | Authenticate (OAuth, device auth, or API key) |
| `codex login status` | Show auth mode |
| `codex logout` | Remove credentials |
| `codex mcp` | Manage MCP servers |
| `codex completion` | Generate shell completions |

## Key Flags

| Flag | Description |
|------|-------------|
| `-m, --model <model>` | Switch model (default: `gpt-5.3-codex`) |
| `-c <key=value>` | Override config.toml values (dotted paths, parsed as TOML) |
| `-p, --profile <name>` | Use config profile from config.toml |
| `-s, --sandbox <mode>` | Sandbox policy: `read-only`, `workspace-write`, `danger-full-access` |
| `-a, --ask-for-approval <policy>` | `untrusted`, `on-failure`, `on-request`, `never` |
| `--full-auto` | Alias for `-a on-request --sandbox workspace-write` |
| `--search` | Enable live web search tool |
| `-i, --image <file>` | Attach image(s) to initial prompt |
| `--add-dir <dir>` | Additional writable directories |
| `-C, --cd <dir>` | Set working root directory |
| `--no-alt-screen` | Inline mode (preserve terminal scrollback) |

## Sandbox Modes

- `read-only` - Can only read files
- `workspace-write` - Can write to workspace
- `danger-full-access` - Full system access (use with caution)

## Features

- **Image inputs** - Accepts screenshots and design specs
- **Code review** - Reviews changes before commit
- **Web search** - Can search for information
- **MCP integration** - Third-party tool support

## Config

Config file: `~/.codex/config.toml`

Key config values (set in file or override with `-c`):
- `model` -- model name (e.g., `gpt-5.3-codex`)
- `model_reasoning_effort` -- `low`, `medium`, `high`, `xhigh`
- `model_reasoning_summary` -- `detailed`, `concise`, `none`
- `model_verbosity` -- `low`, `medium`, `high`
- `profile` -- default profile name
- `tool_output_token_limit` -- max tokens per tool output

Define profiles for different projects/modes with `[profiles.<name>]` sections. Override at runtime with `-p <name>` or `-c model_reasoning_effort="high"`.

## In interactive_shell

Do NOT pass `-s` / `--sandbox` flags. Codex's `read-only` and `workspace-write` sandbox modes apply OS-level filesystem restrictions that break basic shell operations inside the PTY -- zsh can't even create temp files for here-documents, so every write attempt fails with "operation not permitted." The interactive shell overlay already provides supervision (user watches in real-time, Ctrl+Q to kill, Ctrl+T to transfer output), making Codex's sandbox redundant.

Use explicit flags to control model and behavior per-run.

For delegated fire-and-forget runs, prefer `mode: "dispatch"` so the agent is notified automatically when Codex completes.

```typescript
// Delegated run with completion notification (recommended default)
interactive_shell({
  command: 'codex -m gpt-5.3-codex -a never "Review this codebase for security issues"',
  mode: "dispatch"
})

// Override reasoning effort for a single delegated run
interactive_shell({
  command: 'codex -m gpt-5.3-codex -c model_reasoning_effort="xhigh" -a never "Complex refactor task"',
  mode: "dispatch"
})

// Headless - use bash instead
bash({ command: 'codex exec "summarize the repo"' })
```
