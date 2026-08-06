---
name: babysit-pr
description: Use when monitoring one PR or a whole stack of PRs until it is ready — fixing CI failures, responding to review comments, resolving merge conflicts, and pushing verified fixes autonomously in a long-running loop. Works with Graphite (gt) stacks, GitHub stacked PRs (gh stack), and standalone branches.
---

# Babysit PR

Monitor a PR — or an entire stack — in a loop: snapshot status, fix the highest-priority issue, verify locally, push once, sleep, repeat, until every PR is ready or you hit a give-up guard. Built for unattended operation: every iteration works from persisted state, one action at a time, with hard limits on retries.

## Hard rules (read first)

- **New commits only.** Never `--amend`, never force-push history you didn't create, in an unattended loop. (Exception: Graphite's `gt modify --commit` and restacks are the stack-native equivalent and are allowed on Graphite stacks.)
- **Never `git add -A` / `git add .`** — stage the files you changed, by name.
- **Never merge the PR**, never `--no-verify`, never disable or skip a failing test to get to green.
- **Only act on checks for the HEAD commit** (`HEAD_SHA` from the snapshot). Stale failures from superseded commits are noise — treat them as PENDING.
- **Every reply starts with "🤖 "** so humans can tell it's the babysitter.
- **Resolve only threads whose issue you actually fixed.** Scope changes and disagreements stay open for the human.
- **Fix bottom-up in stacks.** A fix in a lower branch may cure higher branches after restacking; fixing high first gets overwritten.
- **One push per iteration.** Apply all fixes across the stack locally, then push the whole stack once.

## Backend detection (once, at session start)

```
if [ -f .git/.graphite_repo_config ] || gt ls >/dev/null 2>&1        → GRAPHITE
elif gh stack view --json >/dev/null 2>&1                            → GH-STACK
else                                                                 → STANDALONE
```

Read the matching reference before using backend commands: `references/graphite.md` or `references/gh-stack.md`. Standalone needs no reference — plain `git` + `gh`. The four verbs that differ:

| Verb | Graphite | gh-stack | Standalone |
|---|---|---|---|
| list stack (bottom→top) | `gt ls` | `gh stack view --json` | current branch only |
| switch to branch | `gt checkout <br>` | `gh stack checkout <br>` | `git checkout <br>` |
| commit a fix | `gt modify --commit -m "..."` | `git add <files> && git commit` | `git add <files> && git commit` |
| propagate + push all | `gt restack && gt submit --stack` | `gh stack rebase --upstack && gh stack submit --auto` | `git push` |

## State file (cold-turn memory)

Persist `.git/babysit-pr-state.json` (inside `.git/` so it can never be committed) and update it **every iteration** — a wakeup has no memory of the last one:

```json
{ "iterations": 3, "lastHeadShas": {"<branch>": "<sha>"},
  "fixAttempts": {"<branch>:<check-name>": 2}, "handledComments": ["<id>", "..."] }
```

## Session loop

Each iteration does **exactly one** of the following, chosen by the first match top-down, then updates the state file, prints what it did and the chosen sleep, and sleeps.

1. **Snapshot.** For each branch in the stack (bottom→top) with a PR, run `scripts/check-pr.sh <pr> <repo-dir>` — greppable `KEY=VALUE` output; judgment stays here, parsing stays in the script. With 3+ PRs, fan the snapshots out to parallel subagents. Skip branches without PRs. No PRs anywhere → exit with an error.
2. **Merge conflicts first** (`MERGEABLE=CONFLICTING` anywhere): resolve on the **lowest** conflicted branch — conflicts block CI from meaning anything. Rebase per backend (see reference); resolve markers, verify, commit, propagate up, push once.
3. **CI failures** (`CI=FAIL` on the HEAD commit, lowest affected branch first):
   - **Stale-CI guard:** if the failing run's SHA ≠ current `HEAD_SHA`, treat as PENDING — never dispatch a second fixer for a superseded run.
   - **Give-up guard:** if `fixAttempts[branch:check] ≥ 2` on fresh SHAs, stop fixing that check — report it as needing a human and exclude it from further iterations.
   - Otherwise: dispatch one subagent per failing check to fetch logs (`gh run view <run-id> --log-failed`) and diagnose — CI logs are verbose; isolating them keeps this context clean. Fix at the root cause, run **targeted** local verification (lint/typecheck changed files, run only the tests exercising them — consult the repo's CLAUDE.md/AGENTS.md for scoped commands), commit, increment `fixAttempts`, propagate, push once. Required checks gate readiness; optional-check failures are best-effort.
4. **Review feedback** (unresolved threads, review bodies, conversation comments — fetch all three buckets; reviewers put their most important feedback in top-level review bodies, not inline). Skip anything resolved, authored by the babysitter (🤖), or in `handledComments`. Triage each remaining item:

   | Type | Action |
   |---|---|
   | Real defect | Fix, verify, commit. Reply "🤖 Fixed — <what changed>", resolve thread. |
   | Question / misunderstanding / non-issue | Reply "🤖 <concrete answer citing code>". Leave open. **No code changes.** |
   | Scope change, style preference, architectural ask | Reply "🤖 Flagged for the PR author — outside this babysitter's mandate." Leave open, record for the final report. |

   Subjective or architectural feedback is **never** silently implemented — judge the code, not the confidence of the comment (bots included: CodeRabbit, Copilot, Greptile, Bugbot are frequently out of scope).
5. **All quiet** → check the exit condition; if not met, sleep on the long interval.

**Iteration cap:** stop after 12 iterations regardless (≈ a couple of hours) and report where things stand — an unattended loop that can't converge in 12 rounds needs a human.

## Sleep intervals

| Situation | Sleep |
|---|---|
| Just pushed; CI hasn't picked up the new SHA | 2 min |
| CI running, started < 15 min ago | 3–5 min |
| CI running, long-running suite | 5 min |
| All green, waiting on human reviewers | 10 min |
| No actionable items, PR not fully ready | 5 min |

Across a stack, use the shortest applicable interval. Print `Sleeping {N} min — {reason}` first. In a plain shell loop use `sleep <seconds>`; in Claude Code prefer scheduled wakeups (`/loop` or ScheduleWakeup) over a blocked foreground sleep — same cadence, cheaper.

## Exit condition

Every PR in the stack: all **required** checks passing on HEAD, every review thread resolved-or-answered (🤖 reply is the last word), every review body and conversation comment addressed. Optional-check failures don't block — note them and declare ready. Print: **"All required checks passing and all review comments addressed across the stack. PRs are ready."** Then report anything parked by give-up guards or flagged as needing the author.

## Common mistakes

| Mistake | Fix |
|---|---|
| Fixing a check that failed on a superseded commit | Stale-CI guard: compare run SHA to `HEAD_SHA` first |
| Re-fixing the same check forever | Give-up guard: 2 strikes per check on fresh SHAs, then escalate |
| Replying twice to the same comment | Check `handledComments` and whether the last reply is 🤖 |
| Pushing per-branch during a stack pass | Fix everything locally bottom-up, push once |
| Missing top-level review bodies | Fetch all three comment buckets, not just inline threads |
| Forgetting to propagate after a mid-stack fix | Restack/rebase-upstack before touching the next branch; then re-check higher PRs — the restack itself can break them |
| Implementing a reviewer's architectural suggestion | That's the author's call — reply, flag, leave open |
| Trusting this session's memory of previous iterations | The state file is the memory; read it, update it, every iteration |
| Fetching CI logs into the main context | One subagent per failing check; keep this context for decisions |
