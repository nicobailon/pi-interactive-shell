---
description: Launch Codex CLI in overlay to review implemented code changes (optionally against a plan)
---
Read the Codex prompting guide at https://developers.openai.com/cookbook/examples/gpt-5/gpt-5-2_prompting_guide.md using fetch_content or web_search. Then determine the review scope:

- If `$1` looks like a file path (contains `/` or ends in `.md`): read it as the plan/spec these changes were based on. The diff scope is uncommitted changes vs HEAD, or if clean, the current branch vs main.
- Otherwise: no plan file. Diff scope is the same. Treat all of `$@` as additional review context or focus areas.

Run the appropriate git diff to identify which files changed and how many lines are involved. This context helps you generate a better-calibrated meta prompt.

Based on the prompting guide's best practices, the diff scope, and the optional plan, generate a comprehensive meta prompt tailored for Codex CLI. The meta prompt should instruct Codex to:

1. Identify all changed files via git diff, then read every changed file in full — not just the diff hunks. For each changed file, also read the files it imports from and key files that depend on it, to understand integration points and downstream effects.
2. If a plan/spec was provided, read it and verify the implementation is complete — every requirement addressed, no steps skipped, nothing invented beyond scope, no partial stubs left behind.
3. Review each changed file for: bugs, logic errors, race conditions, resource leaks (timers, event listeners, file handles, unclosed connections), null/undefined hazards, off-by-one errors, error handling gaps, type mismatches, dead code, unused imports/variables/parameters, unnecessary complexity, and inconsistency with surrounding code patterns and naming conventions.
4. Trace key code paths end-to-end across function and file boundaries — verify data flows, state transitions, error propagation, and cleanup ordering. Don't evaluate functions in isolation.
5. Check for missing or inadequate tests, stale documentation, and missing changelog entries.
6. Fix every issue found with direct code edits. After all fixes, write a clear summary listing what was found, what was fixed, and any remaining concerns that require human judgment.

The meta prompt should follow the Codex guide's structure: clear system context, explicit scope and verbosity constraints, step-by-step instructions, and expected output format. Emphasize thoroughness — read the actual code deeply before making judgments, question every assumption, and never rubber-stamp.

Then launch Codex CLI in the interactive shell overlay with that meta prompt using these flags: `-m gpt-5.3-codex -c model_reasoning_effort="high" -a never`. Do NOT pass sandbox flags in interactive_shell. End your turn immediately after launching -- do not poll the session. The user will manage the overlay directly.

$@
