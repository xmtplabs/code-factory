---
name: codex-cli
description: Use when driving OpenAI Codex from Claude Code — implementing a task with a Codex session, getting a cross-model adversarial review, continuing an existing Codex thread, or composing Codex calls into a workflow. Covers the plugin commands, the companion script surface, model names, sandbox and effort settings, and failure signatures.
---

# Codex CLI

Drive Codex sessions through the `codex` Claude Code plugin with a known-good
configuration. This is the single place Codex invocation details live — callers
(skills, workflows, agents) follow this recipe instead of constructing
parameters from memory.

Verified against codex-cli 0.154.0 and codex plugin 1.0.6 on 2026-09-17; the
model catalog was read from `codex debug models` the same day. When Codex
updates, re-check the "Verified surface" section — model names, transports,
and sandbox behavior can change.

## Transport (read first)

Codex is driven through the **plugin's companion script**, which talks to
Codex over the `app-server` JSON-RPC protocol as a subprocess.

There is no `mcp__codex__*` tool surface. Do not ToolSearch for Codex tools,
and do not build relay subagents whose only job is to forward a prompt. Call
the plugin command, or the companion script under it, directly.

## Side-effect contract

- **Reviews are review-only.** A reviewer that can edit is not a reviewer.
  `/codex:review` and `/codex:adversarial-review` do not take `--write`. Never
  let a review session apply its own findings — dispatch a separate
  implementer session.
- **Implementation needs `--write`.** `task` is read-only unless you pass
  `--write`. A task that must edit files and gets no `--write` will report
  work it could not actually do.
- **`cwd` is the exact checkout the session owns.** Run the command from that
  checkout. In worktree fan-outs that is the task's worktree — never the
  orchestrator's repo root. A Codex session in the wrong directory edits the
  wrong checkout and reports success.

## Verified surface

Preferred entry points are the slash commands:

| Command | Use for |
|---|---|
| `/codex:rescue` | delegate investigation or a fix to a Codex session |
| `/codex:review` | implementation-defect review of a diff or branch |
| `/codex:adversarial-review` | challenge the approach, design, and assumptions |
| `/codex:status`, `/codex:result`, `/codex:cancel` | manage background jobs |
| `/codex:setup` | check CLI, auth, and the review gate |

Under them is one companion script. Invoke it with `${CLAUDE_PLUGIN_ROOT}`:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" <subcommand> [flags]
```

| Subcommand | Flags |
|---|---|
| `setup` | `[--enable-review-gate\|--disable-review-gate] [--json]` |
| `review` | `[--wait\|--background] [--base <ref>] [--scope <auto\|working-tree\|branch>]` |
| `adversarial-review` | same as `review`, plus trailing focus text |
| `task` | `[--background] [--write] [--resume-last\|--resume\|--fresh] [--model <model\|spark>] [--effort <none\|minimal\|low\|medium\|high\|xhigh>] [prompt]` |
| `transfer` | `[--source <claude-jsonl>] [--json]` |
| `status` | `[job-id] [--all] [--json]` |
| `result` / `cancel` | `[job-id] [--json]` |

Notes:

- `--help` is not a global flag. `codex-companion.mjs task --help` forwards
  `--help` to Codex as a *prompt* and burns a real turn. Run the script with no
  subcommand to print usage.
- Session transcripts live in `~/.codex/sessions/` under the thread id.
- `--background` detaches the job; `Bash(run_in_background: true)` is what
  actually detaches it from Claude Code's side. Poll with `status`, collect
  with `result`.

**Models** (from `codex debug models`, 2026-09-17):

| Model | Effort | Tier | Use for |
|---|---|---|---|
| `gpt-6-astra` | `high` | flagship | complex implementation, deep review, plan review, final sweeps |
| `gpt-6-astra` | `low` | second tier | routine implementation |
| `gpt-5.6-luna` | `low` | fast | mechanical/simple tasks |
| `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.5` | set explicitly | previous gen | fallbacks |

Both Astra tiers use the model identifier `gpt-6-astra`; set the tier with
`--effort`, not by adding the effort to the model name. `spark` is a plugin
alias that maps to `gpt-5.3-codex-spark`. Invalid names fail the whole call with a 400: *"The '…' model is not
supported when using Codex with a ChatGPT account."* If a call fails instantly
with that message, fix the model name — nothing else is wrong.

**Reasoning effort.** Astra's catalog lists `low`, `medium`, `high`, `xhigh`,
`max`, `ultra`, and defaults to `medium` when effort is omitted. The `task`
flag accepts `none`, `minimal`, `low`, `medium`, `high`, `xhigh`. Use `high`
for the flagship tier and `low` for the second tier. Do not use `none` or
`minimal` for Astra — `minimal` is rejected by the API with a 400
`unsupported_value` on `reasoning.effort`. Leave `--effort` unset unless the
task calls for a specific tier.

## Default invocation recipe

Implementation, from the checkout the session owns:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task \
  --write --model gpt-6-astra --effort low "<the task>"
```

Review of the current branch:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" adversarial-review \
  --base main "<focus>"
```

Only the prompt, model, effort, and working directory should vary per call.

## Effort ladder

Match effort to the job; don't run everything hot:

| Job | Model | Effort |
|---|---|---|
| Mechanical edit, rename, config change | `gpt-5.6-luna` | `low` |
| Typical implementation task | `gpt-6-astra` | `low` |
| Subtle implementation, tricky fix | `gpt-6-astra` | `high` |
| Adversarial review of one diff | `gpt-6-astra` | `high` |
| Plan review, whole-branch final sweep | `gpt-6-astra` | `high` |

The catalog also lists `xhigh`, `max`, and `ultra`. Use these only when a task
explicitly requires more effort than the flagship default.

## Continuing a session

Continue with `--resume` (or `--resume-last`) when the next step benefits from
the session's accumulated context — review-fix cycles on the same task,
follow-up questions to a reviewer about its own findings. Use `--fresh` to
force a new thread. Do **not** continue a session across different tasks or
different checkouts: the thread's context describes files and paths that no
longer match, and adversarial review requires a clean context per subject (a
reviewer must never re-review work it helped fix).

`/codex:rescue` will offer the choice interactively when a resumable thread
exists; passing `--resume` or `--fresh` skips the prompt.

## Review mode

Use `/codex:adversarial-review` to challenge the approach; use `/codex:review`
for implementation defects. Both are review-only and take `--base <ref>` and
`--scope auto|working-tree|branch`. `adversarial-review` also accepts trailing
focus text; neither supports `--scope staged` or `--scope unstaged`.

This is a cross-model review only when the author used a different model. Give
the reviewer **only** the artifact and repo access — no drafting history, no
author rationale. Map Codex's output honestly: if it is ambiguous about whether
an issue is real, it is a finding; never infer a PASS Codex didn't state. If
the caller needs structure, report verdict `PASS|ISSUES` plus one entry per
defect (severity, file, summary, concrete failure scenario).

## Using Codex inside Workflow scripts

Call the companion script directly from a `Bash` step. Do **not** dispatch a
relay agent whose only job is to forward a prompt — that pattern existed to
reach MCP tools from a subagent's tool scope and is now pure overhead.

```bash
cd <the checkout this session owns> && \
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task \
  --write --model <model> --effort <effort> "<the task prompt>" \
  | tee -a <planDir>/runs/<label>.md
```

Keep the run log: the config used, the full prompt verbatim, and Codex's
complete final response verbatim — not a summary. The thread id in the output
is the pointer into `~/.codex/sessions/` when a human needs the full
transcript. Map Codex's self-reported outcome honestly — "could not finish" is
BLOCKED, not DONE.

## Failure signatures

| Symptom | Cause | Fix |
|---|---|---|
| `codex (CONNECTION_CLOSED)` at session start | a `mcpServers.codex` entry in `~/.claude.json` | `claude mcp remove codex --scope user`; the plugin needs no MCP server |
| Instant 400 "model is not supported when using Codex with a ChatGPT account" | bad model name | use a name from the models table |
| 400 `unsupported_value` on `reasoning.effort` | effort rejected by API (e.g. `minimal`) | use the verified list |
| Codex reports edits it did not make | `task` without `--write` | pass `--write` for implementation |
| A turn is consumed by a flag | `--help` after a subcommand is sent as a prompt | run the script with no subcommand for usage |
| Codex missing or unauthenticated | no CLI or no login | `/codex:setup`, then `codex login` |

## Common mistakes

| Mistake | Fix |
|---|---|
| Reaching for `mcp__codex__*` tools or ToolSearch | There is no Codex MCP surface; call the plugin command |
| Building a relay subagent to forward a prompt | Call the companion script directly from `Bash` |
| Constructing params from memory instead of this recipe | Copy the recipe; only prompt, model, effort, and checkout vary |
| Running a worktree task from the orchestrator's repo root | `cd` to the worktree first |
| Continuing one thread across tasks or checkouts | New task or new checkout → `--fresh` |
| Letting a reviewer session fix its own findings | Findings go to a separate implementer session |
| Treating Codex's report as ground truth | Verify claims against the diff and tests; Codex output is advisory |
