# code-factory

Agent plugin for structured software delivery. Each skill can be used independently or chained together into an end-to-end pipeline.

## Workflow

```
Rough idea → writing-specs → decomposing-specs → executing-plans → Human review
                  ↑                                                      |
                  |              User approves spec                      |
                  +--------------------- feedback -----------------------+
```

1. **writing-specs** — Collaborate with the user to produce a design spec with EARS requirements. This is the human checkpoint — the user reviews and approves the spec before anything gets built.
2. **decomposing-specs** — Autonomously converts the spec into a phased, TDD-enforced task list. Runs a plan-reviewer agent to validate coverage, then hands off immediately.
3. **executing-plans** — Orchestrates implementation by dispatching implementer subagents for each task. Reviews code quality and spec compliance at phase boundaries. Runs CI checks and a final full-spec review at the end.
4. **Human review** — The user reviews the finished implementation. Feedback loops back to a new spec or direct fixes.

Each skill produces a file artifact and can be invoked independently:
- `writing-specs` → `docs/plans/YYYY-MM-DD-<topic>-design.md`
- `decomposing-specs` → `docs/plans/YYYY-MM-DD-<topic>-tasks.md`

## Skills

| Skill | Description |
|-------|-------------|
| `writing-specs` | Collaborate on a design spec with EARS requirements |
| `decomposing-specs` | Break a spec into a phased, TDD-enforced task list |
| `executing-plans` | Execute a task list with implementer subagents and review gates |
| `coder-task` | End-to-end: GitHub issue → spec → tasks → implementation → PR on a fork |

## Agents

| Agent | Description |
|-------|-------------|
| `implementer` | Implements a single task with TDD, tests, and verification |
| `code-reviewer` | Reviews code for quality, patterns, and maintainability |
| `spec-reviewer` | Validates implementation against EARS requirements |
| `plan-reviewer` | Audits a task list for requirement coverage, TDD enforcement, and CI verification |

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
