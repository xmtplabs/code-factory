---
name: receiving-feedback
description: Use when a GitHub issue receives new comments during autonomous work — decides whether to update the spec and re-decompose, or just make the change inline
---

# Receiving Feedback

Handle new comments that arrive on the issue or PR during `code-factory` Steps 6–8 or after the PR is open. Be selective: only re-run `decomposing-specs` when the change meaningfully alters EARS requirements.

## Classify the comment

**Automated / bot** (CI status, approvability, merge-conflict warnings, etc.) → react with 👍 and stop.

**Trivial change** — renames, wording, typos, narrow bug fixes the reviewer spotted in the diff, added test cases, cleanup, or any behavior tweak that does **not** add/remove/alter an EARS requirement (`WHEN/IF/WHILE/WHERE … SHALL …`):

1. Make the change on the current branch.
2. Run lint + tests; confirm green.
3. Commit and push.
4. Reply to the comment with a short explanation of what changed.
5. Continue where you were.

**Meaningful requirement change** — adds/removes/alters an EARS requirement, new user story, changes data model / API / integration boundaries, or invalidates a completed task:

1. Update `docs/plans/YYYY-MM-DD-issue-${ISSUE_NUMBER}-design.md`.
2. Post the diff (or a concise summary) as a comment on the issue.
3. Re-run `decomposing-specs` to regenerate the plan directory. The `decomposer` will rewrite `plan.md`, `standards.md`, and phase files. Already-completed phases stay on disk; the new plan should preserve their structure where the requirements still hold.
4. Resume `executing-plans` from the earliest affected phase. If a downstream phase was a sketch, the `phase-elaborator` will pick up the new requirements when its turn comes — no manual rework needed for sketched phases.

**Won't fix** — suggestion is impossible, incorrect, or conflicts with the spec's intent:

- Reply at the source (issue, PR, or review thread) explaining why. Do not push code.

## Rules

- **Decision test**: "Does this add/remove/alter an EARS requirement or invalidate a completed task?" No → trivial. Yes → meaningful. When uncertain, default to trivial and note the call in the commit message.
- **Never block**: don't wait for a reply before continuing. Acknowledge and proceed.
