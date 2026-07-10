---
name: cursor-cli
description: Cursor CLI reference. Use when running Cursor in interactive_shell (managed kitty tabs) or when user asks about Cursor CLI options.
---

# Cursor CLI

## Commands

| Command                    | Description                             |
| -------------------------- | --------------------------------------- |
| `agent`                    | Start interactive Cursor session        |
| `agent "prompt"`           | Interactive session with initial prompt |
| `agent -p "prompt"`        | Non-interactive print mode              |
| `agent ls`                 | List previous chats                     |
| `agent resume`             | Resume latest chat                      |
| `agent --continue`         | Continue previous session               |
| `agent --resume "chat-id"` | Resume a specific chat                  |

## Key Flags

| Flag                     | Description                            |
| ------------------------ | -------------------------------------- | ----------------------- |
| `--mode plan` / `--plan` | Plan mode (clarify before coding)      |
| `--mode ask`             | Ask mode (read-only exploration)       |
| `--model <model>`        | Model override                         |
| `--sandbox <enabled      | disabled>`                             | Toggle sandbox behavior |
| `--output-format text`   | Output format for print mode workflows |

## Mode Notes

- **Interactive mode** (`agent`, `agent "prompt"`) is the right fit for `interactive_shell` kitty tabs.
- **Print mode** (`agent -p`) is non-interactive and better suited to direct shell/batch usage.

## In interactive_shell

Use structured spawn when you want the extension's shared spawn resolver/defaults/worktree support:

```typescript
interactive_shell({ spawn: { agent: "cursor" }, mode: "interactive" });
interactive_shell({ spawn: { agent: "cursor", prompt: "Review the diffs" }, mode: "dispatch" });
interactive_shell({ spawn: { agent: "cursor", worktree: true }, mode: "hands-free" });
```

Structured spawn launches Cursor via the configured `spawn.commands.cursor` executable (default: `agent`) and appends prompt text as Cursor's native interactive startup form (`agent "prompt"`). By default, spawn args include `--model composer-2-fast`, which selects Cursor's Composer 2 Fast model explicitly.

Cursor remains **fresh/worktree only** in structured spawn. `fork` is Pi-only.

For non-interactive print-mode tasks, prefer direct shell usage:

```typescript
bash({ command: 'agent -p "review these changes for security issues" --output-format text' });
```
