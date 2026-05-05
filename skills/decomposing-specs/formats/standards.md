# Format: `standards.md` (shared codebase context)

A compact reference file the implementer reads once per phase. Tasks cite specific entries from this file rather than repeating its contents.

Aim for under one page. List what tasks will need, not everything in the codebase.

```markdown
# Codebase Standards — <topic>

> Reference doc for all phases. Tasks cite this file rather than repeating its contents.

## Pattern Files (mirror these)

| Area | File | Aspect to copy |
|------|------|----------------|
| HTTP handlers | `src/handlers/foo.ts` | Request/response flow, error shape |
| Validation | `src/validation/zod.ts` | Schema-first parsing |
| ... | ... | ... |

## Reusable Helpers

| Need | Use | Don't reimplement |
|------|-----|-------------------|
| HTTP error formatting | `src/errors/format.ts:formatError()` | Custom error builders |
| Logger | `src/log.ts:logger` | console.log |
| ... | ... | ... |

## Conventions

- Files: `kebab-case.ts`
- Tests: `describe('FooService', ...)`, located alongside source as `*.test.ts`
- Fixtures: `tests/fixtures/<feature>/`
- Imports: external → internal, then relative

## Common Interfaces

- `AppError` — `src/errors.ts`
- `RequestContext` — `src/context.ts`
- ...

## CI Commands

- Test: `pnpm test`
- Lint: `pnpm lint`
- Typecheck: `pnpm typecheck`
- Format: `pnpm format`
```

## Rules

- Every entry must cite a concrete file path + symbol where applicable. Generic entries ("follow existing patterns") fail the plan-reviewer's idiomatic-code check.
- Don't list everything — list what tasks will need.
- The CI Commands section drives the Verification phase and the executor's final CI stage. Match what the project actually uses.
