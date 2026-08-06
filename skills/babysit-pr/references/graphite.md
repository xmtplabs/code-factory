# Graphite (gt) backend

Detection: `.git/.graphite_repo_config` exists, or `gt ls` succeeds.

## Stack model

`gt ls` prints the stack; parse bottom (closest to trunk) → top. A standalone branch is a one-branch stack — the same flow applies.

## The fix cycle (per branch with issues, bottom → top)

```bash
gt checkout <branch>          # switch to the branch that owns the fix
# ...fix, verify locally...
git add <specific files>
gt modify --commit -m "<fix description>"   # commit onto this branch
gt restack                    # rebase everything above onto the new tip
```

After all branches are fixed, push the entire stack **once**:

```bash
gt submit --stack
```

## Rules

- `gt modify --commit` + `gt restack` is the stack-native amend path — allowed here even though the generic hard rule says new-commits-only; Graphite manages the rewritten history and force-pushes safely via submit.
- After any mid-stack change, **always `gt restack` before moving on** — higher branches must pick up the fix before you evaluate them.
- After a restack, re-check all higher PRs from scratch: the restack itself can introduce new conflicts or CI failures upstack.
- Merge conflicts during restack: resolve markers, `git add <files>`, then `gt continue`. Abort with `gt abort` if unresolvable and report.
- Finding each branch's PR: `gh pr view <branch> --json number,url,headRefOid` works per branch; `gt ls` shows PR associations too.
- Never run bare `gt submit` mid-loop (it may prompt); `gt submit --stack` from an updated bottom branch handles the whole stack.
