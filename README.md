# code-factory

Agent skills for dynamic software delivery. Each skill works standalone in Claude Code or Codex; together they cover the path from rough idea to merged PR.

## Workflow

```
Rough idea → writing-specs → execute-dynamic-workflow → PR with green CI → babysit-pr
                  ↑                                            |
                  |              User approves spec            |
                  +------------------ feedback ----------------+
```

1. **writing-specs** — Collaborate with the user on a design spec with EARS requirements, then run an adversarial spec review (Codex, clean context) before writing the artifact. This is the human checkpoint.
2. **execute-dynamic-workflow** — Deliver the spec with one repo-wide implementation owner by default. Use worktrees and parallel subagents only for independent, coherent units. Run repository checks directly, then use one clean-context adversarial reviewer from a different model provider when possible. After fixes, push the candidate and run CI plus independent EARS verification concurrently. The verifier proves every requirement with a lasting test or a disposable one-off check. The final phase also recommends `audit-tests` for lasting-test quality and `babysit-pr` for CI and review monitoring. Local findings return to the implementation owner. Structural failures return to the top-level orchestrator for a repo-wide fix.
3. **babysit-pr** — Monitor the PR (or a whole stack — Graphite and GitHub `gh stack` both supported) in a long-running loop: snapshot status with a deterministic script, fix CI bottom-up, answer review comments (🤖-prefixed), push once per iteration, with stale-CI and give-up guards so the loop can't spin.

Standalone utilities:

- **codex-mcp** — The verified recipe for driving the Codex MCP: tool parameters, model names, sandbox/approval flags (including the `.git` `writable_roots` trick that makes commits work under `workspace-write`), effort ladder, relay template for workflow scripts, and failure signatures. Other skills reference it instead of hardcoding Codex details.
- **audit-tests** — Audit an existing test suite for low-value, brittle, duplicative, or AI-generated tests and produce a precise cleanup plan. Its test-quality doctrine is also enforced at review time by the adversarial reviewer.

## Skills

| Skill | Description |
|-------|-------------|
| `writing-specs` | Design specs with EARS requirements, clarification markers, brownfield gap analysis, and adversarial spec review |
| `execute-dynamic-workflow` | Spec → verified change with single-owner implementation, selective worktree parallelism, and cross-model adversarial review |
| `babysit-pr` | Long-running PR/stack monitor: fix CI, respond to reviews, push verified fixes — Graphite, gh-stack, or standalone |
| `codex-mcp` | Verified known-good configuration for the Codex MCP (models, sandbox, approvals, worktree cwd rules) |
| `audit-tests` | Test-suite audit: keep/delete/merge/upgrade grading with a behavior-value rubric |

## Agents

Clean-context review contract used by the delivery and specification skills:

| Agent | Description |
|-------|-------------|
| `adversarial-reviewer` | Clean-context attack on requirement coverage, baseline compatibility, cross-module seams, embedded logic, and test honesty |

## Design principles

- **Spec-minimal frontmatter** (`name` + `description` only) so every skill loads in Claude Code, Codex, and anything else that reads the [Agent Skills spec](https://agentskills.io).
- **Direct deterministic checks**: Git state and repository commands are verified by the orchestrator. Judgment stays in implementation and review agents.
- **Stable ownership before fresh context**: one owner keeps the complete implementation model. A fresh reviewer supplies independent challenge.
- **Selective worktree isolation**: parallel implementers get separate checkouts only when their changes are independently valid and useful.
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

The same workflow shape works in Claude Code and Codex. Use the available native subagent and worktree tools directly.

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
