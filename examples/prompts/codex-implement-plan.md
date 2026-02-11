---
description: Launch Codex CLI in overlay to fully implement an existing plan/spec document
---
Load the `codex-5.3-prompting` and `codex-cli` skills. Then read the plan at `$1`.

Analyze the plan to understand: how many files are created vs modified, whether there's a prescribed implementation order or prerequisites, what existing code is referenced, and roughly how large the implementation is.

Based on the prompting skill's best practices and the plan's content, generate a comprehensive meta prompt tailored for Codex CLI. The meta prompt should instruct Codex to:

1. Read and internalize the full plan document. Identify every file to be created, every file to be modified, and any prerequisites or ordering constraints.
2. Before writing any code, read all existing files that will be modified — in full, not just the sections mentioned in the plan. Also read key files they import from or that import them, to absorb the surrounding patterns, naming conventions, and architecture.
3. If the plan specifies an implementation order or prerequisites (e.g., "extract module X before building Y"), follow that order exactly. Otherwise, implement bottom-up: shared utilities and types first, then the modules that depend on them, then integration/registration code last.
4. Implement each piece completely. No stubs, no TODOs, no placeholder comments, no "implement this later" shortcuts. Every function body, every edge case handler, every error path described in the plan must be real code.
5. Match existing code patterns exactly — same formatting, same import style, same error handling conventions, same naming. Read the surrounding codebase to absorb these patterns before writing. If the plan references patterns from specific files (e.g., "same pattern as X"), read those files and replicate the pattern faithfully.
6. Stay within scope. Do not refactor, rename, or restructure adjacent code that the plan does not mention. No "while I'm here" improvements. If something adjacent looks wrong, note it in the summary but do not touch it.
7. Keep files reasonably sized. If a file grows beyond ~500 lines, split it as the plan describes or refactor into logical sub-modules.
8. After implementing all files, do a self-review pass: re-read the plan from top to bottom and verify every requirement, every edge case, every design decision is addressed in the code. Check for: missing imports, type mismatches, unreachable code paths, inconsistent field names between modules, and any plan requirement that was overlooked.
9. Do NOT commit or push. Write a summary listing every file created or modified, what was implemented in each, and any plan ambiguities that required judgment calls.

The meta prompt should follow the prompting skill's patterns: clear system context, explicit scope and verbosity constraints, step-by-step instructions, and expected output format. Instruct Codex not to ask clarifying questions about things answerable by reading the plan or codebase — read first, then act. Keep progress updates brief and concrete (no narrating routine file reads or tool calls). Emphasize that the plan has already been thoroughly reviewed — the job is faithful execution, not second-guessing the design. Emphasize scope discipline — GPT-5.3-Codex is aggressive about refactoring adjacent code if not explicitly fenced in.

Then launch Codex CLI in the interactive shell overlay with that meta prompt using these flags: `-m gpt-5.3-codex -c model_reasoning_effort="high" -a never`.

Use `interactive_shell` with `mode: "dispatch"` for this delegated run (fire-and-forget with completion notification). Do NOT pass sandbox flags in interactive_shell. Dispatch mode only. End turn immediately. Do not poll. Wait for completion notification.

$@
