# Format: full (elaborated) phase file

Used for Phase 1, Verification, and any phase fleshed out by the `phase-elaborator`. Tasks cite `../standards.md` for shared codebase context and only call out **deltas**.

```markdown
# Phase K — <name>

**Goal:** <one paragraph>

**EARS coverage:** REQ-N, REQ-M

**Standards reference:** Tasks cite `../standards.md` for pattern/reuse/conventions/interfaces. Each task only calls out **deltas** from the standards.

## Task K.1: <Short description>

**Files:**
- Create: `exact/path/to/file.ts`
- Modify: `exact/path/to/existing.ts`
- Test: `tests/exact/path/to/test.ts`

**Codebase context (deltas from standards.md):**
- Pattern: <e.g., "standards.md → HTTP handlers, plus the streaming variant in `src/streaming/handler.ts`">
- Reuse: <list any helpers beyond standards.md, or "standards.md only">
- Conventions: <only call out deviations from standards.md>
- Interfaces: <call out new or task-specific interfaces; cite standards.md for shared ones>

**Reuse-first justification:** Either "no new helpers — uses [list]" OR "introduces `newHelper()` because <existing alternative does not handle X>".

**TDD cycles** *(every cycle fully expanded — no shorthand)*

- [ ] **Cycle A — <behavior name>**
  - Write failing test:
    ```language
    test('specific behavior A', () => {
      expect(myFunction(inputA)).toBe(expectedA);
    });
    ```
  - Verify fails: `pnpm test -- tests/path/file.test.ts -t "specific behavior A"` → FAIL "myFunction is not defined"
  - Implement to satisfy: WHEN <condition> THE SYSTEM SHALL <behavior> *(REQ-N)*
  - Verify passes: same command → PASS

- [ ] **Cycle B — <behavior name>** *(omit if single-cycle slice; otherwise fully expand — do not abbreviate)*
  - Write failing test:
    ```language
    test('specific behavior B', () => {
      expect(myFunction(inputB)).toBe(expectedB);
    });
    ```
  - Verify fails: `pnpm test -- tests/path/file.test.ts -t "specific behavior B"` → FAIL "expected X, got Y"
  - Implement to satisfy: WHEN <condition B> THE SYSTEM SHALL <behavior B> *(REQ-P)*
  - Verify passes: same command → PASS

*(Add Cycle C, D, ... as needed, each fully expanded with the same four sub-steps. If you can't write a fully-expanded cycle, the cycle either belongs in another task or doesn't need to exist.)*

**Constraints:**
- <non-obvious constraints: performance bounds, error handling, compatibility>

- [ ] **Commit(s):** one commit per logical cycle, or one squashed commit for the whole slice if cycles are tightly coupled. Example: `git add src/path tests/path && git commit -m "feat: add input validation with error type"`

## Task K.2: ...
```

## Verification phase variant

For the Verification phase file (typically `phases/NN-verification.md`), the tasks are CI-and-acceptance commands rather than TDD cycles. Required content:

- Full test suite invocation (specific command, not generic `npm test`)
- Linter check
- Type checker (if the project uses one)
- Formatter (if the project enforces one)
- Any spec-listed acceptance commands (smoke tests, integration runs, perf benchmarks)

Each command must match the `CI Commands` section of `standards.md` exactly.

## Rules

- **Every TDD cycle is fully expanded** with all four sub-steps (failing test code, expected failure message, implementation requirements with EARS refs, expected pass). No `...`, no "same shape," no "as above." If you have N cycles, you write N fully-expanded blocks.
- Tasks cite standards.md and list only **deltas** — don't duplicate its contents.
- Every task includes a Reuse-first justification (either "no new helpers" or named + justified).
- Every verify command names a specific file and ideally a test name. Generic `npm test` fails the plan-reviewer's TDD enforcement check.
