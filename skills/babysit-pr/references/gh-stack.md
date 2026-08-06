# GitHub stacked PRs (gh stack) backend

Detection: `gh stack view --json` succeeds (requires the `github/gh-stack` extension and stacks enabled on the repo).

## Non-interactive musts

Every command must be prompt-proof — a prompt hangs the loop forever:

- **Always `--json` with `view`** — without it, a TUI opens. Parse with jq.
- **Always `--auto` with `submit`** — without it, it prompts per new PR.
- **Always pass explicit branch/PR arguments** to `checkout` — bare `checkout` opens a picker.
- If `gh stack checkout <pr>` hits a local/remote stack divergence prompt: `gh stack unstack --local` first (keeps the GitHub stack intact), then retry.
- Multiple remotes: set `git config remote.pushDefault origin` up front.

## Stack model

```bash
gh stack view --json   # trunk, currentBranch, branches[] bottom→top
```

Per branch: `name`, `head`, `isMerged`, `needsRebase`, `pr.{number,url,state}`. Branches without a `pr` field have no PR — skip them in the snapshot.

## The fix cycle (per branch with issues, bottom → top)

```bash
gh stack checkout <branch>    # local branch name — safe, no network prompt
# ...fix, verify locally...
git add <specific files>
git commit -m "<fix description>"     # plain git — new commit, no amend
gh stack rebase --upstack     # replay everything above onto the new tip
```

After all branches are fixed, push the whole stack **once**:

```bash
gh stack submit --auto        # pushes all branches, syncs PRs
```

## Rules

- Rebase conflicts exit with **code 3**: parse stderr for conflicted paths, resolve markers, `git add <files>`, then `gh stack rebase --continue`. `gh stack rebase --abort` restores every branch if unresolvable — abort and report rather than leaving a half-rebased stack.
- After `rebase --upstack`, re-check all higher PRs from scratch — the rebase can introduce new failures upstack.
- If the base branch moved (merged PRs below), `gh stack sync` handles fetch + cascade rebase + push in one command — but it aborts (successfully, with `ℹ Sync aborted`) on local/remote stack divergence in non-interactive mode; treat that as an escalation, not a retry loop.
- Exit codes worth branching on: 3 = rebase conflict (resolve + continue), 6 = branch in multiple stacks (checkout a non-shared branch first), 8 = lock held (wait and retry once), 9 = stacks not enabled on the repo (fall back to standalone handling per PR).
