---
name: execute-dynamic-workflow
description: Use when delivering a code change autonomously as a PR via a dynamic multi-agent workflow — from a full approved design spec down to a small well-scoped feature. Provides the workflow shape (plan, worktree-parallel implementation, adversarial review, phase-boundary verification) plus tested example scripts to run directly or copy for custom workflows.
---

# Execute Dynamic Workflow

Deliver code changes as PRs through dynamic workflows: expensive models plan, cheap models implement in parallel worktrees, adversarial reviewers attack the diffs, and verification runs at phase boundaries — not per task. This skill teaches the **shape** and ships **tested example scripts**. Run an example as-is when it fits; copy and edit one when the problem is suitably different. Do not re-derive the orchestration from scratch — the examples encode hard-won failure handling.

## The shape

Every workflow here follows the same skeleton, whatever its size:

1. **Plan with an expensive model, once.** A planner (or planner + JIT elaborator for multi-phase work) explores the codebase and produces small, granular plan files: a shared `preface.md` every prompt starts with (byte-identical → prompt-cache friendly), and per-task context so complete that implementers never search or make architectural decisions. Big work adds a human approval gate after planning; small work skips it. **The elaborator runs the check suite before planning anything** — see "Sizing tasks" below.
2. **Implement in parallel worktrees.** Every task gets its own git worktree on a short-lived `task/<id>` branch. Waves are bounded only by true dependencies — no file locks, no shared index. Implementers write code and durable behavioral tests but run nothing; the phase boundary is the proof.
3. **Review adversarially, scaled by risk.** Mechanical tasks: no review. Standard: one clean-context adversarial reviewer. High-risk: two, cross-model (Claude + Codex via the `codex-mcp` skill). Reviewers are never reused across tasks and never fix their own findings. Fix cycle 1 continues the implementer's session; cycle 2 dispatches a **fresh** implementer on an escalated tier — a session that failed to fix once tends to repeat its misunderstanding. Cycle 3 is the last: after it, **land with a flag unless a CRITICAL survives** (see "Salvage over discard").
4. **Integrate, and clean up in the same step.** An integrator merges task branches into the work branch in dependency order, resolves conflicts (it has both diffs), and removes each worktree as it lands. Worktrees never outlive their task — cleanup is part of integration's contract, not a separate phase someone can skip. Branches are deleted only for tasks that **merged**; unmerged work is renamed, never deleted.
5. **Review the whole phase, not just its tasks.** After integration, one reviewer reads the complete phase diff. Per-task reviewers are structurally blind to what only the aggregate reveals: a caller kept whose callee is gone, a phase that silently didn't happen because every task individually passed or was discarded, generated artifacts now out of sync with the schema that moved. This step catches the failures that end runs.
6. **Verify at the boundary.** The full check suite runs once per phase (or once at the end for single-phase work), preceded by the deterministic hygiene gate (below). Failures become a grouped fix queue for parallel fixers. Then PR, CI to green, review-comment triage (fix / reply / escalate, 🤖-prefixed replies). **Green is not proof** — see "What green checks do not prove."
7. **Never stop to ask.** Anything needing human judgment becomes a flag, surfaced at the end and in the PR body. Blocked ≠ ask; blocked = flag and continue what's unblocked.

## Sizing tasks

**One concern per task, ~100-150 changed lines.** This is not a style preference — it is the single highest-leverage parameter in the whole workflow, because the review loop's terminal failure discards a task whole. A 200-line task bundling a schema rewrite, the behavioral rewrite that consumes it, and its test updates fails review on one bad judgment call and takes the correct 90% with it. Two rounds of that is a phase that produced nothing.

Concretely: split a schema or data-structure change from the behavior that consumes it, and split both from bulk test updates. A task whose title needs "and" to join two unrelated verbs is too big.

**Do not merge tasks to keep footprints disjoint.** Waves need disjoint files, but the fix is a dependency, not a bigger task: give the second task a dep on the first so they land in different waves. "These two touch the same file, so make them one task" is how oversized tasks get created.

**Elaborate against the real tree, not the plan's assumption.** The elaborator's first action is running the check suite and reading every error. Partially-landed work from an earlier phase, a resumed run, or a discarded task routinely leaves the tree red — callers referencing deleted APIs, stale parameter counts, removed result fields. Each of those errors is required work: assign it to a task explicitly, naming file and symbol. A phase that leaves a known error unowned will fail its own boundary check and burn a fix round rediscovering it.

## Salvage over discard

Work that fails review is usually *mostly right*. Throwing it away costs more than landing it with a flag, because the phase boundary check and the whole-phase review both still run behind it.

- After the last fix cycle: land the task and flag the unresolved findings, **unless a CRITICAL survives** — only then discard.
- The integrator deletes branches only for tasks that merged. Unmerged task branches are **renamed `salvage/<id>`**, never `branch -D`'d, so the work is recoverable by hand. Remove the worktree either way.
- Fix prompts say **"fix ONLY what is listed; do not refactor beyond the findings."** Scope creep during a fix cycle is a common cause of failing the *next* review — the second reviewer legitimately objects to changes nobody asked for.

## What green checks do not prove

A phase can pass typecheck, lint, and thousands of tests while shipping a fatal defect. Two failure classes recur:

- **Logic inside strings.** SQL, DSLs, templates, and query builders are opaque to the type system. A malformed `INSERT` missing its `WHERE`, or a `terminal` flag reading a column the query no longer selects (so the comparison is always true), typechecks perfectly and silently breaks production behavior. Instruct the adversarial reviewer to read such statements character by character, and require a regression test that exercises the statement rather than the function around it.
- **Deleted coverage.** When a phase removes behavior, the tests that covered it are removed too — so the suite gets greener as the risk goes up. The whole-phase reviewer must ask which surviving tests still pin the invariants that were *supposed* to hold.

## Deletion campaigns

When the dominant operation is removal rather than addition, invert the reviewer and add a keep-list.

- **Keep-list.** Enumerate the invariants that must survive — the compare-and-swap, the idempotency key, the fence on the serving path — and inject that same block into every implementer prompt *and* every review. Implementers deleting aggressively need it as a guardrail; reviewers need it as an attack checklist.
- **Attack both directions.** *Residue*: orphaned columns, indexes, dead callers, unused imports, tests asserting removed behavior, generated clients out of sync. *Overreach*: load-bearing code cut by accident. Both are real; overreach is the one that ships an outage.
- **Conflict rule for the integrator.** If both sides deleted the same code, it stays deleted. If trunk adds a caller of something the campaign deleted, adapt the caller — never resurrect the machinery.

## Iron laws (enforced three ways)

**No plan vocabulary in final code** — requirement/EARS ids, phase/task numbers, "per the plan/spec" — anywhere: code, tests, identifiers, comments, commit messages. Enforced by (1) the iron-laws block in every implementer prompt, (2) a named attack item in the adversarial reviewer, and (3) `scripts/scan-plan-vocab.sh`, a deterministic grep gate that must print `clean` before a phase can close. Pass the spec's own id scheme as its third argument.

**No dishonest tests.** Every new test must fail for a realistic bug and survive valid refactors. Mock-echo assertions, bare does-not-throw, file-existence/symbol-name assertions, and tests that reimplement production logic are review findings (doctrine shared with the `audit-tests` skill).

**No scratch artifacts.** One-off verification lives in the plan's `verify` commands, run at the boundary and discarded with it — never committed.

## Worktree lifecycle

- All worktrees live under one sweepable root: `<repoRoot>.worktrees/<taskId>` (sibling of the repo, one `git worktree list` away from auditable).
- **Setup** (per wave, one cheap agent): `git worktree add <path> -b task/<id> <branch>` — self-healing: a path left by a crashed run is force-removed and recreated first.
- **Codex sessions in worktrees**: `cwd` = the worktree, `writable_roots` = the **main** repo's `.git` — see the `codex-mcp` skill; this is verified, and getting `cwd` wrong makes the agent edit the wrong checkout.
- **Teardown at integration** (same agent that merges): remove the worktree for every task in the wave → `git worktree remove --force`, then `git worktree prune`. `git branch -D` **only** for branches that merged; rename unmerged ones to `salvage/<id>` (see "Salvage over discard").
- **Sweep before any rebase.** A leftover worktree holds a branch checkout, and git refuses to rebase a branch that is checked out elsewhere. Any phase that rebases or restacks must sweep first, or it fails on its first command.
- **Final sweep** (Deliver phase): prune + remove anything left under the root + delete leftover `task/*` branches — the backstop for died agents and killed runs. Leave `salvage/*` branches alone; they are the recovery record.
- **After a crashed run**: nothing to hand-clean — the next run's setup self-heals and the sweep catches strays; or run `git worktree prune` + remove `<repoRoot>.worktrees` yourself.

## The examples

| Script | Use for | Human gates |
|---|---|---|
| `examples/full-delivery.js` | Approved design spec → phased plan → PR with green CI | Plan approval briefing before implementation |
| `examples/mini-feature.js` | Small well-scoped change, no spec needed | None — task description in, PR out |

**Launching** (both): invoke the `Workflow` tool with `scriptPath` pointing at the example **in this skill's directory** (resolve the absolute path), never inlining the script — `scriptPath` + `resumeFromRunId` is what makes crashed runs resumable. Required args always include `repoRoot` (absolute) and `skillDir` (this skill's absolute directory — the boundary scripts live there). The workflow runs in the background; relay progress and point the user at `/workflows`.

**full-delivery.js** args: `{specPath, planDir, repoRoot, skillDir, baseBranch, branch, prTitle}` (+ `approved`, `feedback`, `clarifications` on relaunch). First launch omits `approved` — the run plans, writes `<planDir>/approval.md`, and pauses with outcome `AWAITING_APPROVAL`. Present the briefing to the user, then relaunch with the same args plus `approved: true` (and `feedback` if conditional) and `resumeFromRunId` — planning replays from cache. Other outcomes: `NEEDS_CONTEXT` (answer via `clarifications` on resume — the only way that invalidates the cached planner call), `PLANNER_FAILED` (run failure, not ambiguity — fix cause, fresh run), `FEEDBACK_FAILED`, `PR_OPEN` / `PR_OPEN_WITH_FAILURES` / `NO_PR`. On PR_OPEN: read `<planDir>/progress.md` and lead with the narrative; report every flag verbatim; then run `/explain-diff-html` on the diff — the walkthrough is part of the deliverable.

**mini-feature.js** args: `{task, repoRoot, skillDir, baseBranch, branch, prTitle}` — `task` is a plain-language description of the change.

**Resuming**: killed/died runs relaunch with the same `scriptPath` + args + `resumeFromRunId`; completed agent calls replay from cache. Exception: a failure caused by bad/missing args needs a **fresh** run — wrong values are baked into the cached prompts, and a resume replays them forever. The tell: the run "completes" in seconds with ~0 subagent tokens. `<planDir>/progress.md` is the recovery ledger — it records per-task done/failed status precisely so a resumed orchestrator (or you) can tell what's actually complete.

## Writing a custom workflow

Copy the closest example and edit. Keep, in this order of importance:

1. The **args guard** (fail in milliseconds on missing/stringified args, not after the planner burned tokens).
2. **Integration-owned worktree cleanup** + the final sweep.
3. The **iron laws + hygiene gate** at every boundary.
4. **Honest failure paths**: dead agents flag as UNVERIFIED, they never silently pass a gate; `filter(Boolean)` every `parallel()` result.
5. **Task sizing + salvage**: one concern per task, and unmerged work renamed rather than deleted. These two decide whether a long run produces anything.
6. **A whole-phase review** between integration and verification.
7. **Flags over questions** after the last human gate.

**Branch-setup agents must verify their parent and stop rather than guess.** Any workflow that creates branches on top of an existing chain — stacked PRs especially — should confirm it is on the expected parent before creating the next branch, and report a mismatch instead of proceeding. Stack tooling silently re-parents onto stale local trunks; a workflow that trusts it builds the whole run on the wrong base.

Codex invocation details (models, efforts, sandbox/config, relay-agent briefing) come from the `codex-mcp` skill — both examples embed its relay template; keep model tables in one place at the top of your script. Agent contracts for the planner, elaborator, and adversarial reviewer live in `agents/` and are dispatched by `agentType` — reuse them rather than re-prompting from scratch.

## Model map

The tables live at the top of each example (`MODELS`, `MODEL_ESCALATED`, `REVIEW_TASK_CODEX`, `REVIEW_DEEP_CODEX`). Governing principle: **implementation is never high-complexity work** — hard tasks are decomposed until they're average, and subtlety buys more review (`risk: high`), not a bigger implementer. Simple → `gpt-5.6-luna`/haiku; average → `gpt-5.6-terra`/sonnet; reviews → `gpt-5.6-sol`/opus; running checks → haiku. If the Codex MCP fails twice, the run falls back to the Anthropic column and a flag records it.

## Common mistakes

| Mistake | Fix |
|---|---|
| Reading the spec/plan into the main context "to help" | The workflow's agents read from disk. Your job is launch, relay, report. |
| Inlining the script instead of `scriptPath` | `scriptPath` + `resumeFromRunId` is what makes runs resumable. |
| Passing `approved: true` on the first full-delivery launch | The approval gate is the point — skip only on explicit pre-approval. |
| Resuming after a bad-args failure | Fresh run — cached prompts already contain the bad values. |
| Omitting `skillDir` | The hygiene gate silently degrades — the boundary scan can't run. |
| Letting a reviewer fix its own findings | Findings go back to an implementer session; reviewers only re-verify. |
| Cleaning worktrees in a separate late phase "for tidiness" | Cleanup belongs to integration; a separate phase runs zero times when the run dies before it. |
| Bundling a schema change, its consumers, and its tests into one task | One concern per task, ~100-150 lines. Oversized tasks are discarded whole when review fails. |
| Merging two tasks because they touch the same file | Give the second a dep so they land in different waves. |
| `git branch -D` on a task that failed review | Rename to `salvage/<id>`. Failed ≠ worthless; most of it is usually right. |
| Treating a green suite as proof the phase is safe | Typecheck cannot see into SQL/template strings, and deleted behavior takes its tests with it. |
| Elaborating a phase without running the checks first | A red tree from earlier work leaves errors unowned, and the boundary check rediscovers them the expensive way. |
| Treating flags as failure | Flags are the designed output of autonomy — surface all of them verbatim. |
| Writing a custom workflow from a blank page | Copy an example; the failure handling is the hard-won part. |
