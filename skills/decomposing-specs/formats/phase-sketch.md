# Format: phase sketch

Used for phases 2..N-1 at decomposition time. The `phase-elaborator` will overwrite the sketch with a full phase file when its turn comes (against the post-prior-phase codebase, not what the decomposer imagined upfront).

```markdown
# Phase K — <name> *(SKETCH — elaborate before execution)*

**Goal:** <one paragraph: what this phase delivers, what files it likely touches, EARS requirements addressed>

**EARS coverage:** REQ-N, REQ-M

**Anticipated files:**
- Create: `src/<area>/<file>.ts`
- Modify: `src/<other>/<file>.ts`

**Tasks (titles only):**
1. <Title> — <one sentence: what this slice does>
2. <Title> — <one sentence>
3. <Title> — <one sentence>

> This phase is a sketch. Before execution, the `phase-elaborator` will:
> 1. Re-read the codebase as it stands after preceding phases land
> 2. Write the full TDD cycles, codebase context references (citing standards.md), and key interfaces for each task
> 3. Self-check structural rules
```

## Rules

- Aim for under 300 words.
- Do **not** pre-write TDD cycles, pattern citations, or detailed codebase context — the codebase will look different after Phase 1 lands.
- Every non-Verification sketch must list ≥3 task titles, OR carry `**Risk:** high — solo phase justified` with reason.
- Every EARS requirement assigned to this phase must appear in `EARS coverage:` (also reflected in `plan.md`'s coverage matrix).
- Anticipated files are best-effort hints — drift between sketch and elaboration is expected and acceptable. The elaborator reports drift back to the orchestrator.
