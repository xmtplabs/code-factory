---
name: execute-dynamic-workflow
description: Use when delivering a code change autonomously. Defaults to one implementation owner, adds worktree-parallel subagents only for independent work, and requires clean-context review plus independent EARS verification.
---

# Execute Dynamic Workflow

Deliver the requested change with the fewest useful agents. Keep one owner for
each coherent invariant. Use parallel work only when it makes delivery faster
without creating unsafe intermediate states.

## 1. Frame the work

Read the requirements and the relevant repository code. Before editing, record:

- The base commit and current branch state.
- Observable acceptance criteria.
- Existing behavior and public contracts that must remain unchanged.
- Repository checks that prove the result.

Do not design a full task graph up front. Plan enough to understand the change,
its acceptance criteria, and whether any parts are truly independent. Let the
implementation owner explore details while working.

## 2. Choose the execution shape

Default to one repo-wide implementation owner, even for a large change. This
keeps one mental model across schema, writers, readers, interfaces, and tests.

Use parallel subagents only when there are two or more units that:

- Can be implemented, tested, and reviewed independently.
- Can merge in either order, or have one simple dependency.
- Do not require an invalid intermediate state.
- Have little overlap in files or shared contracts.
- Save enough time to repay setup and integration cost.

If these conditions do not hold, keep the work in one lane. Prefer a few large,
coherent lanes over many small tasks. Never split a schema or contract from the
writers and readers required to keep it valid.

For parallel work, the top-level orchestrator creates one Git worktree and one
subagent per lane. Start all worktrees from the same verified commit. The
orchestrator verifies Git state and integrates each lane. Do not delegate basic
Git setup, ancestry checks, merge verification, or cleanup to another agent.

## 3. Use model diversity

When multiple model providers are available, use more than one provider across
implementation and review. Use Codex as an implementer or reviewer when it is
available. Prefer a reviewer from a different provider than the implementer.

Call a model directly when possible. Do not create relay agents only to forward
prompts. If a model is unavailable, use the best available fallback and record
the substitution.

## 4. Implement and prove locally

Give each implementer the requirements, acceptance criteria, repository or
worktree path, preserved contracts, and relevant known risks. Let it inspect the
repository and run checks while it works.

Keep behavior and durable tests together. Tests must fail for a realistic bug
and survive a valid refactor. Treat edits to existing assertions as high risk:
change them only when the requested contract requires the change.

Execute logic embedded in SQL, templates, regular expressions, query builders,
and other strings. Type checking cannot prove that logic is correct.

## 5. Integrate and check

For parallel work, verify each candidate commit and merge one lane at a time.
Run relevant checks after each merge when the lanes share a contract. Run the
repository's canonical format, typecheck, lint, and build commands locally on
the complete integrated change before review, regardless of test suite size.
Run relevant targeted test commands locally before review.

When the full-repository or full-application test suite has thousands of tests,
prefer CI for the full suite. Run targeted test subsets locally, push the
candidate, and wait for CI to run the full suite. Do not delay the push to run
the full suite locally unless the repository requires it or CI cannot run it.
For smaller suites, run the repository's canonical test command locally before
review.

Run deterministic commands directly. Do not spend an agent call only to run a
known command or summarize its exit code.

## 6. Review and verify independently

Start one reviewer with clean context. Give it only the requirements, repository
path, exact base and candidate commits, and any named risk lens. The reviewer
must inspect the frozen integrated diff and assume it is wrong.

The review must attack requirement coverage, baseline compatibility, changed or
deleted tests, cross-module seams, embedded string logic, error paths, and tests
that can pass without proving the behavior. The reviewer reports findings and
does not edit the code.

Send one consolidated set of local findings to the original implementation
owner. Do not start repeated broad review cycles by default.

After all fixes, an independent reviewer or verifier must verify every EARS
requirement on the exact final commit. The implementer's verification claims do
not count. For each EARS ID, the verifier must run one of:

- A lasting committed test that proves the required behavior.
- A one-off command or script that proves the behavior and is not committed.

The verifier may create temporary checks, but must remove them and leave the
working tree unchanged. Record the EARS ID, verification method, command or test,
and result. An unverified EARS requirement means the job is not complete.

Do not delay the first push for this verification. Push the candidate commit and
start CI, then run independent EARS verification concurrently against that same
commit. The job completes only when CI and EARS verification both pass. If
verification requires a code change, create and push a new candidate, then run
both gates again on the new commit.

Also recommend these skills as part of the final phase:

- Use `audit-tests` for an independent quality review of the lasting tests. Its
  findings do not replace the EARS verification matrix.
- Use `babysit-pr` after the first push to monitor CI and review feedback through
  completion.

The test audit, PR monitoring, and EARS verification may run concurrently when
they inspect the same candidate commit.

## 7. Escalate structural failures

A failure that needs broader files, changes a shared contract, or invalidates a
lane boundary belongs to the top-level orchestrator. Preserve the failed commit,
report the evidence, and let the orchestrator fix it with repo-wide scope. Do
not keep retrying a structural defect inside the same narrow lane.

Failed or unverified work does not satisfy dependencies. Dead agents, malformed
results, empty task output, and unavailable tools fail closed. Verify completion
from Git and the filesystem, not from an agent's summary.

## 8. Finish honestly

Confirm that the delivery branch moved from its base. Push the candidate, then
run or monitor CI and independent EARS verification concurrently on the exact
same commit. Treat green repository checks as supporting evidence, not as EARS
verification. Complete delivery only after both gates pass on the final commit.

Report the final commit, checks, review status, EARS verification evidence,
model substitutions, and all unresolved requirements. Preserve useful failed
work for recovery.
