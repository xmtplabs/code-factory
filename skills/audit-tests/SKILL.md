---
name: audit-tests
description: Audit repository test suites for low-value, brittle, duplicative, or AI-generated tests. Use when Codex needs to review tests across a single project or monorepo, identify tests to delete or merge, upgrade weak tests, consolidate repeated setup into helpers, or produce a precise test quality cleanup plan.
---

# Audit Tests

Review all tests in a repository and identify tests that should be kept, deleted, merged, upgraded, or refactored to use shared helpers.

This skill is language-agnostic. Adapt test discovery, module boundaries, and verification commands to the repository's existing conventions.

## Core Principle

Prefer tests that protect real behavior. Remove or change tests that mainly protect implementation shape, generated text, incidental structure, or current coding choices.

A low-quality test is unlikely to catch a real bug but likely to break during valid changes.

## Workflow

1. Inspect repository structure.
   - Identify language ecosystems, package boundaries, test frameworks, and test commands.
   - In monorepos, define modules by package/workspace/app/library ownership.
   - In single projects, define modules by major source or test directories.
   - Use repository-native metadata where possible: workspaces, package manifests, build files, project files, test config, or CI config.

2. Dispatch explorer subagents by module.
   - Give each explorer one module or bounded test area.
   - Ask explorers to inspect tests and return structured findings only.
   - Do not ask explorers to edit files.
   - If the repository is small, use one explorer for all tests.

3. Build a test inventory.
   - Include test file, test name, behavior under test, inputs and states, assertions, setup, mocks/helpers, and related production code.
   - Note duplicate or overlapping behavior across files and modules.
   - Distinguish unit, integration, end-to-end, contract, snapshot, policy, smoke, and regression tests when the distinction matters.

4. Grade each test.
   - Evaluate behavior value, bug signal, brittleness, uniqueness, setup quality, flakiness risk, runtime cost, and maintenance burden.
   - Assign one action: `keep`, `delete`, `merge`, `upgrade`, `helperize`, or `investigate`.

5. Review across modules.
   - Deduplicate tests that cover the same behavior and inputs.
   - Prefer one clear behavior-level test over several narrow implementation-detail tests.
   - Preserve coverage for important states, edge cases, regressions, contracts, security boundaries, and business requirements.

6. Propose a precise cleanup plan.
   - List tests recommended for deletion with rationale.
   - List tests to merge and identify the surviving test.
   - List tests to upgrade and the behavior/assertion change needed.
   - List repeated setup that should become shared helpers.
   - Include verification commands to run after cleanup.

7. Edit only after user approval unless the user explicitly asked for implementation.
   - Delete tests that add little or no incremental value.
   - Merge duplicate tests into the clearest surviving behavior-level case.
   - Refactor repeated setup only when it reduces real maintenance burden.
   - Avoid broad unrelated test rewrites.

## Explorer Prompt Template

Use this shape when dispatching module explorers:

```text
Audit tests in <module/path>. Do not edit files.

Return a structured report with:
- Test files inspected
- For each test case:
  - file and test name
  - exact behavior it claims to evaluate
  - inputs, states, and edge cases covered
  - assertions made
  - setup steps required
  - mocks, fixtures, factories, or helpers used
  - production behavior or requirement protected
  - likely bug this test would catch
  - brittleness risks
  - duplicate/overlap candidates within this module
  - recommended action: keep, delete, merge, upgrade, helperize, or investigate
  - concise rationale
- Repeated setup patterns that should become helpers
- Any tests that look AI-generated, implementation-coupled, or policy-style
```

## Grading Rubric

Score each dimension from 1 to 5 when useful.

- `bug_signal`: Would the test fail for a plausible real defect?
- `behavior_focus`: Does it test public behavior, user-visible behavior, API contracts, or business rules?
- `change_resilience`: Would valid refactors, renames, formatting changes, or dependency updates leave it passing?
- `uniqueness`: Does it add coverage not already provided elsewhere?
- `setup_quality`: Is setup minimal, readable, and helperized when complex?
- `cost_stability`: Is it fast, deterministic, isolated, and unlikely to flake?
- `requirement_trace`: Can it be tied to a product requirement, API contract, safety invariant, regression, or repo policy?

Guidance:

- Delete when bug signal and uniqueness are low, especially if brittleness is high.
- Merge when multiple tests cover the same behavior and input conditions.
- Upgrade when the intent is valuable but the assertions or setup are brittle.
- Helperize when repeated setup obscures test intent or makes updates expensive.
- Keep tests that protect important behavior even if they need minor cleanup.
- Mark `investigate` when a test may encode historical context that is not visible from the code.

## Low-Quality Test Patterns

Treat these as deletion or upgrade candidates unless there is a strong repo-specific reason:

- Tests that inspect source text, function bodies, private names, or implementation branches.
- Tests that assert generated schema shape without checking consumer-visible behavior or documented contract requirements.
- Tests that enforce dependency, version, style, or repository policy better handled by package manager config, lint, CI policy, or lockfiles.
- Snapshot tests covering broad incidental output with unclear behavioral intent.
- Tests that only assert mocks were called without validating meaningful outcomes.
- Tests that duplicate another test with the same setup, input, and assertion.
- Tests whose main value is preserving current file structure, names, ordering, or formatting.
- Tests with excessive setup for a trivial assertion.
- Tests that require frequent updates during valid product or implementation changes.
- Tests that pass because they reimplement the same logic as production code.
- Tests with broad "does not throw" assertions and no meaningful state or output validation.

## High-Value Test Patterns

Prefer keeping or strengthening tests that:

- Validate business rules, API contracts, user-visible behavior, persistence behavior, security boundaries, or important regressions.
- Cover failure modes, edge cases, permissions, invalid input, concurrency, recovery, or state transitions.
- Mock irrelevant dependencies while exercising the behavior under test.
- Use helpers/factories to make complex setup readable.
- Would catch a realistic bug without breaking on harmless refactors.
- Encode an explicit repo policy that is not reliably enforced elsewhere.

## Cleanup Plan Format

Present recommendations grouped by action:

```text
Delete:
- path/to/test.ext :: "test name"
  Reason: <why low value or brittle>
  Coverage impact: <why safe / what still covers it>

Merge:
- Remove <duplicate test>; keep or expand <surviving test>
  Shared behavior: <behavior and inputs>

Upgrade:
- path/to/test.ext :: "test name"
  Current issue: <weakness>
  Proposed assertion/setup: <change>

Helperize:
- Repeated setup: <description>
  Used by: <files/tests>
  Proposed helper: <name/location>

Keep:
- Notable valuable tests worth preserving

Investigate:
- Tests whose value depends on missing product, policy, or historical context
```

## Verification

After approved edits:

- Run the narrowest relevant test command first.
- Run broader package or repo checks when deletion or merge affects shared behavior.
- Report any commands that could not be run.
- Summarize removed tests, preserved coverage, and remaining risks.
