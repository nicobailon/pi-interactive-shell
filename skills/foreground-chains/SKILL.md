---
name: foreground-chains
description: Orchestrate multi-agent workflows where users watch each step in the overlay. Uses different CLI agents (cursor, pi, codex) for specialized roles with file-based handoff and auto-continue support for agents that pause mid-task.
---

# Foreground Agent Chains

Run multi-step agent workflows with full user visibility. Each step runs in an overlay where the user watches and can intervene. Uses file-based handoff through a shared chain directory.

## Agent Roles

| Role | CLI | Model | Purpose |
|------|-----|-------|---------|
| **Scout** | `agent` (cursor) | (default) | Fast codebase scanning, context gathering |
| **Planner** | `pi` | claude-sonnet-4-5 | Strategic planning, task breakdown |
| **Worker** | `codex` | (default) | Implementation, code changes |
| **Reviewer** | `pi` | claude-sonnet-4-5 | Validates implementation, fixes issues |

*Adjust models based on availability and task complexity. Use `pi --list-models` to see available options.*

## Architecture

```
Scout ──► context.md ──► Planner ──► plan.md ──► Worker ──► impl.md ──► Reviewer
  │                          │                      │                       │
  │ gathers code +           │ head start,          │ auto-continue         │ validates +
  │ meta-prompt              │ can read more        │ for "Should I..."     │ fixes issues
  │                          │                      │                       │
  └──────────────────────────┴──────────────────────┴───────────────────────┤
                                                                            ▼
                                                                      progress.md
                                                                    (all agents append)
                                                                            │
                                                                            ▼
                                                                      Main Agent
                                                                    (reads at chain end)
```

## CLI Commands

```bash
# Scout (cursor-agent)
agent "prompt"

# Planner (pi)
pi --model claude-sonnet-4-5 "prompt"

# Worker (codex)
codex "prompt"

# Reviewer (pi)
pi --model claude-sonnet-4-5 "prompt"
```

## Chain Directory Structure

```
/tmp/pi-chain-runs/{runId}/
├── progress.md     # Running log - ALL agents append to this
├── context.md      # Scout → Planner handoff
├── plan.md         # Planner → Worker handoff
└── impl.md         # Worker → Reviewer handoff
```

**Handoff files**: Structured output passed to the next agent.

**progress.md**: Running log that every agent appends to. Main agent reads this at the end for the complete chain story.

## Step 1: Scout

Fast codebase recon that gathers relevant code so the planner gets a head start and spends less time reading files.

```typescript
const runId = Date.now().toString(36);
const chainDir = `/tmp/pi-chain-runs/${runId}`;

// Create chain directory
bash({ command: `mkdir -p ${chainDir}` })

// Start scout
interactive_shell({
  command: `agent "You are a scout. The user wants: ${task}

Your job: Gather all relevant code into context.md so the planner gets a head start and spends less time reading files.

Strategy:
1. grep/find to locate relevant code
2. Read key sections (not entire files)  
3. Stuff actual code snippets into context.md
4. Note how pieces connect

Save to ${chainDir}/context.md:

# Code Context

## User Intent
Restate what the user wants in your own words.

## Files Retrieved
List with exact line ranges:
1. \`path/to/file.ts\` (lines 10-50) - Description
2. \`path/to/other.ts\` (lines 100-150) - Description

## Key Code
The actual code snippets from those files. Include complete types, interfaces, functions - everything the planner needs to see. This is the main payload.

## Architecture
Brief explanation of how the pieces connect. Dependencies between files.

## Planning Guidance
Synthesize the user's intent with your codebase findings:
- What approach makes sense given the existing architecture?
- Which files need modification and in what order?
- What patterns should the implementation follow?
- Risks or edge cases to address?

This is your tailored meta-prompt for the planner - connect what the user wants with how the codebase actually works.

Also CREATE ${chainDir}/progress.md:
## Scout - Context Gathered
- X files analyzed
- Key findings
- Recommended approach"`,
  mode: "hands-free",
  reason: "Step 1: Scout (cursor-agent)"
})
```

**Completion**: Poll until `status: "exited"`. Scout typically finishes cleanly without needing auto-continue.

## Step 2: Planner

Creates implementation plan. Gets a head start from context.md (scout pre-gathered the relevant code), but can still read additional files if needed.

```typescript
interactive_shell({
  command: `pi --model claude-sonnet-4-5 "Read ${chainDir}/context.md first - the scout already gathered relevant code snippets and provided planning guidance.

Create a detailed implementation plan for: ${task}

You have a head start from context.md, but you can read additional files if needed.

Your plan should include:
1. Task breakdown with clear steps
2. File modification order
3. Testing strategy
4. Risk areas to watch

Save your plan to ${chainDir}/plan.md with numbered steps.

Also APPEND to ${chainDir}/progress.md:
## Planner - Implementation Plan
- (number of tasks, key decisions, risks identified)"`,
  mode: "hands-free",
  reason: "Step 2: Planner (pi)"
})
```

**Completion**: Poll until `status: "exited"`. Planner typically finishes cleanly.

## Step 3: Worker (with Auto-Continue)

Implementation step that often pauses to ask questions.

### The Problem

Codex frequently pauses mid-task with prompts like:
- "Should I also update the tests?"
- "Do you want me to refactor this function?"
- "Would you like me to continue with the next file?"
- "Shall I proceed with the remaining tasks?"

Without intervention, it stops and waits indefinitely.

### The Solution

1. **Disable auto-exit** so the session stays alive when codex pauses
2. **Detect waiting patterns** in the output
3. **Send "continue"** to keep it working
4. **Detect true completion** via explicit signal or exit

```typescript
// Start worker with auto-exit disabled
interactive_shell({
  command: `codex "Read the implementation plan at ${chainDir}/plan.md

Implement ALL tasks in the plan. Do not stop until everything is complete.

As you work, APPEND to ${chainDir}/progress.md:
## Worker - Implementation
- [x] Task 1 - (what you did)
- [x] Task 2 - (what you did)
- (update as you complete each task)

When ALL tasks are done:
- Save a summary to ${chainDir}/impl.md
- Your final message must be exactly: IMPLEMENTATION COMPLETE"`,
  mode: "hands-free",
  handsFree: { autoExitOnQuiet: false },
  reason: "Step 3: Worker (codex)"
})

// Returns sessionId immediately
```

### Auto-Continue Loop

```typescript
const sessionId = startResult.details.sessionId;

while (true) {
  // Query status (rate limiting handles 60s wait automatically)
  const pollResult = interactive_shell({ sessionId, outputLines: 30 });
  const status = pollResult.details.status;
  
  // Check if session exited
  if (status === "exited") {
    break;
  }
  
  // User took over - don't interfere, just keep polling
  if (status === "user-takeover") {
    continue;
  }
  
  const output = pollResult.details.output;
  
  // Check for explicit completion signal
  if (output.includes("IMPLEMENTATION COMPLETE")) {
    interactive_shell({ sessionId, kill: true });
    break;
  }
  
  // Auto-continue if waiting for input
  if (needsContinue(output)) {
    interactive_shell({ sessionId, input: "continue\n" });
  }
}
```

### Continue Detection

Patterns that indicate codex is waiting:

```typescript
function needsContinue(output: string): boolean {
  const lines = output.trim().split('\n');
  const lastLines = lines.slice(-5).join('\n').toLowerCase();
  
  const patterns = [
    /should i (also|continue|proceed)/,
    /do you want me to/,
    /would you like me to/,
    /shall i (proceed|continue)/,
    /want me to (continue|proceed)/,
    /continue\?$/,
    /proceed\?$/,
  ];
  
  return patterns.some(p => p.test(lastLines));
}
```

### Alternative: Yes-Mode

Some agents support auto-approval flags:

```bash
# Codex with full auto-approval (if supported)
codex --full-auto "prompt"

# Aider with yes-always
aider --yes-always "prompt"
```

Check the agent's CLI options for auto-approval modes that eliminate the need for manual continues.

## Step 4: Reviewer (Validate + Fix)

Validates the worker's implementation and fixes any issues found.

```typescript
interactive_shell({
  command: `pi --model claude-sonnet-4-5 "Review and fix the implementation:

1. Read the original context: ${chainDir}/context.md (user intent + codebase analysis)
2. Read the plan: ${chainDir}/plan.md
3. Read the progress log: ${chainDir}/progress.md  
4. Read the implementation summary: ${chainDir}/impl.md
5. Examine the actual code changes

Validate:
- All planned tasks were completed
- Code quality meets standards
- No obvious bugs or issues
- Tests are adequate

If you find issues, FIX THEM directly. Don't just report - make the code right.

APPEND to ${chainDir}/progress.md with your final section:

## Reviewer - Validation & Fixes
**Status: PASS** (or FAIL if critical issues remain)

Validated:
- [x] All planned tasks completed
- [x] Code quality verified  
- [x] Tests passing
- [x] No security issues

Issues Fixed:
- (list any issues you found and fixed, or 'None')

Files Modified by Reviewer:
- (list files you changed, or 'None')

---
**Chain Complete** | scout → planner → worker → reviewer
Total files modified: X
Notes: (anything the main agent should know)"`,
  mode: "hands-free",
  reason: "Step 4: Reviewer (pi)"
})
```

**Completion**: Poll until `status: "exited"`. Reviewer validates, fixes issues, appends final status to progress.md.

## Status Values

| Status | Meaning | Action |
|--------|---------|--------|
| `running` | Agent still working | Wait, check for continue patterns |
| `exited` | Agent finished | Move to next step |
| `user-takeover` | User started typing | Wait for user to finish |
| `killed` | Session terminated | Chain interrupted |
| `backgrounded` | User moved to background | Session continues invisibly |

## Complete Chain Example

```typescript
async function runForegroundChain(task: string) {
  const runId = Date.now().toString(36);
  const chainDir = `/tmp/pi-chain-runs/${runId}`;
  
  // Setup
  bash({ command: `mkdir -p ${chainDir}` });
  
  // Step 1: Scout - gather code into context.md with structured format
  // (See Step 1 section above for full context.md format: User Intent, Files Retrieved, Key Code, Architecture, Planning Guidance)
  let session = interactive_shell({
    command: `agent "Scout for: ${task}. Gather relevant code into ${chainDir}/context.md (format: User Intent, Files Retrieved, Key Code, Architecture, Planning Guidance). CREATE ${chainDir}/progress.md with ## Scout section."`,
    mode: "hands-free",
    reason: "Step 1: Scout"
  });
  await pollUntilExited(session.details.sessionId);
  
  // Step 2: Planner
  session = interactive_shell({
    command: `pi --model claude-sonnet-4-5 "Read ${chainDir}/context.md. Create plan for: ${task}. Save to ${chainDir}/plan.md. APPEND ## Planner section to ${chainDir}/progress.md."`,
    mode: "hands-free",
    reason: "Step 2: Planner"
  });
  await pollUntilExited(session.details.sessionId);
  
  // Step 3: Worker (with auto-continue)
  session = interactive_shell({
    command: `codex "Read ${chainDir}/plan.md. Implement ALL tasks. APPEND ## Worker section to ${chainDir}/progress.md as you complete tasks. Save summary to ${chainDir}/impl.md. End with: IMPLEMENTATION COMPLETE"`,
    mode: "hands-free",
    handsFree: { autoExitOnQuiet: false },
    reason: "Step 3: Worker"
  });
  await pollWithAutoContinue(session.details.sessionId, "IMPLEMENTATION COMPLETE");
  
  // Step 4: Reviewer (validate + fix)
  session = interactive_shell({
    command: `pi --model claude-sonnet-4-5 "Review and fix: Read ${chainDir}/context.md (user intent), ${chainDir}/plan.md, ${chainDir}/progress.md, ${chainDir}/impl.md. Validate implementation matches intent, fix issues. APPEND ## Reviewer section with status and **Chain Complete** to ${chainDir}/progress.md."`,
    mode: "hands-free",
    reason: "Step 4: Reviewer"
  });
  await pollUntilExited(session.details.sessionId);
  
  // Read progress.md - contains complete chain history
  const progress = read(`${chainDir}/progress.md`);
  
  // Parse status from reviewer section
  const passed = progress.includes("Status: PASS");
  
  // Output chain completion summary
  console.log(`
✅ Chain completed: scout → planner → worker → reviewer (4 steps)

📋 Progress: ${chainDir}/progress.md
📁 Artifacts: ${chainDir}/
  `);
  
  return { chainDir, progress, passed };
}

async function pollUntilExited(sessionId: string) {
  while (true) {
    const result = interactive_shell({ sessionId });
    if (result.details.status === "exited") break;
    // Rate limiting handles the wait
  }
}

async function pollWithAutoContinue(sessionId: string, completionSignal: string) {
  while (true) {
    const result = interactive_shell({ sessionId, outputLines: 30 });
    const status = result.details.status;
    
    // Session ended
    if (status === "exited") break;
    
    // User took over - don't interfere, just wait
    if (status === "user-takeover") continue;
    
    const output = result.details.output;
    
    // Check for explicit completion signal
    if (output.includes(completionSignal)) {
      interactive_shell({ sessionId, kill: true });
      break;
    }
    
    // Auto-continue if waiting for input (only when running, not user-takeover)
    if (needsContinue(output)) {
      interactive_shell({ sessionId, input: "continue\n" });
    }
  }
}

// See "Continue Detection" section above for needsContinue() implementation
```

## Tips

**progress.md is the chain result**: After the chain completes, read `progress.md` for the complete story - every agent's section, final status, issues fixed. It's the single source of truth.

**Handoff files are for agents**: context.md, plan.md, impl.md exist for structured agent-to-agent communication. The main agent reads progress.md.

**File-based handoff is reliable**: Terminal output can be truncated. Always have agents write to chain_dir files.

**Explicit completion signals**: Tell agents to output a specific phrase when truly done (e.g., "IMPLEMENTATION COMPLETE").

**User takeover**: If status becomes `user-takeover`, the user started typing. Wait for them to finish - don't try to send input.

**Cleanup**: Chain directories in `/tmp/` persist until OS cleanup. Remove manually when done: `rm -rf /tmp/pi-chain-runs/{runId}`

**Model selection**: Adjust models based on task complexity. Use faster models for simple steps, more capable models for complex reasoning.

## Customization

### Different Agent Combinations

```typescript
// Research-heavy chain
const agents = {
  scout: 'gemini --model gemini-2.5-pro "..."',      // Good at synthesis
  planner: 'claude "..."',                       // Strong reasoning
  worker: 'codex "..."',                         // Fast implementation
  reviewer: 'pi --model claude-opus-4-5 "..."',       // Thorough review
};

// Speed-optimized chain
const agents = {
  scout: 'agent "..."',            // Fast scanning
  planner: 'pi --model claude-haiku-4-5 "..."',           // Quick planning
  worker: 'codex "..."',                         // Fast implementation
  reviewer: 'pi --model claude-haiku-4-5 "..."',          // Quick review
};
```

### Adding Steps

Insert additional steps as needed:

```typescript
// Add a "tester" step after review to verify everything works
interactive_shell({
  command: `pi "Run the test suite. Verify all tests pass. If any fail, investigate and report to ${chainDir}/test-results.md. APPEND ## Tester section with results to ${chainDir}/progress.md."`,
  mode: "hands-free",
  reason: "Step 5: Tester"
});

// Add a "documenter" step to update docs
interactive_shell({
  command: `pi "Read ${chainDir}/progress.md. Update README and any relevant documentation to reflect the changes. Save summary to ${chainDir}/docs-updated.md. APPEND ## Documenter section to ${chainDir}/progress.md."`,
  mode: "hands-free",
  reason: "Step 5: Documenter"
});
```

### Parallel Scouts

Run multiple scouts for different aspects. Create progress.md first to avoid race conditions:

```typescript
// Create progress.md before starting parallel scouts
bash({ command: `echo "# Chain Progress" > ${chainDir}/progress.md` });

// Start both scouts simultaneously - both APPEND (no race condition)
const scout1 = interactive_shell({
  command: `agent "Analyze architecture. Save to ${chainDir}/arch.md. APPEND ## Scout 1 - Architecture section to ${chainDir}/progress.md."`,
  mode: "hands-free"
});
const sessionId1 = scout1.details.sessionId;

const scout2 = interactive_shell({
  command: `agent "Analyze test coverage. Save to ${chainDir}/tests.md. APPEND ## Scout 2 - Test Coverage section to ${chainDir}/progress.md."`,
  mode: "hands-free"
});
const sessionId2 = scout2.details.sessionId;

// Poll alternately until both complete (rate limiting applies per-query)
let done1 = false, done2 = false;
while (!done1 || !done2) {
  if (!done1) {
    const r1 = interactive_shell({ sessionId: sessionId1 });
    if (r1.details.status === "exited") done1 = true;
  }
  if (!done2) {
    const r2 = interactive_shell({ sessionId: sessionId2 });
    if (r2.details.status === "exited") done2 = true;
  }
}

// Planner reads both files
interactive_shell({
  command: `pi --model claude-sonnet-4-5 "Read ${chainDir}/arch.md and ${chainDir}/tests.md. Create unified plan. Save to ${chainDir}/plan.md. APPEND ## Planner section to ${chainDir}/progress.md."`,
  mode: "hands-free",
  reason: "Step 2: Planner"
});
```
