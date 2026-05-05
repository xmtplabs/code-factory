# Format: `plan.md` (top-level TOC)

The top-level table-of-contents file written by the `decomposer`. Stays compact — phase summaries, status, and the coverage matrix only. The orchestrator and reviewers read this; phase contents live in `phases/NN-*.md`.

```markdown
# <Feature Name> — Plan

> **Source spec:** `docs/plans/<topic>-design.md`
> **Standards:** `./standards.md`
> **Generated:** YYYY-MM-DD

**Goal:** <one sentence from spec summary>

## Phases

| # | Name | File | Tasks | Status |
|---|------|------|-------|--------|
| 1 | <name> | `phases/01-<name>.md` | N | elaborated |
| 2 | <name> | `phases/02-<name>.md` | M | sketch |
| 3 | <name> | `phases/03-<name>.md` | K | sketch |
| ... | ... | ... | ... | ... |
| N | Verification | `phases/NN-verification.md` | V | elaborated |

## Phase Summaries

### Phase 1 — <name>
<one paragraph: what this phase delivers, why it goes first, what subsystem it touches>

### Phase 2 — <name>
<one paragraph>

...

## Requirement Coverage Matrix

| # | EARS Requirement | Phase | Task(s) |
|---|------------------|-------|---------|
| 1 | WHEN X THE SYSTEM SHALL Y | 1 | Task 1.2, 1.4 |
| 2 | THE SYSTEM SHALL NOT Z | 3 | Task 3.1 |
```

## Rules

- Every EARS requirement from the spec must appear in the Coverage Matrix and map to a phase + tentative task numbers (sketches hold task titles, so this works even before phases 2..N-1 are elaborated).
- Every non-Verification phase must list ≥3 tasks, OR carry `**Risk:** high — solo phase justified` next to its name with a one-line reason.
- The `Status` column is one of `elaborated` or `sketch`. Phase 1 and Verification are always `elaborated` at decomposition time; phases 2..N-1 are `sketch` until the `phase-elaborator` runs.
