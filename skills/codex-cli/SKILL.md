---
name: codex-cli
description: Use when a code-factory skill or workflow drives OpenAI Codex — choosing a model and effort, scoping a session to the right checkout, or getting a cross-model adversarial review. Covers only the choices code-factory makes; the codex plugin owns the command surface.
---

# Codex CLI

Codex is driven through the `codex` Claude Code plugin — `/codex:rescue` to
delegate work, `/codex:review` and `/codex:adversarial-review` to review,
`/codex:setup` to check the install. The plugin's own skills document the
commands and flags; running the companion script bare
(`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs"`) prints its usage.
Don't restate either here.

There is no `mcp__codex__*` tool surface. Don't ToolSearch for Codex tools, and
don't build relay subagents whose only job is to forward a prompt.

This skill covers the calls code-factory makes on top of that.

## Session scope

- **`cwd` is the checkout the session owns.** Run the command from that
  directory. In worktree fan-outs that's the task's worktree, never the
  orchestrator's repo root — a session in the wrong directory edits the wrong
  checkout and reports success.
- **One thread per task per checkout.** Resume within a task (review-fix
  cycles, follow-ups to a reviewer about its own findings). Start fresh for a
  new task or a new checkout: the thread's context describes paths that no
  longer match.
- **A reviewer never fixes its own findings.** Reviews are review-only;
  findings go to a separate implementer session. Adversarial review needs a
  clean context per subject.

## Model and effort

Verified against `codex debug models` on 2026-11-17.

| Job | Model | Effort |
|---|---|---|
| Mechanical edit, rename, config change | `gpt-6.1-terra` | `low` |
| Typical implementation task | `gpt-6.2-sol` | `high` |
| Subtle implementation, tricky fix | `gpt-6.2-astra` | `high` |
| Adversarial review, plan review, final sweep | `gpt-6.2-astra` | `high` |

Set the effort explicitly with `--effort`. Use `xhigh`, `max`, or `ultra`
only when the task explicitly calls for more reasoning.

If the listed model is unavailable, use `gpt-6.2-sol` if available, then
`gpt-6.1-sol`. Keep the effort listed for the job.

A bad model name fails instantly with a 400 (*"not supported when using Codex
with a ChatGPT account"*); fix the name, nothing else is wrong.

## Reviews

Cross-model review only counts when the author used a different model. Give the
reviewer **only** the artifact and repo access — no drafting history, no author
rationale.

Map Codex's output honestly: if it's ambiguous about whether an issue is real,
it's a finding; never infer a PASS Codex didn't state. When a caller needs
structure, report verdict `PASS|ISSUES` plus one entry per defect (severity,
file, summary, concrete failure scenario).

## In workflow scripts

Call the companion script directly from a `Bash` step, from the owning
checkout. Keep a run log: the config used, the prompt verbatim, and Codex's
complete final response verbatim — not a summary. The thread id in the output
points into `~/.codex/sessions/` for the full transcript.

Map Codex's self-reported outcome honestly — "could not finish" is BLOCKED, not
DONE. Treat its report as advisory and verify claims against the diff and tests.

## Gotchas

| Symptom | Fix |
|---|---|
| `codex (CONNECTION_CLOSED)` at session start | Remove the `mcpServers.codex` entry: `claude mcp remove codex --scope user`. The plugin needs no MCP server. |
| Codex reports edits it didn't make | `task` is read-only without `--write` |
| A turn consumed by a flag | `--help` after a subcommand is sent as a prompt; run the script bare for usage |
