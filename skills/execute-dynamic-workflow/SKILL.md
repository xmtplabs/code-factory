---
name: execute-dynamic-workflow
description: Use when you have an approved design spec and want it delivered autonomously as a PR with green CI. Runs a single dynamic workflow that plans, elaborates phases just-in-time, implements with difficulty-matched models, adversarially reviews cross-model, verifies at phase boundaries, and drives CI to green. Experimental alternative to decomposing-specs + executing-plans.
---

# Execute Dynamic Workflow

Take a spec from `writing-specs` to an open PR with green CI in **one Workflow invocation**. The workflow has exactly one human checkpoint — plan approval, delivered as a markdown briefing before any code is written. After approval it is fully autonomous: it never stops to ask questions mid-run; anything needing human judgment is accumulated as a flag and surfaced at the end (and in the PR body). On completion, the user gets an HTML walkthrough of the most important changes via `/explain-diff-html`.

Division of labor, by design:

- **Expensive models plan** (planner + per-phase elaborator on high effort) so that **cheap models implement** — implementers get tasks so complete they never search or make architectural decisions, and spend their tokens on tool-call iterations instead.
- **Implementers never run checks.** They write code and tests (tests are written, not run — the red test is the spec, the phase boundary is the proof). Build/test/lint/typecheck run once per phase boundary; failures become a grouped work queue for parallel fixers.
- **Reviews are adversarial and cross-model**, scaled by per-task risk: mechanical → none, standard → one Claude Opus reviewer, high → Opus + Codex independently. CI's specialized reviewers power the outer loop after the PR opens — there is no phase-boundary reviewer suite.
- **Plans are granular files, elaborated one phase ahead.** The planner writes a small plan directory (tiny TOC, shared preface, per-phase sketches). Phase N+1's task files are written *while phase N implements* — after the first tasks start, execution almost never waits on planning. A cheap drift check at each boundary triggers re-elaboration only when review/boundary fixes substantially changed what later phases build on. No agent ever loads a plan dossier.
- **Plan artifacts and throwaway code never reach the repo — enforced at the source.** The elaborator may only specify durable behavioral tests (there is no ephemeral-test concept); all one-off verification lives as `verify` commands in the plan, run once at the boundary and discarded with it. Implementers are forbidden from writing scaffolding tests, scratch code, or plan vocabulary (EARS ids, task/phase references) into code, tests, or commits. A mechanical hygiene scan opens every phase boundary as the deterministic backstop — so reviewers and CI never spend cycles on it.
- **The orchestrator learns across phases.** Every phase boundary ends with a retrospective: the workflow collects that phase's correction signals (review findings, failing check groups, flags), a retro agent distills the systemic ones into binding lessons, standing conventions get codified into `preface.md` ("Learned during execution"), and all lessons are injected into every subsequent implementer, reviewer, elaborator, and fixer prompt. A style mistake made in phase 2 is structurally harder to make in phase 3. Lessons are appended after the stable preface so prompt-cache prefixes survive, and logged to `<planDir>/lessons.md` for humans.
- **Sessions are reused where independence doesn't matter.** Implementer Codex sessions continue across review-fix cycles and chain into dependent tasks touching the same files (context and provider cache carry over); reviewer re-checks after a fix are scoped to the prior findings rather than full re-reviews. Adversarial reviewers are never reused across tasks — a clean context per task is what makes them adversarial.

## Step 1: Inputs and branch strategy

Required: path to an approved design spec (`docs/plans/YYYY-MM-DD-<topic>-design.md`).

Decide the PR strategy with the user — this is the one interactive moment. Each PR gets its own run of this skill (one branch, one workflow). Err toward fewer, larger PRs; each must have a clear scope boundary and be independently mergeable. If splitting, agree on which spec sections/EARS requirements belong to each run and note the split in the workflow's `prTitle` and plan directory name. If the user already stated the strategy, don't re-ask.

## Step 2: Launch the workflow

Invoke the `Workflow` tool with `scriptPath` pointing at `workflow.js` **in this skill's directory** (resolve the absolute path — it ships next to this file) and:

```
args: {
  "specPath":  "docs/plans/YYYY-MM-DD-<topic>-design.md",
  "planDir":   "docs/plans/YYYY-MM-DD-<topic>-plan/",
  "repoRoot":  "<absolute repo root>",
  "baseBranch": "main",
  "branch":    "<topic-branch-name>",
  "prTitle":   "<PR title>"
}
```

The first launch **omits `approved`** — the run plans, writes the approval briefing, and pauses. Do not inline or rewrite the script — pass `scriptPath` so runs are reproducible and resumable. The workflow runs in the background; relay progress from the notification stream and let the user know they can watch `/workflows`.

## Step 3: Plan approval gate

The first run returns `{ outcome: "AWAITING_APPROVAL", approvalDoc, phases, flags }`. `approvalDoc` is a markdown briefing — the high-level plan summary and, per phase, the most important boundary verifications. Read it and present it to the user in chat (it's written to render well as markdown; don't re-summarize it into something thinner), then collect the verdict:

- **Approved** → relaunch: same `scriptPath`, same `args` plus `"approved": true`, and `resumeFromRunId` from the first run. All planning replays from cache; implementation starts immediately.
- **Approved with feedback** → same, plus `"feedback": "<their notes verbatim>"`. The planner applies the feedback to the plan directory before the first phase elaborates.
- **Rejected / major rework** → treat feedback as spec-level: revise the spec (or send the user back to `writing-specs`), then start a fresh run.

## Step 4: Handle the result

The workflow returns `{ outcome, prUrl, phases, flags }`.

- **`PR_OPEN`** (CI confirmed green) — report the PR URL, the per-phase summaries, and every flag verbatim. Flags are the autonomous run's deferred questions: blocked tasks, unresolved review findings, Codex fallbacks. Don't bury them. Then invoke the `explain-diff-html` skill on the branch/PR diff to produce the walkthrough of the most important changes, and open it for the user alongside the PR URL.
- **`PR_OPEN_WITH_FAILURES`** — the PR exists but CI is not confirmed green (see `ciGreen` and per-phase `boundaries` in the result). Report exactly which gates are red/unverified before anything else, then proceed as for PR_OPEN.
- **`NEEDS_CONTEXT`** — the spec was too ambiguous to phase. Get answers from the user, then relaunch with `resumeFromRunId` plus `"clarifications": "<the answers>"` in args — the clarifications are interpolated into the planner's prompt, which invalidates exactly that cached call so planning re-runs with the answers. (Passing answers any other way replays the cached NEEDS_CONTEXT result forever.)
- **`BRANCH_SETUP_FAILED`** — dirty working tree or checkout failure, caught before any tokens were spent on planning. Resolve the git state with the user, then relaunch fresh.
- **`FEEDBACK_FAILED`** — the user's conditional approval feedback could not be applied to the plan. Nothing was implemented. Show the detail, resolve with the user, relaunch with revised feedback.
- **`NO_PR`** — implementation finished but PR creation failed. The branch exists locally/pushed; open the PR manually with `gh`, then report.
- **Killed or died mid-run** — relaunch with the same `scriptPath` + `args` + `resumeFromRunId`; completed agent calls replay from cache and execution continues from the first incomplete step.

## Model map

The model tables live in `workflow.js` (`MODELS`, `REVIEW_TASK_CODEX`, `REVIEW_DEEP_CODEX`). The governing principle: **implementation is never high-complexity work** — expensive models plan ahead of it and review behind it; hard tasks are decomposed until they're average, and subtlety buys more review (`risk: high`), not a bigger implementer.

| Role | Codex (primary) | Anthropic (fallback) |
|------|-----------------|----------------------|
| implement: simple | gpt-5.6-terra, low effort | haiku |
| implement: average | gpt-5.6-terra, medium effort | sonnet |
| per-task adversarial review (risk: standard and high) | — (always Claude) | opus, high effort |
| cross-model 2nd reviewer (risk: high only) | gpt-5.6-sol, high effort | opus, high effort |
| plan review + final sweeps | gpt-5.6-sol, xhigh effort | opus, xhigh effort |
| planner / elaborator (always Claude) | — | opus, xhigh effort |
| boundary hygiene + running checks | — | haiku |
| CI watch (reads bot review comments too) | — | sonnet |

Running verifications is mechanical — execute commands, capture exit codes — so it sits on the cheapest tier. The one piece of judgment there is grouping failures by root cause so parallel fixers don't collide on the same file; that instruction is explicit in the prompt. CI watch stays a tier up because it also interprets bot review comments.

Codex runs with `sandbox: danger-full-access` and `approval-policy: never` via the `codex-runner` agent — full permissions, no prompts. Every Codex call writes a run log (config, full prompt, verbatim final response, conversation id) to `<planDir>/runs/`, and the full inner transcript is in `~/.codex/sessions/` under that conversation id. If the Codex MCP fails twice, the whole run falls back to the Anthropic column and a flag records it. If the user's Codex model names differ, edit `MODELS` before launching.

## Agents this skill relies on

`workflow-planner` (spec → plan directory), `dynamic-elaborator` (phase sketch → per-task files, JIT), `codex-runner` (frozen Codex invocation), `adversarial-reviewer` (clean-context diff attacks). Their contracts live in `agents/`.

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Reading the spec/plan into the main context "to help" | The workflow's agents read from disk. Your job is launch, relay, report. |
| Inlining the script instead of using `scriptPath` | `scriptPath` + `resumeFromRunId` is what makes crashed runs resumable. |
| Re-asking the user about PR strategy they already stated | Ask once, only if genuinely undecided. |
| Passing `approved: true` on the first launch | The approval gate is the point — skip it only when the user explicitly pre-approves the plan sight-unseen. |
| Relaunching after approval without `resumeFromRunId` | Without it, planning re-runs from scratch instead of replaying from cache. |
| Skipping the `/explain-diff-html` walkthrough on PR_OPEN | The walkthrough is part of the deliverable, not an optional extra. |
| Treating flags as failure | Flags are the designed output of autonomy — surface all of them, let the user triage. |
| Relaunching a failed run fresh | Always pass `resumeFromRunId` — completed implementation replays from cache instead of re-running. |
| Pre-elaborating later phases by editing the plan directory mid-run | Elaboration is just-in-time on purpose; earlier phases change what later phases should build. |
| Answering NEEDS_CONTEXT questions anywhere but `args.clarifications` | Only a changed planner prompt invalidates the cached call — spec edits alone replay the stale NEEDS_CONTEXT result. |
