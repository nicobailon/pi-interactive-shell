---
description: Launch Codex CLI in overlay to review an implementation plan against the codebase
---
Read the Codex prompting guide at https://developers.openai.com/cookbook/examples/gpt-5/gpt-5-2_prompting_guide.md using fetch_content or web_search. Then read the plan at `$1`.

Based on the prompting guide's best practices and the plan's content, generate a comprehensive meta prompt tailored for Codex CLI. The meta prompt should instruct Codex to:

1. Read and internalize the full plan
2. Systematically review the plan against the reference docs/links/code
3. Verify every assumption, file path, API shape, data flow, and integration point mentioned in the plan
4. Check that the plan's approach is logically sound, complete, and accounts for edge cases
5. Identify any gaps, contradictions, incorrect assumptions, or missing steps
6. Make direct edits to the plan file to fix any issues found, adding inline notes where changes were made

The meta prompt should be structured according to the Codex guide's recommendations (clear system context, explicit constraints, step-by-step instructions, expected output format).

Then launch Codex CLI in the interactive shell overlay with that meta prompt using these flags: `-m gpt-5.3-codex -c model_reasoning_effort="xhigh" -a never`. Do NOT pass sandbox flags in interactive_shell. End your turn immediately after launching -- do not poll the session. The user will manage the overlay directly.

$@
