# code-factory

Agent plugin for structured software delivery. Each skill can be used independently or chained together into an end-to-end pipeline.

## Workflow

```
Rough idea → writing-specs → decomposing-specs → executing-plans → Human review
                  ↑                                                      |
                  |              User approves spec                      |
                  +--------------------- feedback -----------------------+
```

For autonomous work via GitHub issues:

```
GitHub issue → coder-task → classify (bug/feature) → spec → decompose → execute → PR
```

1. **writing-specs** — Collaborate with the user to produce a design spec with EARS requirements. This is the human checkpoint — the user reviews and approves the spec before anything gets built.
2. **decomposing-specs** — Autonomously dispatches a `decomposer` subagent that explores the codebase and writes a multi-file plan: `plan.md` (TOC + coverage matrix), `standards.md` (one-time codebase context shared across phases), and per-phase files. Phase 1 + Verification ship fully elaborated; intermediate phases as sketches. Scoped plan-reviewer and task-list-reviewer validate the elaborated portion before hand-off.
3. **executing-plans** — Orchestrates implementation. Loads `plan.md` + `standards.md` only; reads phase files on demand. At each phase boundary, dispatches `phase-elaborator` to flesh out sketched phases against the current codebase (just-in-time elaboration). Then dispatches implementer subagents (with batching for cohesive consecutive tasks, parallel for `[P]` tasks). Phase-boundary review depth scales to phase size; severity-gated re-review prevents ping-pong. Runs CI checks, final full-spec review, and auto-debug escalation if remediation fails.
4. **Human review** — The user reviews the finished implementation. Feedback loops back to a new spec or direct fixes.

Each skill produces a file artifact and can be invoked independently:
- `writing-specs` → `docs/plans/YYYY-MM-DD-<topic>-design.md`
- `decomposing-specs` → `docs/plans/YYYY-MM-DD-<topic>/` (multi-file: `plan.md`, `standards.md`, `phases/NN-*.md` — Phase 1 + Verification fully elaborated; intermediate phases sketched and elaborated just-in-time by `executing-plans`)

## Skills

| Skill | Description |
|-------|-------------|
| `writing-specs` | Collaborate on a design spec with EARS requirements, clarification markers, and brownfield gap analysis |
| `decomposing-specs` | Dispatch a `decomposer` subagent to write a multi-file phased plan (Phase 1 + Verification elaborated; rest sketched for just-in-time elaboration) |
| `executing-plans` | Execute a multi-file plan with on-demand phase loading, just-in-time elaboration, batched/parallel implementer dispatch, size-scaled phase reviews, and auto-debug escalation |
| `coder-task` | End-to-end: GitHub issue → classify bug/feature → spec → tasks → implementation → PR on a fork |
| `code-factory` | v2 of `coder-task`: same flow with scripted fork/branch/PR steps, requester-as-reviewer, and selective feedback handling |
| `receiving-feedback` | Classify new issue comments as trivial (do inline) vs. meaningful (update spec, re-decompose) — used by `code-factory` |
| `bugfix` | Produce a 3-section bugfix spec (Current/Expected/Unchanged Behavior) — dispatched by coder-task, not invoked directly |
| `setup-code-factory` | Onboard a repo to Code Factory: write `.code-factory/config.toml`, create a devcontainer if missing, and validate build/lint/test inside it |

## Agents

| Agent | Description |
|-------|-------------|
| `decomposer` | Reads spec + explores codebase, writes the multi-file plan (`plan.md`, `standards.md`, phase files) — keeps codebase exploration out of the main agent's context |
| `phase-elaborator` | Converts a sketched phase into a fully-elaborated phase file just before execution, against the current post-prior-phase codebase |
| `implementer` | Implements a single task (or batch of cohesive consecutive tasks) with TDD, tests, and verification |
| `correctness-reviewer` | Verifies plan alignment, logic correctness, completeness, and edge case handling |
| `design-reviewer` | Reviews code organization, patterns, naming, and reuse opportunities |
| `security-reviewer` | Reviews code for security vulnerabilities, injection risks, and secrets handling |
| `test-quality-reviewer` | Reviews test assertion quality, test design, and anti-patterns |
| `test-coverage-reviewer` | Verifies requirement-to-test mapping at phase boundaries |
| `task-list-reviewer` | Validates cross-artifact consistency between spec and task list |
| `spec-reviewer` | Validates implementation against EARS requirements |
| `plan-reviewer` | Audits a task list for requirement coverage, TDD enforcement, and CI verification |
| `auto-debugger` | Fresh-context root-cause analysis when remediation is exhausted |

## Installation

### Claude Code

```bash
claude plugin marketplace add xmtplabs/code-factory
claude plugin install code-factory@code-factory
```

Or install from a local clone:

```bash
git clone https://github.com/xmtplabs/code-factory.git
claude plugin marketplace add /path/to/code-factory
claude plugin install code-factory@code-factory
```

### Codex

```bash
git clone https://github.com/xmtplabs/code-factory.git
cd code-factory
mkdir -p ~/.agents/skills
ln -s "$(pwd)/skills" ~/.agents/skills/code-factory
```

### OpenCode

```bash
git clone https://github.com/xmtplabs/code-factory.git
```

Add to your `opencode.json`:

```json
{
  "plugins": [
    {
      "name": "code-factory",
      "path": "/path/to/code-factory"
    }
  ]
}
```
