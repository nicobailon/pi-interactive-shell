---
description: Launch Codex CLI in overlay to review an implementation plan against the codebase
---
Determine which prompting skill to load based on model:
- Default: Load `gpt-5-4-prompting` skill (for `gpt-5.4`)
- If user explicitly requests Codex 5.3: Load `codex-5-3-prompting` skill (for `gpt-5.3-codex`)

Also load the `codex-cli` skill. Then read the plan at `$1`.

Based on the prompting skill's best practices and the plan's content, generate a comprehensive meta prompt tailored for Codex CLI. The meta prompt should instruct Codex to:

1. Read and internalize the full plan. Then read every codebase file the plan references — in full, not just the sections mentioned. Also read key files adjacent to those (imports, dependents) to understand the real state of the code the plan targets.
2. Systematically review the plan against what the code actually looks like, not what the plan assumes it looks like.
3. Verify every assumption, file path, API shape, data flow, and integration point mentioned in the plan against the actual codebase.
4. Check that the plan's approach is logically sound, complete, and accounts for edge cases.
5. Identify any gaps, contradictions, incorrect assumptions, or missing steps.
6. Make targeted edits to the plan file to fix issues found, adding inline notes where changes were made. Fix what's wrong — do not restructure or rewrite sections that are correct.

The meta prompt should follow the prompting skill's patterns (clear system context, explicit constraints, step-by-step instructions, expected output format). Instruct Codex not to ask clarifying questions — read the codebase to resolve ambiguities instead of asking. Keep progress updates brief and concrete. Emphasize scope discipline and verification requirements per the prompting skill.

Determine the model flag:
- Default: `-m gpt-5.4`
- If user explicitly requests Codex 5.3: `-m gpt-5.3-codex`

Then launch Codex CLI in the interactive shell overlay with that meta prompt using the chosen model flag plus `-a never`.

Use `interactive_shell` with `mode: "dispatch"` for this delegated run (fire-and-forget with completion notification). Do NOT pass sandbox flags in interactive_shell. Dispatch mode only. End turn immediately. Do not poll. Wait for completion notification.

$@
