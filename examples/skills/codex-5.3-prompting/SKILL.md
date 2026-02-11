---
name: codex-5.3-prompting
description: Prompting guide for GPT-5.3-Codex. Best practices for writing system prompts, meta prompts, and instructions targeting GPT-5.3-Codex behavior. Use when generating prompts for Codex 5.3 or tuning its behavior
---

# GPT-5.3-Codex Prompting Guide

GPT-5.3-Codex is OpenAI's latest coding-focused model (February 2026). It's faster than 5.2 (~25%), stronger on complex multi-file tasks, and better at mid-task steering. It's also less deliberate -- it moves quickly and can feel rushed or over-eager if prompts aren't tight. The tradeoff is speed and capability for less implicit patience, so explicit constraints matter more than they did with 5.2.

This guide covers prompt patterns that work well with 5.3.

## Key behavioral differences from 5.2

- **Faster, less deliberate.** 5.3 executes quicker but is more prone to hasty mistakes on hard tasks if not constrained. It benefits from plan-first workflows where the full task is drafted before implementation begins.
- **Stronger mid-task steering.** You can interrupt and redirect without losing context. Clear commands like "stop introducing legacy compatibility -- fix the root problem" work well.
- **More aggressive refactoring.** 5.3 may delete or restructure code beyond what was asked. Scope discipline is critical.
- **Better agentic autonomy.** Stronger on long multi-step runs, but monitor context usage -- if it drops below ~40%, start fresh to avoid repetition or confused questions.
- **Responds well to structured, constrained prompts.** Jargon like "golden-path," "no fallbacks," "domain split" gets faster, more accurate responses.

## Controlling verbosity and output shape

Give clear, concrete length constraints. 5.3 is generally concise but still prompt-sensitive.

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

## Preventing scope drift

5.3 is stronger at structured code but tends to produce more than asked for. Explicitly forbid extra features and uncontrolled styling, especially in frontend tasks.

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

For 5.3 specifically, reinforce scope discipline harder than you would with 5.2. It's more likely to "helpfully" refactor adjacent code or add defensive patterns you didn't ask for.

## Force thorough reading upfront

5.3 moves fast and sometimes starts writing before it fully understands the context. Force it to read first.

```
<context_loading>
- Read ALL files that will be modified -- in full, not just the sections mentioned in the task.
- Also read key files they import from or that depend on them.
- Absorb surrounding patterns, naming conventions, error handling style, and architecture before writing any code.
- Do not ask clarifying questions about things that are answerable by reading the codebase.
</context_loading>
```

This is more important with 5.3 than 5.2. The model is eager to start producing output and will skip reading steps if you let it.

## Plan mode for complex tasks

For large refactors or multi-file work, draft the full task before implementing. This reduces cascading errors significantly with 5.3.

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

## Long-context and recall

For inputs over ~10k tokens, force summarization and re-grounding to prevent "lost in the scroll" errors.

```
<long_context_handling>
- For inputs longer than ~10k tokens (multi-chapter docs, long threads, multiple PDFs):
  - First, produce a short internal outline of the key sections relevant to the task.
  - Re-state the constraints explicitly before answering.
  - Anchor claims to sections ("In the 'Data Retention' section...") rather than speaking generically.
- If the answer depends on fine details (dates, thresholds, clauses), quote or paraphrase them.
</long_context_handling>
```

## Handling ambiguity and hallucination risk

5.3 can be overconfident. Configure prompts for uncertain situations.

```
<uncertainty_and_ambiguity>
- If the question is ambiguous or underspecified:
  - Ask up to 1-3 precise clarifying questions, OR
  - Present 2-3 plausible interpretations with clearly labeled assumptions.
- Never fabricate exact figures, line numbers, or external references when uncertain.
- When unsure, prefer "Based on the provided context..." over absolute claims.
</uncertainty_and_ambiguity>
```

## Agentic steerability and user updates

5.3 is strong on agentic scaffolding. Keep updates brief and scope-disciplined.

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

## Mid-task steering (new in 5.3)

5.3 handles interrupts and course corrections better than 5.2. When the model goes off track, be direct:

- "Stop. Read the error message again and fix the actual cause."
- "Don't add backwards compatibility. Just implement the new approach."
- "You're overcomplicating this. Simplest valid implementation only."

These work mid-conversation without losing prior context. With 5.2 you'd often need to start over; 5.3 can pivot in place.

## Tool-calling and parallelism

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

## Context management

Monitor context usage in long sessions. With 5.3's speed, you burn through context faster.

- If context drops below ~40%, start a new session to avoid degraded quality.
- When starting a new session, keep your instructions functionally identical to avoid behavior drift.

## Reasoning effort

GPT-5.3-Codex supports `model_reasoning_effort`: `low`, `medium`, `high`, `xhigh`.

| Task type | Recommended effort |
|---|---|
| Simple code generation, formatting | `low` or `medium` |
| Standard implementation from clear specs | `high` |
| Complex refactors, plan review, architecture decisions | `xhigh` |
| Code review (thorough) | `high` or `xhigh` |

Set via Codex CLI: `-c model_reasoning_effort="high"`

## Quick reference: 5.3-specific prompting tips

- **Force reading first.** "Read all necessary files before you ask any dumb question."
- **Use plan mode.** Draft the full task with acceptance criteria before implementing.
- **Steer aggressively mid-task.** Clear, direct commands to redirect without losing context.
- **Constrain scope hard.** 5.3 will refactor aggressively if you don't fence it in.
- **Watch context burn.** Faster model = faster context consumption. Start fresh at ~40%.
- **Use domain jargon.** "Golden-path," "no fallbacks," "domain split" get faster responses.
- **Download libraries locally.** Tell it to read them for better context than relying on training data.
