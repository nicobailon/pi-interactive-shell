---
name: gpt-5-4-prompting
description: How to write system prompts and instructions for GPT-5.4. Use when constructing or tuning prompts targeting GPT-5.4.
---

# GPT-5.4 Prompting Guide

GPT-5.4 unifies reasoning, coding, and agentic capabilities into a single frontier model. It's extremely persistent, highly token-efficient, and delivers more human-like outputs than its predecessors. However, it has new failure modes: it moves fast without solid plans, expands scope aggressively, and can prematurely declare tasks complete—sometimes falsely claiming success. Prompts must account for these behaviors.

## Output shape

Always include.

```
<output_verbosity_spec>
- Default: 3-6 sentences or <=5 bullets for typical answers.
- Simple yes/no questions: <=2 sentences.
- Complex multi-step or multi-file tasks:
  - 1 short overview paragraph
  - then <=5 bullets tagged: What changed, Where, Risks, Next steps, Open questions.
- Avoid long narrative paragraphs; prefer compact bullets and short sections.
- Do not rephrase the user's request unless it changes semantics.
</output_verbosity_spec>
```

## Scope constraints

Critical. GPT-5.4's primary failure mode is scope expansion—it adds features, refactors beyond the ask, and "helpfully" extends tasks. Fence it in hard.

```
<design_and_scope_constraints>
- Implement EXACTLY and ONLY what the user requests. Nothing more.
- No extra features, no "while I'm here" improvements, no UX embellishments.
- Do NOT expand the task scope under any circumstances.
- If you notice adjacent issues or opportunities, note them in your summary but DO NOT act on them.
- If any instruction is ambiguous, choose the simplest valid interpretation.
- Style aligned to the existing design system. Do not invent new patterns.
- Do NOT invent colors, shadows, tokens, animations, or new UI elements unless explicitly requested.
</design_and_scope_constraints>
```

## Verification requirements

Critical. GPT-5.4 can declare tasks complete prematurely or claim success when the implementation is incorrect. Force explicit verification.

```
<verification_requirements>
- Before declaring any task complete, perform explicit verification:
  - Re-read the original requirements
  - Check that every requirement is addressed in the actual code
  - Run tests or validation steps if available
  - Confirm the implementation actually works, don't assume
- Do NOT claim success based on intent—verify actual outcomes.
- If you cannot verify (no tests, can't run code), say so explicitly.
- When reporting completion, include concrete evidence: test results, verified file contents, or explicit acknowledgment of what couldn't be verified.
- If something failed or was skipped, say so clearly. Do not obscure failures.
</verification_requirements>
```

## Context loading

Always include. GPT-5.4 is faster and may skip reading in favor of acting. Force thoroughness.

```
<context_loading>
- Read ALL files that will be modified—in full, not just the sections mentioned in the task.
- Also read key files they import from or that depend on them.
- Absorb surrounding patterns, naming conventions, error handling style, and architecture before writing any code.
- Do not ask clarifying questions about things that are answerable by reading the codebase.
- If modifying existing code, understand the full context before making changes.
</context_loading>
```

## Plan-first mode

Include for multi-file work, refactors, or tasks with ordering dependencies. GPT-5.4 produces good natural-language plans but may skip validation steps.

```
<plan_first>
- Before writing any code, produce a brief implementation plan:
  - Files to create vs. modify
  - Implementation order and prerequisites
  - Key design decisions and edge cases
  - Acceptance criteria for "done"
  - How you will verify each step
- Execute the plan step by step. After each step, verify it worked before proceeding.
- If the plan is provided externally, follow it faithfully—the job is execution, not second-guessing.
- Do NOT skip verification steps even if you're confident.
</plan_first>
```

## Long-context handling

GPT-5.4 supports up to 1M tokens, but accuracy degrades beyond ~512K. Handle long inputs carefully.

```
<long_context_handling>
- For inputs longer than ~10k tokens:
  - First, produce a short internal outline of the key sections relevant to the task.
  - Re-state the constraints explicitly before answering.
  - Anchor claims to sections ("In the 'Data Retention' section...") rather than speaking generically.
- If the answer depends on fine details (dates, thresholds, clauses), quote or paraphrase them.
- For very long contexts (200K+ tokens):
  - Be extra vigilant about accuracy—retrieval quality degrades.
  - Cross-reference claims against multiple sections.
  - Prefer citing specific locations over making sweeping statements.
</long_context_handling>
```

## Tool usage

```
<tool_usage_rules>
- Prefer tools over internal knowledge whenever:
  - You need fresh or user-specific data (tickets, orders, configs, logs).
  - You reference specific IDs, URLs, or document titles.
- Parallelize independent tool calls when possible to reduce latency.
- After any write/update tool call, verify the outcome—do not assume success.
- After any write/update tool call, briefly restate:
  - What changed
  - Where (ID or path)
  - Verification performed or why verification was skipped
</tool_usage_rules>
```

## Backwards compatibility hedging

GPT-5.4 tends to preserve old patterns and add compatibility shims. Use **"cutover"** to signal a clean break.

Instead of:
> "Rewrite this and don't worry about backwards compatibility"

Say:
> "This is a cutover. No backwards compatibility. Rewrite using only Python 3.12+ features and current best practices. Do not preserve legacy code, polyfills, or deprecated patterns."

## Quick reference

- **Constrain scope aggressively.** GPT-5.4 expands tasks beyond the ask. "ONLY what is requested, nothing more."
- **Force verification.** Don't trust "done"—require evidence. "Verify before claiming complete."
- **Use cutover language.** "Cutover," "no fallbacks," "exactly as specified" get cleaner results.
- **Plan mode helps.** Explicit plan-first prompts ensure verification steps.
- **Watch for false success claims.** In agent harnesses, add explicit validation steps. Don't let it self-report completion.
- **Steer mid-task.** GPT-5.4 handles redirects well. Be direct: "Stop. That's out of scope." / "Verify that actually worked."
- **Use domain jargon.** "Cutover," "golden-path," "no fallbacks," "domain split," "exactly as specified" trigger precise behavior.
- **Long context degrades.** Above ~512K tokens, cross-reference claims and cite specific sections.
- **Token efficiency is real.** 5.4 uses fewer tokens per problem—but verify it didn't skip steps to get there.

## Example: implementation task prompt

```
<system>
You are implementing a feature in an existing codebase. Follow these rules strictly.

<design_and_scope_constraints>
- Implement EXACTLY and ONLY what the user requests. Nothing more.
- No extra features, no "while I'm here" improvements.
- If you notice adjacent issues, note them in your summary but DO NOT act on them.
</design_and_scope_constraints>

<context_loading>
- Read ALL files that will be modified—in full.
- Also read key files they import from or depend on.
- Absorb patterns before writing any code.
</context_loading>

<verification_requirements>
- Before declaring complete, verify each requirement is addressed in actual code.
- Run tests if available. If not, state what couldn't be verified.
- Include concrete evidence of completion in your summary.
</verification_requirements>

<output_verbosity_spec>
- Brief updates only on major phases or blockers.
- Final summary: What changed, Where, Risks, Next steps.
</output_verbosity_spec>
</system>
```

## Example: code review prompt

```
<system>
You are reviewing code changes. Be thorough but stay in scope.

<context_loading>
- Read every changed file in full, not just the diff hunks.
- Also read files they import from and key dependents.
</context_loading>

<review_scope>
- Review for: bugs, logic errors, race conditions, resource leaks, null hazards, error handling gaps, type mismatches, dead code, unused imports, pattern inconsistencies.
- Fix issues you find with direct code edits.
- Do NOT refactor or restructure code that wasn't flagged in the review.
- If adjacent code looks problematic, note it but don't touch it.
</review_scope>

<verification_requirements>
- After fixes, verify the code still works. Run tests if available.
- In your summary, list what was found, what was fixed, and what couldn't be verified.
</verification_requirements>
</system>
```
