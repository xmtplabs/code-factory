---
name: execute-dynamic-workflow
description: Use when delivering a code change autonomously as a PR via a dynamic multi-agent workflow — from a full approved design spec down to a small well-scoped feature. Provides the workflow shape (plan, worktree-parallel implementation, adversarial review, phase-boundary verification) plus tested example scripts to run directly or copy for custom workflows.
---

# Execute Dynamic Workflow

Deliver code changes as PRs through dynamic workflows: expensive models plan, cheap models implement in parallel worktrees, adversarial reviewers attack the diffs, and verification runs at phase boundaries — not per task. This skill teaches the **shape** and ships **tested example scripts**. Run an example as-is when it fits; copy and edit one when the problem is suitably different. Do not re-derive the orchestration from scratch — the examples encode hard-won failure handling.

## The shape

Every workflow here follows the same skeleton, whatever its size:

1. **Plan with an expensive model, once.** A planner (or planner + JIT elaborator for multi-phase work) explores the codebase and produces small, granular plan files: a shared `preface.md` every prompt starts with (byte-identical → prompt-cache friendly), and per-task context so complete that implementers never search or make architectural decisions. Big work adds a human approval gate after planning; small work skips it.
2. **Implement in parallel worktrees.** Every task gets its own git worktree on a short-lived `task/<id>` branch. Waves are bounded only by true dependencies — no file locks, no shared index. Implementers write code and durable behavioral tests but run nothing; the phase boundary is the proof.
3. **Review adversarially, scaled by risk.** Mechanical tasks: no review. Standard: one clean-context adversarial reviewer. High-risk: two, cross-model (Claude + Codex via the `codex-mcp` skill). Reviewers are never reused across tasks and never fix their own findings. Fix cycle 1 continues the implementer's session; cycle 2 dispatches a **fresh** implementer on an escalated tier — a session that failed to fix once tends to repeat its misunderstanding.
4. **Integrate, and clean up in the same step.** An integrator merges task branches into the work branch in dependency order, resolves conflicts (it has both diffs), and removes each worktree + branch as it lands. Worktrees never outlive their task — cleanup is part of integration's contract, not a separate phase someone can skip.
5. **Verify at the boundary.** The full check suite runs once per phase (or once at the end for single-phase work), preceded by the deterministic hygiene gate (below). Failures become a grouped fix queue for parallel fixers. Then PR, CI to green, review-comment triage (fix / reply / escalate, 🤖-prefixed replies).
6. **Never stop to ask.** Anything needing human judgment becomes a flag, surfaced at the end and in the PR body. Blocked ≠ ask; blocked = flag and continue what's unblocked.

## Iron laws (enforced three ways)

**No plan vocabulary in final code** — requirement/EARS ids, phase/task numbers, "per the plan/spec" — anywhere: code, tests, identifiers, comments, commit messages. Enforced by (1) the iron-laws block in every implementer prompt, (2) a named attack item in the adversarial reviewer, and (3) `scripts/scan-plan-vocab.sh`, a deterministic grep gate that must print `clean` before a phase can close. Pass the spec's own id scheme as its third argument.

**No dishonest tests.** Every new test must fail for a realistic bug and survive valid refactors. Mock-echo assertions, bare does-not-throw, file-existence/symbol-name assertions, and tests that reimplement production logic are review findings (doctrine shared with the `audit-tests` skill).

**No scratch artifacts.** One-off verification lives in the plan's `verify` commands, run at the boundary and discarded with it — never committed.

## Worktree lifecycle

- All worktrees live under one sweepable root: `<repoRoot>.worktrees/<taskId>` (sibling of the repo, one `git worktree list` away from auditable).
- **Setup** (per wave, one cheap agent): `git worktree add <path> -b task/<id> <branch>` — self-healing: a path left by a crashed run is force-removed and recreated first.
- **Codex sessions in worktrees**: `cwd` = the worktree, `writable_roots` = the **main** repo's `.git` — see the `codex-mcp` skill; this is verified, and getting `cwd` wrong makes the agent edit the wrong checkout.
- **Teardown at integration** (same agent that merges): after each task branch merges or is discarded → `git worktree remove --force` + `git branch -D`, then `git worktree prune`.
- **Final sweep** (Deliver phase): prune + remove anything left under the root + delete leftover `task/*` branches — the backstop for died agents and killed runs.
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
5. **Flags over questions** after the last human gate.

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
| Treating flags as failure | Flags are the designed output of autonomy — surface all of them verbatim. |
| Writing a custom workflow from a blank page | Copy an example; the failure handling is the hard-won part. |
