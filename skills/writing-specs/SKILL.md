---
name: writing-specs
description: Use when starting any feature, system change, or bugfix that requires architectural decisions — before writing implementation plans or code. Triggers on new projects, multi-component changes, API design, or when the user says "design", "spec", or "architecture".
model: opus
---

# Writing Design Docs

Produce a structured design document that captures what you're building, why, and how you'll verify it works. Output: `docs/plans/YYYY-MM-DD-<topic>-design.md`. This skill produces the artifact and stops.

## Process

```dot
digraph design_doc {
    "Explore codebase & context" [shape=box];
    "Propose 2-3 approaches" [shape=box];
    "User selects approach" [shape=diamond];
    "Draft each section" [shape=box];
    "Write EARS requirements" [shape=box];
    "Present to user for review" [shape=box];
    "User approves?" [shape=diamond];
    "Adversarial spec review" [shape=box];
    "Triage findings" [shape=box];
    "Write to docs/plans/" [shape=box];
    "Done" [shape=doublecircle];

    "Explore codebase & context" -> "Propose 2-3 approaches";
    "Propose 2-3 approaches" -> "User selects approach";
    "User selects approach" -> "Propose 2-3 approaches" [label="none fit"];
    "User selects approach" -> "Draft each section" [label="selected"];
    "Draft each section" -> "Write EARS requirements";
    "Write EARS requirements" -> "Present to user for review";
    "Present to user for review" -> "User approves?";
    "User approves?" -> "Draft each section" [label="revise"];
    "User approves?" -> "Adversarial spec review" [label="yes, not yet reviewed"];
    "User approves?" -> "Write to docs/plans/" [label="yes, already reviewed or small spec"];
    "Adversarial spec review" -> "Triage findings";
    "Triage findings" -> "Draft each section" [label="accepted findings"];
    "Triage findings" -> "Write to docs/plans/" [label="clean"];
    "Write to docs/plans/" -> "Done";
}
```

### Proposing Approaches

Before drafting, explore the solution space. Research the codebase and relevant libraries, then propose 2-3 approaches:

- **Lead with your recommendation** and explain why
- For each approach: architecture summary, pros, cons, effort estimate
- Include at least one simpler/smaller and one more robust/extensible option
- Let the user select before committing to a design direction

## Design Doc Template

Six sections. Scale depth to complexity — see Scaling Guide.

### 1. Summary

2-4 sentences. What and why. A busy engineer should understand the project from this alone.

### 2. Project Goals & Non-Goals

**Goals:** Problem being solved. Invariants that must hold. Be specific — "p99 under 200ms", not "fast".

**Non-Goals:** Reasonable things explicitly out of scope. Not negated goals — things you're choosing not to address.

### 3. Context

- **Catalysts**: GitHub Issues, Slack threads, or other triggers
- **Codebase**: Existing folders, files, and design docs relevant to this work
- **External docs**: URLs for third-party library documentation
- **References**: Blog posts, RFCs, or source materials that informed the design
- **Impact area**: Modules or directories that will be modified
- **Existing behavior at risk**: When modifying existing functionality, list behaviors in the impact area that must continue working unchanged. If unclear what existing behaviors matter, ask the developer.
- **Brownfield gap analysis** *(include when the target repo has existing code in the impact area)*: Enumerate existing modules, interfaces, and tests that the change must interoperate with. For each module:
  - File path and current responsibility
  - Public interfaces (exports, API surface) the new code must conform to or extend
  - Existing tests that cover the module (these become verification anchors in Regression Protection)
  
  This analysis feeds directly into the Regression Protection subsection and the Codebase Context blocks in the task list.

### 4. System Design

- **Architecture overview**: How components fit together. Diagram if helpful.
- **New or modified interfaces**: Class/struct definitions, API boundaries. Shape, not implementation.
- **Key functions**: Important functions with expected behavior. Contracts and invariants.
- **Alternatives considered**: Why rejected approaches didn't make the cut.

### 5. Libraries & Utilities Required

**External dependencies:**

| Package | Version | Purpose |
|---------|---------|---------|
| `name` | `^x.y.z` | Why needed |

**Internal modules:**

| Module | Path | Purpose |
|--------|------|---------|
| `name` | `src/path/` | What it provides |

Write "None" if no dependencies — don't omit the section.

### 6. Testing & Validation

**This is the most important section. It should be the most detailed.**

#### Acceptance Criteria

Use EARS format for every criterion. Each must be testable and unambiguous.

#### Regression Protection

*Include this subsection when the spec modifies existing functionality. Omit for greenfield features.*

When modifying existing behavior, identify requirements that must NOT change:

- **Preserved behaviors:** EARS requirements for existing functionality that must continue working. Write these as THE SYSTEM SHALL CONTINUE TO requirements.
- **Verification anchors:** Existing tests that already cover these behaviors (cite file paths). These tests must remain green throughout implementation.
- **Coverage gaps:** If existing behavior has no test coverage, add requirements to write regression tests BEFORE making changes. These become the first tasks in the implementation plan.

If you are uncertain which existing behaviors must be preserved, ask the developer before proceeding.

#### Edge Cases

Address relevant categories: concurrency/race conditions, dependency failures, error handling/recovery, boundary conditions, security considerations.

#### Verification Commands

Concrete commands to prove correctness. Include linting and formatting checks.

## EARS Quick Reference

| Pattern | Template | Example |
|---------|----------|---------|
| **Ubiquitous** | THE SYSTEM SHALL [behavior] | THE SYSTEM SHALL encrypt all data at rest |
| **Event-driven** | WHEN [event] THE SYSTEM SHALL [behavior] | WHEN a request exceeds the rate limit THE SYSTEM SHALL return HTTP 429 |
| **State-driven** | WHILE [state] THE SYSTEM SHALL [behavior] | WHILE the circuit breaker is open THE SYSTEM SHALL return cached responses |
| **Optional** | WHERE [feature] THE SYSTEM SHALL [behavior] | WHERE verbose logging is enabled THE SYSTEM SHALL log request bodies |
| **Unwanted** | THE SYSTEM SHALL NOT [behavior] | THE SYSTEM SHALL NOT expose internal error details to clients |
| **Complex** | WHEN [a] AND [b] THE SYSTEM SHALL [behavior] | WHEN the queue is full AND the message is high-priority THE SYSTEM SHALL evict the oldest low-priority message |
| **Preserved** | THE SYSTEM SHALL CONTINUE TO [behavior] | THE SYSTEM SHALL CONTINUE TO return HTTP 200 for valid API keys after the rate limiter is added |

**Rules:** Use SHALL, never "should"/"may". Each requirement independently testable. No vague terms — use measurable criteria. Use SHALL CONTINUE TO for regression requirements on modified functionality.

## Clarification Markers

During drafting, identify up to 3 unknowns where you made an assumption. Mark them inline in the spec:

```
[NEEDS CLARIFICATION: <specific question> — assumed: <your best guess>]
```

Each marker records both the question AND the assumption the spec proceeds with.

**Interactive mode (user present):** Present markers one at a time, each with a recommended answer. The user can accept the recommendation, provide their own answer, or defer. Integrate each accepted answer immediately into the spec — don't batch them. Remove all markers from the final written spec after resolution.

**Autonomous mode (coder-task):** Post clarification questions as a GitHub issue comment so the issue author can respond asynchronously. Proceed immediately with decomposition and execution using the assumed answers — do NOT wait for responses. If the user later responds on the issue, coder-task's "Receiving Comments" mechanism handles updating the spec and re-running affected steps.

**Rules:**
- Maximum 3 markers per spec. If you have more than 3 unknowns, the scope is too ambiguous — ask the user to clarify before drafting.
- Each marker must be a specific, answerable question — not "needs more thought."
- Each marker must include the assumed answer.

## Adversarial Spec Review

Once the user approves the draft, run one adversarial review before writing the final artifact — a different model family with a clean context, attacking the spec the way implementation will. Bugs found here cost sentences; the same bugs found during execution cost re-plans.

**When:** automatically for Medium and Large specs (per the Scaling Guide); for Small specs only if the user asks. Run it once per spec — re-run only if triage causes a major rewrite (new approach, new components), not for wording fixes.

**How:** dispatch a Codex session via `mcp__codex__codex` with `sandbox: read-only`, `approval-policy: never`, model `gpt-5.6-sol`, `config: {"model_reasoning_effort": "xhigh"}`, `cwd` set to the repo root. If the Codex MCP is unavailable, fall back to a clean-context `adversarial-reviewer` subagent (Opus, high effort). Either way the reviewer gets **only** the draft spec and repo access — no drafting history, no rationale. The prompt:

```
Adversarially review this design spec. Assume it is flawed; your job is to find how.
Attack, in order:
1. EARS requirements that are untestable, ambiguous, or use unmeasurable terms
2. Goals with no covering requirement; requirements serving no goal
3. Requirements that conflict with each other or with existing behavior in the
   codebase (read the actual files in the impact area)
4. Modified functionality with no CONTINUE-TO regression requirements
5. Infeasibility: designs the current codebase can't support as described
6. Missing edge-case categories: concurrency, dependency failure, error
   recovery, boundaries, security
7. Non-goals hiding work that is actually required for the goals to hold
Report each finding: severity CRITICAL|MAJOR|MINOR, spec section, the specific
defect, and what would go wrong downstream if unfixed. Verdict: PASS or ISSUES.
```

**Triage:** present findings to the user with your recommended disposition for each — *accept & fix* (with proposed edit), *reject* (with reason), or *your call* — the same interaction pattern as clarification markers. Integrate accepted fixes immediately; cap at 2 review cycles, then proceed with remaining findings noted in the spec's Context section. In autonomous mode (coder-task), skip user triage: apply CRITICAL and MAJOR accepted-disposition fixes directly, post the findings summary as a GitHub issue comment, and proceed.

## Scaling Guide

| Section | Small (~150w) | Medium (~400w) | Large (~800w) |
|---------|--------------|----------------|---------------|
| Summary | 2 sentences | 3 sentences | 4 sentences |
| Goals/Non-Goals | 2-3 bullets each | 4-5 bullets each | 6+ with invariants |
| Context | Links only | Links + file list | Links + files + impact |
| System Design | 1 paragraph | Interfaces + functions | Diagram + full API surface |
| Libraries | Table or "None" | Table + rationale | Table + alternatives |
| Testing | 3-5 EARS | 8-12 EARS + edge cases | 15+ EARS + comprehensive edges |

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Testing as afterthought | Use red/green TDD with test cases defined in the spec |
| Vague goals | Add numbers: "reduce p99 from 800ms to 200ms" |
| Missing non-goals | Unstated scope = assumed in scope |
| Implementation as design | Contracts and behavior, not code |
| No context links | Link the catalyst — future readers need the WHY |
| Modifying code with no regression plan | List preserved behaviors, cite existing tests, or require new regression tests first |
| Modifying brownfield code without gap analysis | Enumerate existing modules, interfaces, and tests in the impact area before designing |
| Skipping adversarial review because the user already approved | Approval gates intent; the adversarial pass gates testability and feasibility. Run it for Medium/Large specs. |
| Giving the adversarial reviewer the drafting context | Clean context is the point — it gets the spec and the repo, nothing else |

## Examples

See `examples/` for graduated examples:
- `small-cli-flag.md` — Adding a `--verbose` flag (minimal but complete)
- `medium-api-endpoint.md` — REST API with auth and rate limiting
- `large-event-system.md` — Distributed event pipeline with retry and DLQ
- `bugfix-small-regression.md` — Bugfix spec with 3-section format and CONTINUE TO requirements
- `brownfield-delta-change.md` — Brownfield change with gap analysis and delta requirements
