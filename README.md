# code-factory

Agent skills for dynamic software delivery. Each skill works standalone in Claude Code or Codex; together they cover the path from rough idea to merged PR.

## Workflow

```
Rough idea → writing-specs → execute-dynamic-workflow → PR with green CI → babysit-pr
                  ↑                                            |
                  |            User approves spec/plan         |
                  +------------------ feedback ----------------+
```

1. **writing-specs** — Collaborate with the user on a design spec with EARS requirements, then run an adversarial spec review (Codex, clean context) before writing the artifact. This is the human checkpoint.
2. **execute-dynamic-workflow** — Deliver the spec autonomously: an expensive planner writes a granular plan directory, tasks are elaborated just-in-time and implemented in **parallel git worktrees** by difficulty-matched Codex/Claude implementers, adversarial reviewers (cross-model on high-risk tasks) attack each diff, and the full check suite runs at phase boundaries behind a deterministic hygiene gate. One approval gate after planning; everything else is flags, not questions. Ships as a workflow **shape** plus tested example scripts (`full-delivery.js` for spec-to-PR, `mini-feature.js` for small scoped changes) that custom workflows copy and edit.
3. **babysit-pr** — Monitor the PR (or a whole stack — Graphite and GitHub `gh stack` both supported) in a long-running loop: snapshot status with a deterministic script, fix CI bottom-up, answer review comments (🤖-prefixed), push once per iteration, with stale-CI and give-up guards so the loop can't spin.

Standalone utilities:

- **codex-mcp** — The verified recipe for driving the Codex MCP: tool parameters, model names, sandbox/approval flags (including the `.git` `writable_roots` trick that makes commits work under `workspace-write`), effort ladder, relay template for workflow scripts, and failure signatures. Other skills reference it instead of hardcoding Codex details.
- **audit-tests** — Audit an existing test suite for low-value, brittle, duplicative, or AI-generated tests and produce a precise cleanup plan. Its test-quality doctrine is also enforced at review time by the adversarial reviewer.

## Skills

| Skill | Description |
|-------|-------------|
| `writing-specs` | Design specs with EARS requirements, clarification markers, brownfield gap analysis, and adversarial spec review |
| `execute-dynamic-workflow` | Spec → PR via dynamic workflows: worktree-parallel implementation, cross-model adversarial review, phase-boundary verification |
| `babysit-pr` | Long-running PR/stack monitor: fix CI, respond to reviews, push verified fixes — Graphite, gh-stack, or standalone |
| `codex-mcp` | Verified known-good configuration for the Codex MCP (models, sandbox, approvals, worktree cwd rules) |
| `audit-tests` | Test-suite audit: keep/delete/merge/upgrade grading with a behavior-value rubric |

## Agents

Subagent contracts used by execute-dynamic-workflow (Claude Code):

| Agent | Description |
|-------|-------------|
| `workflow-planner` | Spec → compact plan directory (plan.md TOC, shared preface, per-phase sketches) |
| `dynamic-elaborator` | Phase sketch → verified just-in-time task list, one small file per task |
| `adversarial-reviewer` | Clean-context diff attack: requirement fraud, hostile inputs, test quality, plan-vocabulary leaks |

## Design principles

- **Spec-minimal frontmatter** (`name` + `description` only) so every skill loads in Claude Code, Codex, and anything else that reads the [Agent Skills spec](https://agentskills.io).
- **Deterministic scripts for what must not vary** (`scan-plan-vocab.sh`, `check-pr.sh`): parsing and gating live in bash; judgment lives in prose.
- **Hard rules stated first**, with the enforcement stacked: implementer prompts, reviewer attack lists, and a script gate all independently catch plan-vocabulary leaks and dishonest tests.
- **Worktree isolation over file locks**: parallel implementers each get their own checkout; integration merges and cleans up in the same step.
- **Flags over questions**: after the last human gate, autonomous runs surface judgment calls at the end instead of stopping.

## Installation

### Claude Code

```bash
claude plugin marketplace add xmtplabs/code-factory
claude plugin install code-factory@code-factory
```

Or from a local clone:

```bash
git clone https://github.com/xmtplabs/code-factory.git
claude plugin marketplace add /path/to/code-factory
claude plugin install code-factory@code-factory
```

### Codex

Codex discovers skills in `~/.agents/skills`:

```bash
git clone https://github.com/xmtplabs/code-factory.git
mkdir -p ~/.agents/skills
for s in /path/to/code-factory/skills/*/; do
  ln -s "$s" ~/.agents/skills/"$(basename "$s")"
done
```

(Note: the `execute-dynamic-workflow` example scripts orchestrate via Claude Code's Workflow tool; on Codex the skill's shape and the `codex-mcp`/`babysit-pr`/`writing-specs`/`audit-tests` skills work directly.)

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
