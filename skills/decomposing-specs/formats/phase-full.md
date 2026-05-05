# Format: full (elaborated) phase file

Used for Phase 1, Verification, and any phase fleshed out by the `phase-elaborator`. Tasks cite `../standards.md` for shared codebase context and only call out **deltas**.

## Critical: plan vocabulary stays in the plan

The labels "Cycle A / Cycle B", phase numbers, EARS requirement IDs (`REQ-N`, `E-PROV-2`, etc.), and any other plan-document organizational vocabulary are tools for **the plan document only**. They MUST NOT appear in the code the implementer writes — not in test names, not in `describe(…)` strings, not in identifiers, not in code comments, not in commit messages. The plan author is responsible for writing test names, code snippets, and commit examples that read like real code, with no traceability scaffolding bleeding through.

Anti-example (reviewer must reject):
```ts
describe('ProvisionEmailWorkflow — Cycle B: check-existing short-circuit (E-PROV-2)', () => { ... })
```

Correct:
```ts
describe('ProvisionEmailWorkflow: check-existing short-circuit', () => { ... })
```

The EARS reference, cycle label, and phase number live in the plan markdown, alongside the cycle, never inside the test code.

## Format

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

- [ ] **Cycle A** *(satisfies REQ-N)* — <behavior name, in plain language for the plan reader>

  Test name (plain English, no plan vocabulary): `validates non-empty email before submission`

  Failing test:
  ```language
  test('validates non-empty email before submission', () => {
    expect(() => submit({ email: '' })).toThrow(ValidationError);
  });
  ```
  Verify fails: `pnpm test -- tests/path/file.test.ts -t "validates non-empty email"` → FAIL "submit is not defined"
  Implement: <plain-language description of what the implementation must do — "reject empty-string emails with a ValidationError" — without quoting the EARS clause verbatim>
  Verify passes: same command → PASS

- [ ] **Cycle B** *(satisfies REQ-P)* — <behavior name>

  Test name (plain English, no plan vocabulary): `<plain test name>`

  Failing test:
  ```language
  test('<plain test name>', () => {
    expect(...).toBe(...);
  });
  ```
  Verify fails: `pnpm test -- tests/path/file.test.ts -t "<plain test name fragment>"` → FAIL "<expected message>"
  Implement: <plain-language description>
  Verify passes: same command → PASS

*(Add Cycle C, D, ... as needed, each fully expanded with the same sub-steps. If you can't write a fully-expanded cycle, the cycle either belongs in another task or doesn't need to exist.)*

**Constraints:**
- <non-obvious constraints: performance bounds, error handling, compatibility>

- [ ] **Commit(s):** plain-English commit messages — no phase numbers, no cycle labels, no EARS IDs. Example: `git add src/path tests/path && git commit -m "feat: validate non-empty email on submission"` *(not* `"feat: Phase 2 / Cycle B (E-PROV-2): ..."`)*
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

- **Every TDD cycle is fully expanded** with all sub-steps (test name in plain English, complete failing test code, specific verify-fails command + expected message, plain-language implementation directive, verify-passes command). No `...`, no "same shape," no "as above." If you have N cycles, you write N fully-expanded blocks.
- **No plan vocabulary in code.** Test names, `describe(…)` strings, identifiers, code comments, and commit messages must be written as if the plan didn't exist. Cycle labels (A/B/C), phase numbers, and EARS IDs (REQ-N, E-PROV-2, etc.) belong outside the code blocks — alongside the cycle in the plan, not embedded in test strings or comments. The implementer copies the test code verbatim, so anything in the code block ships to the repo.
- The cycle label and EARS ref appear once on the cycle's bullet line (`**Cycle A** *(satisfies REQ-N)* — <plain behavior name>`). Do not repeat them inside the test code, the implement directive, or the commit message example.
- Tasks cite standards.md and list only **deltas** — don't duplicate its contents.
- Every task includes a Reuse-first justification (either "no new helpers" or named + justified).
- Every verify command names a specific file and ideally a test name. Generic `npm test` fails the plan-reviewer's TDD enforcement check.
