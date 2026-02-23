---
name: codex-5.3-prompting
description: How to write system prompts and instructions for GPT-5.3-Codex. Use when constructing or tuning prompts targeting Codex 5.3.
---

# GPT-5.3-Codex Prompting Guide

GPT-5.3-Codex is fast, capable, and eager. It moves quickly and will skip reading, over-refactor, and drift scope if prompts aren't tight. Explicit constraints matter more than with GPT-5.2-Codex. Include the following blocks as needed when constructing system prompts.

## Output shape

Always include. Controls verbosity and response structure.

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

Always include. GPT-5.3-Codex will add features, refactor adjacent code, and invent UI elements if you don't fence it in.

```
<design_and_scope_constraints>
- Explore any existing design systems and understand them deeply.
- Implement EXACTLY and ONLY what the user requests.
- No extra features, no added components, no UX embellishments.
- Style aligned to the design system at hand.
- Do NOT invent colors, shadows, tokens, animations, or new UI elements unless requested or necessary.
- If any instruction is ambiguous, choose the simplest valid interpretation.
</design_and_scope_constraints>
```

## Context loading

Always include. GPT-5.3-Codex skips reading and starts writing if you don't force it.

```
<context_loading>
- Read ALL files that will be modified -- in full, not just the sections mentioned in the task.
- Also read key files they import from or that depend on them.
- Absorb surrounding patterns, naming conventions, error handling style, and architecture before writing any code.
- Do not ask clarifying questions about things that are answerable by reading the codebase.
</context_loading>
```

## Plan-first mode

Include for multi-file work, large refactors, or any task with ordering dependencies.

```
<plan_first>
- Before writing any code, produce a brief implementation plan:
  - Files to create vs. modify
  - Implementation order and prerequisites
  - Key design decisions and edge cases
  - Acceptance criteria for "done"
- Get the plan right first. Then implement step by step following the plan.
- If the plan is provided externally, follow it faithfully -- the job is execution, not second-guessing the design.
</plan_first>
```

## Long-context handling

Include when inputs exceed ~10k tokens (multi-chapter docs, long threads, multiple PDFs).

```
<long_context_handling>
- For inputs longer than ~10k tokens:
  - First, produce a short internal outline of the key sections relevant to the task.
  - Re-state the constraints explicitly before answering.
  - Anchor claims to sections ("In the 'Data Retention' section...") rather than speaking generically.
- If the answer depends on fine details (dates, thresholds, clauses), quote or paraphrase them.
</long_context_handling>
```

## Uncertainty and ambiguity

Include when the task involves underspecified requirements or hallucination-prone domains.

```
<uncertainty_and_ambiguity>
- If the question is ambiguous or underspecified:
  - Ask up to 1-3 precise clarifying questions, OR
  - Present 2-3 plausible interpretations with clearly labeled assumptions.
- Never fabricate exact figures, line numbers, or external references when uncertain.
- When unsure, prefer "Based on the provided context..." over absolute claims.
</uncertainty_and_ambiguity>
```

## User updates

Include for agentic / long-running tasks.

```
<user_updates_spec>
- Send brief updates (1-2 sentences) only when:
  - You start a new major phase of work, or
  - You discover something that changes the plan.
- Avoid narrating routine tool calls ("reading file...", "running tests...").
- Each update must include at least one concrete outcome ("Found X", "Confirmed Y", "Updated Z").
- Do not expand the task beyond what was asked; if you notice new work, call it out as optional.
</user_updates_spec>
```

## Tool usage

Include when the prompt involves tool-calling agents.

```
<tool_usage_rules>
- Prefer tools over internal knowledge whenever:
  - You need fresh or user-specific data (tickets, orders, configs, logs).
  - You reference specific IDs, URLs, or document titles.
- Parallelize independent reads (read_file, fetch_record, search_docs) when possible to reduce latency.
- After any write/update tool call, briefly restate:
  - What changed
  - Where (ID or path)
  - Any follow-up validation performed
</tool_usage_rules>
```

## Reasoning effort

Set `model_reasoning_effort` via Codex CLI: `-c model_reasoning_effort="high"`

| Task type | Effort |
|---|---|
| Simple code generation, formatting | `low` or `medium` |
| Standard implementation from clear specs | `high` |
| Complex refactors, plan review, architecture | `xhigh` |
| Code review (thorough) | `high` or `xhigh` |

## Backwards compatibility hedging

GPT-5.3-Codex has a strong tendency to preserve old patterns, add compatibility shims, and provide fallback code "just in case" -- even when explicitly told not to worry about backwards compatibility. Vague instructions like "don't worry about backwards compatibility" get interpreted weakly; the model may still hedge.

Use **"cutover"** to signal a clean, irreversible break. It's a precise industry term that conveys finality and intentional deprecation -- no dual-support phase, no gradual migration, no preserving old behavior.

Instead of:
> "Rewrite this and don't worry about backwards compatibility"

Say:
> "This is a cutover. No backwards compatibility. Rewrite using only Python 3.12+ features and current best practices. Do not preserve legacy code, polyfills, or deprecated patterns."

## Quick reference

- **Force reading first.** "Read all necessary files before you ask any dumb question."
- **Use plan mode.** Draft the full task with acceptance criteria before implementing.
- **Steer aggressively mid-task.** GPT-5.3-Codex handles redirects without losing context. Be direct: "Stop. Fix the actual cause." / "Simplest valid implementation only."
- **Constrain scope hard.** GPT-5.3-Codex will refactor aggressively if you don't fence it in.
- **Watch context burn.** Faster model = faster context consumption. Start fresh at ~40%.
- **Use domain jargon.** "Cutover," "golden-path," "no fallbacks," "domain split" get cleaner, faster responses.
- **Download libraries locally.** Tell it to read them for better context than relying on training data.
