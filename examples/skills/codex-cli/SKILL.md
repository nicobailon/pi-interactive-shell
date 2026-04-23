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
- **Image generation (gpt-image-2)** - Generate images via natural language or explicit invocation
- **Code review** - Reviews changes before commit
- **Web search** - Can search for information
- **MCP integration** - Third-party tool support

## Image Generation (gpt-image-2)

Codex CLI can generate images using OpenAI's **gpt-image-2** - the latest cutting-edge image model with superior realism, prompt adherence, and accurate text rendering in images. It can produce full high-fidelity design mockups for web pages and apps with unprecedented accuracy and control.

### How to Invoke

#### Natural Language (Recommended)

Just describe what you want naturally:

```bash
codex "Generate a clean app icon for a fitness tracker, flat design, 512x512"
codex "Create a hero banner for a SaaS landing page showing a dashboard with dark mode"
codex -i screenshot.png "Edit this screenshot to make the button green and add a tooltip"
```

#### Explicit Skill Invocation

Include `$imagegen` anywhere in your prompt to force the image-generation tool. This is a Codex keyword, not a shell variable, so shell examples use single quotes to keep it literal.

```bash
codex 'Make a pixel-art sprite sheet for a platformer game $imagegen'
codex 'Generate a logo for my coffee shop $imagegen'
```

Codex will generate the image(s), display them inline in the terminal (or save them locally). You can iterate on them, attach them to future prompts, or use them in your codebase.

### Tips

- **Image editing / iteration**: Attach a reference image (screenshot, wireframe, mockup) to your prompt. Codex handles multimodal input natively.
  ```bash
  codex -i wireframe.png "Turn this wireframe into a polished UI mockup"
  codex -i design.png "Generate code for this design"
  ```

- **Usage & limits**: Images count against your regular Codex usage quota and consume it 3-5x faster than text-only turns (depending on size/quality).

- **Heavy/batch work**: For production pipelines, set `OPENAI_API_KEY` in your shell and tell Codex to call the OpenAI Images API directly. It will then use `gpt-image-2` with full API pricing and options.

- **No config needed**: Image generation is enabled by default. Older experimental flags like `codex features enable image_generation` are no longer required.

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

For users with a default profile configured, just run `codex "prompt"` to use those defaults -- no model or profile flags needed.

For delegated fire-and-forget runs, prefer `mode: "dispatch"` so the agent is notified automatically when Codex completes.

```typescript
// Delegated run with completion notification (recommended default)
interactive_shell({
  command: 'codex "Review this codebase for security issues"',
  mode: "dispatch"
})

// Override reasoning effort for a single delegated run
interactive_shell({
  command: 'codex -c model_reasoning_effort="xhigh" "Complex refactor task"',
  mode: "dispatch"
})

// Headless - use bash instead
bash({ command: 'codex exec "summarize the repo"' })
```
