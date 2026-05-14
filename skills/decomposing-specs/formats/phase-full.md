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

**Verification cycles** *(use red/green TDD for behavior-bearing code; use direct verification for mechanical artifact work)*

- [ ] **Cycle A** *(satisfies REQ-N)* — <behavior name, in plain language for the plan reader>

  Verification mode: `tdd`

  Test durability: `durable`
  Retention reason: <the long-lived user-visible or externally observable behavior this test protects>

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

- [ ] **Cycle B** *(satisfies REQ-P)* — <mechanical artifact change, in plain language for the plan reader>

  Verification mode: `direct`

  Direct verification:
  - Create or update `docs/path/file.md`
  - Verify with `test -f docs/path/file.md`
  - Inspect with `sed -n '1,80p' docs/path/file.md` and confirm it contains <specific required content>

- [ ] **Cycle C** *(satisfies REQ-Q)* — <temporary scaffolding behavior>

  Verification mode: `tdd`

  Test durability: `ephemeral`
  Retention reason: <temporary scaffolding needed to drive the implementation; remove or replace with durable behavioral coverage before final validation>

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

*(Add Cycle D, E, ... as needed. TDD cycles must be fully expanded with the same sub-steps. Direct verification cycles must include concrete post-change commands or inspection steps. If a failing test would only prove that a file, symbol, or line does not exist before work begins, use direct verification instead.)*

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

- **Choose the lightest verification mode that still protects behavior.** Use `Verification mode: tdd` for behavior-bearing code changes: validation, branching logic, state changes, API contracts, data transformations, error handling, permissions, persistence, and user-visible workflows. Use `Verification mode: direct` for mechanical artifact changes where red/green testing would only prove setup state: writing markdown, updating static documentation, adding generated config, moving files, renaming symbols, or formatting-only changes.
- **Do not invent low-value failing tests.** If the only failing test would assert that a target file, symbol, or line does not exist before work begins, use direct verification instead.
- **Every TDD cycle is fully expanded** with all sub-steps (test name in plain English, complete failing test code, specific verify-fails command + expected message, plain-language implementation directive, verify-passes command). No `...`, no "same shape," no "as above." If you have N TDD cycles, write N fully-expanded blocks.
- **Every TDD cycle declares test durability.** Use `durable` only when the test should remain in the repository because it validates user-visible, externally observable, or public-contract behavior. Use `ephemeral` for scaffolding tests that only help red/green development, such as tests that assert a file exists, an internal symbol has a particular name, a helper was called, or a wiring detail is temporarily present. Every TDD cycle must include a retention reason. Direct verification cycles do not need test durability metadata because they do not create tests.
- **Every direct verification cycle has concrete verification.** Include exact commands or inspection steps that prove the requested artifact change was made. Do not use placeholders like "verify manually."
- **Implementation-detail tests must be ephemeral.** If a test primarily asserts file presence, variable names, internal method calls, helper existence, module structure, or other implementation details, mark it `ephemeral` and write a cleanup expectation in the retention reason. Do not mark such tests durable.
- **No plan vocabulary in code.** Test names, `describe(…)` strings, identifiers, code comments, and commit messages must be written as if the plan didn't exist. Cycle labels (A/B/C), phase numbers, and EARS IDs (REQ-N, E-PROV-2, etc.) belong outside the code blocks — alongside the cycle in the plan, not embedded in test strings or comments. The implementer copies the test code verbatim, so anything in the code block ships to the repo.
- The cycle label and EARS ref appear once on the cycle's bullet line (`**Cycle A** *(satisfies REQ-N)* — <plain behavior name>`). Do not repeat them inside the test code, the implement directive, or the commit message example.
- Tasks cite standards.md and list only **deltas** — don't duplicate its contents.
- Every task includes a Reuse-first justification (either "no new helpers" or named + justified).
- Every TDD verify command names a specific file and ideally a test name. Generic `npm test` fails the plan-reviewer's verification enforcement check.
