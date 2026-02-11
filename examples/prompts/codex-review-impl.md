---
description: Launch Codex CLI in overlay to review implemented code changes (optionally against a plan)
---
Load the `codex-5.3-prompting` and `codex-cli` skills. Then determine the review scope:

- If `$1` looks like a file path (contains `/` or ends in `.md`): read it as the plan/spec these changes were based on. The diff scope is uncommitted changes vs HEAD, or if clean, the current branch vs main.
- Otherwise: no plan file. Diff scope is the same. Treat all of `$@` as additional review context or focus areas.

Run the appropriate git diff to identify which files changed and how many lines are involved. This context helps you generate a better-calibrated meta prompt.

Based on the prompting skill's best practices, the diff scope, and the optional plan, generate a comprehensive meta prompt tailored for Codex CLI. The meta prompt should instruct Codex to:

1. Identify all changed files via git diff, then read every changed file in full — not just the diff hunks. For each changed file, also read the files it imports from and key files that depend on it, to understand integration points and downstream effects.
2. If a plan/spec was provided, read it and verify the implementation is complete — every requirement addressed, no steps skipped, nothing invented beyond scope, no partial stubs left behind.
3. Review each changed file for: bugs, logic errors, race conditions, resource leaks (timers, event listeners, file handles, unclosed connections), null/undefined hazards, off-by-one errors, error handling gaps, type mismatches, dead code, unused imports/variables/parameters, unnecessary complexity, and inconsistency with surrounding code patterns and naming conventions.
4. Trace key code paths end-to-end across function and file boundaries — verify data flows, state transitions, error propagation, and cleanup ordering. Don't evaluate functions in isolation.
5. Check for missing or inadequate tests, stale documentation, and missing changelog entries.
6. Fix every issue found with direct code edits. Keep fixes scoped to the actual issues identified — do not expand into refactoring or restructuring code that wasn't flagged in the review. If adjacent code looks problematic, note it in the summary but don't touch it.
7. After all fixes, write a clear summary listing what was found, what was fixed, and any remaining concerns that require human judgment.

The meta prompt should follow the prompting skill's patterns: clear system context, explicit scope and verbosity constraints, step-by-step instructions, and expected output format. Instruct Codex not to ask clarifying questions — if intent is unclear, read the surrounding code for context instead of asking. Keep progress updates brief and concrete (no narrating routine file reads or tool calls). Emphasize thoroughness — read the actual code deeply before making judgments, question every assumption, and never rubber-stamp. GPT-5.3-Codex moves fast and can skim; the meta prompt must force it to slow down and read carefully before judging.

Then launch Codex CLI in the interactive shell overlay with that meta prompt using these flags: `-m gpt-5.3-codex -c model_reasoning_effort="high" -a never`.

Use `interactive_shell` with `mode: "dispatch"` for this delegated run (fire-and-forget with completion notification). Do NOT pass sandbox flags in interactive_shell. Dispatch mode only. End turn immediately. Do not poll. Wait for completion notification.

$@
