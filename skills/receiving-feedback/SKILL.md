---
name: receiving-feedback
description: Use when a GitHub issue receives new comments during autonomous work — decides whether to update the spec and re-decompose, or just make the change inline
---

# Receiving Feedback

Handle new issue comments that arrive while the `code-factory` workflow is in progress (or after its PR is open). Be selective: only re-run `decomposing-specs` when the change meaningfully alters EARS requirements.

## When to Use

- A new comment lands on the issue during Steps 6–8 of `code-factory` (decompose, execute, push & PR) or after the PR is open.
- The comment comes from a trusted contributor (filtering of outside contributors is already handled by `read-issue.sh`).
- The comment contains direction, correction, clarification, or new requirements.

Do not invoke this skill for cosmetic reactions, "thanks", or comments that don't ask for a change.

## Process

### 1. Classify the change

**Trivial / non-spec change** — implement directly, do **not** touch spec or task list:

- Renames, wording, formatting, log-message wording, typo fixes
- A bug the reviewer noticed in the diff ("this branch is wrong")
- Adjusting a variable name, file location, or function signature without changing behavior
- Adding a narrow test case for existing behavior
- Code cleanup that does not change behavior
- Any behavior tweak that doesn't add, remove, or change an existing EARS requirement ("WHEN/IF/WHILE/WHERE … THE SYSTEM SHALL …")

Action: make the code change on the current branch, commit, push. Optionally reply on the issue acknowledging. Continue where you were.

**Meaningful requirement change** — update artifacts and re-decompose:

- Adds, removes, or changes an EARS requirement
- Introduces a new user story or acceptance criterion
- Changes data model, API surface, or integration boundaries
- Invalidates a task that has already been completed (e.g., a different approach is now required)
- Expands scope beyond the current spec

Action:

1. Update the design spec file (`docs/plans/YYYY-MM-DD-issue-${ISSUE_NUMBER}-design.md`) to reflect the new requirement.
2. Post the updated spec (or a concise diff of what changed) as a comment on the issue.
3. Re-run `decomposing-specs` to regenerate the task list.
4. Resume `executing-plans` from the earliest phase affected by the change. Preserve prior work that is still valid — don't redo completed tasks that remain correct under the new requirements.

**Won't fix** - reply to the comment and do not push code

- Suggestion is impossible to implement or would break the code
- Concern or suggestion is incorrect. Commenter may be incorrectly reading the code.
- Serious conflicts with the intention of the spec

Action:

1. Craft a response to the comment that explains why the issue should not be fixed or the concern is invalid.
2. Reply to the comment at its source (could be the issue, the PR, or a review comment thread)

### 2. Decision rule

Ask: "Does this change add, remove, or alter any EARS requirement — or invalidate a completed task?"

- **No** → trivial change path. Just do it.
- **Yes** → meaningful change path. Update spec, re-decompose, resume execution.

When uncertain, default to the trivial path and note the judgment call in the commit message. Over-churning the spec is as bad as under-updating it.

### 3. Never block

Do not wait for a reply before continuing. Post a brief acknowledgement on the issue (or as a reply to the review comment) if the change is non-trivial, then proceed.

## Output

- Updated code on the branch (if needed)
- Updated design spec + task list + acknowledgement comment (only on the meaningful-change path)
- A short summary to the caller indicating which path was taken and what was changed
