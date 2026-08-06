---
name: codex-mcp
description: Use when driving OpenAI Codex through the Codex MCP server — implementing a task with a Codex session, getting a cross-model adversarial review, continuing an existing Codex thread, or composing Codex calls into a workflow. Covers the exact tool parameters, sandbox and approval flags, model names, and failure signatures, all verified against the live server.
---

# Codex MCP

Drive Codex sessions through the `codex` MCP server with a known-good configuration. This is the single place Codex invocation details live — callers (skills, workflows, agents) follow this recipe instead of constructing MCP parameters from memory.

Everything in this file marked **verified** was tested live against codex-cli 0.145.0 (Aug 2026). When Codex updates, re-verify the "Verified surface" section before trusting it — model names and sandbox behavior are the two things that drift.

## Side-effect contract (read first)

- **Reviews run `read-only`.** A reviewer that can edit is not a reviewer. Never escalate a review session's sandbox to apply its own findings — dispatch a separate implementer session.
- **Implementation runs `workspace-write` with network enabled** (recipe below). `danger-full-access` is an explicit, per-call decision for work that genuinely needs writes outside the repo and temp dirs — never a default, never chosen silently.
- **`approval-policy: never`, always.** MCP callers have no approval channel; `untrusted`/`on-request` will wait forever on a prompt nobody can answer.
- **`cwd` is the exact checkout the session owns.** In worktree fan-outs, that is the task's worktree — never the orchestrator's repo root. A Codex session in the wrong cwd edits the wrong checkout and reports success.

## Preflight

Before composing anything expensive on top of Codex, confirm the tools resolve: load `mcp__codex__codex` and `mcp__codex__codex-reply` (in Claude Code, via ToolSearch with `select:mcp__codex__codex,mcp__codex__codex-reply`). If they are missing, stop and say so — do not attempt the work as Codex-by-imitation.

## Verified surface

Two tools:

| Tool | Parameters | Returns |
|---|---|---|
| `mcp__codex__codex` | `prompt` (required), `model`, `sandbox`, `approval-policy`, `cwd`, `config` (config.toml overrides), `base-instructions`, `developer-instructions`, `compact-prompt` | `{threadId, content}` |
| `mcp__codex__codex-reply` | `prompt` (required), `threadId` | `{threadId, content}` |

- `content` is Codex's final message; the full inner transcript lives in `~/.codex/sessions/` under the thread id.
- `conversationId` on `codex-reply` is a deprecated alias for `threadId` — it still works, but write `threadId` in anything new.
- Replies inherit the original session's model/sandbox/config.

**Models (verified valid on this account):**

| Model | Tier | Use for |
|---|---|---|
| `gpt-5.6-sol` | flagship (account default) | deep review, plan review, final sweeps |
| `gpt-5.6-terra` | balanced | implementation |
| `gpt-5.6-luna` | fast | mechanical/simple tasks |
| `gpt-5.5`, `gpt-5.4` | previous gen | fallbacks |

Invalid names (e.g. `gpt-5.6`, `gpt-5.6-codex`) fail the whole call with a 400: *"The '…' model is not supported when using Codex with a ChatGPT account."* If a Codex call fails instantly with that message, fix the model name — nothing else is wrong.

**Reasoning effort** — set via `config`, not a top-level param:

```json
"config": { "model_reasoning_effort": "high" }
```

Valid values for the 5.6 family, verified: `none`, `low`, `medium`, `high`, `xhigh`, `max`. `minimal` is rejected with a 400. **Footgun:** an unrecognized value (or a misspelled config key) is *silently ignored* and the session runs at the config default — a typo here does not error, it quietly downgrades. Copy values from this list exactly.

## Default invocation recipe

```json
{
  "prompt": "<the task>",
  "model": "gpt-5.6-terra",
  "sandbox": "workspace-write",
  "approval-policy": "never",
  "cwd": "<absolute path to the checkout this session owns>",
  "config": {
    "model_reasoning_effort": "medium",
    "sandbox_workspace_write": {
      "network_access": true,
      "writable_roots": ["<main repo .git dir>"]
    }
  }
}
```

**Why `writable_roots` (verified):** under `workspace-write`, the repo's `.git` directory is read-only — `git add`/`git commit` fail on `.git/index.lock`. Adding the **main repo's** `.git` directory to `writable_roots` fixes it. Compute it from inside the target checkout — this is correct in both main checkouts and worktrees (a worktree's real git dir lives under the main repo's `.git/worktrees/<name>`):

```bash
git -C <cwd> rev-parse --path-format=absolute --git-common-dir
```

There is no `allow_git_writes` option (silently ignored, like all unknown keys). Upstream issues claim `.git` cannot be made writable at all — empirically it can, on this version; if a future Codex release closes it, fall back to `danger-full-access` for committing sessions and flag the change.

**Sandbox reference (all verified):**

| Mode | Writes | Network |
|---|---|---|
| `read-only` | none | no |
| `workspace-write` | `cwd` + system temp dirs + `writable_roots` (`.git` excluded unless listed) | off by default; `network_access: true` enables |
| `danger-full-access` | anywhere | yes |

## Effort ladder

Match effort to the job; don't run everything hot:

| Job | Model | Effort |
|---|---|---|
| Mechanical edit, rename, config change | luna | `low` |
| Typical implementation task | terra | `medium` |
| Subtle implementation, tricky fix | terra | `high` |
| Adversarial review of one diff | sol | `high` |
| Plan review, whole-branch final sweep | sol | `xhigh` |

`max` exists (verified) — reserve it for one-shot problems worth minutes of thinking; it is not a better default.

## Continuing a session

Capture `threadId` from every result. Continue with `codex-reply` when the next step benefits from the session's accumulated context — review-fix cycles on the same task, follow-up questions to a reviewer about its own findings. Do **not** continue a session across different tasks or different checkouts: the thread's context describes files and paths that no longer match, and adversarial review requires a clean context per subject (a reviewer must never re-review work it helped fix).

## Review mode

For a cross-model adversarial review: `sandbox: read-only`, model `gpt-5.6-sol`, effort `high` (single diff) or `xhigh` (plan / whole branch). Give the reviewer **only** the artifact and repo access — no drafting history, no author rationale. Map Codex's output honestly: if it is ambiguous about whether an issue is real, it is a finding; never infer a PASS Codex didn't state. If the caller needs structure, report verdict `PASS|ISSUES` plus one entry per defect (severity, file, summary, concrete failure scenario) and the `threadId`.

## Using Codex inside Workflow scripts

Workflow subagents reach the MCP tools themselves via ToolSearch — the script dispatches a cheap relay agent whose prompt embeds the full briefing. Template (interpolate every `<...>`):

```
You are a Codex session runner — a thin relay. Do not write code or run
commands yourself; the one exception is writing the run log below.

1. ToolSearch `select:mcp__codex__codex,mcp__codex__codex-reply`.
2. THREAD is "<threadId or 'new'>". If "new", call mcp__codex__codex with:
   prompt: everything after PROMPT:, verbatim — do not summarize or annotate
   model: <model>  sandbox: <sandbox>  approval-policy: never  cwd: <cwd>
   config: <config JSON per the codex-mcp recipe>
   Otherwise call mcp__codex__codex-reply with threadId THREAD and the prompt.
3. Capture threadId from the result.
4. Write the run log to <planDir>/runs/<label>.md (append with a --- separator
   if it exists): config used, threadId, the full prompt verbatim, and Codex's
   complete final response verbatim — not a summary.
5. If the call errors, retry once with identical parameters. If it errors
   again, report status CODEX_UNAVAILABLE with the literal error text.
Report: status DONE|DONE_WITH_CONCERNS|BLOCKED|CODEX_UNAVAILABLE, threadId,
commits, files changed, summary of Codex's report, concerns. Map Codex's
self-reported outcome honestly — "could not finish" is BLOCKED, not DONE.

PROMPT:
<the task prompt>
```

The run log preserves observability across the relay layer; the thread id is the pointer into `~/.codex/sessions/` when a human needs the full transcript.

## Failure signatures (verified)

| Symptom | Cause | Fix |
|---|---|---|
| Instant 400 "model is not supported when using Codex with a ChatGPT account" | bad model name | use a name from the models table |
| 400 `unsupported_value` on `reasoning.effort` | effort valid in config schema but rejected by API (e.g. `minimal`) | use the verified list |
| Call succeeds but behaves like default effort | misspelled config key/value silently ignored | copy the recipe exactly |
| "sandbox denied creating .git/index.lock" | `workspace-write` without `.git` in `writable_roots` | add the main repo's `.git` (recipe above) |
| "could not resolve host" from git push / curl | `workspace-write` network off | `network_access: true` |
| Write blocked outside cwd | `workspace-write` scope working as designed | correct `cwd`, or `danger-full-access` if truly needed |
| Tool call hangs indefinitely | `approval-policy` not `never` | always `never` over MCP |

## Common mistakes

| Mistake | Fix |
|---|---|
| Constructing params from memory instead of this recipe | Copy the recipe; only `prompt`, `model`, effort, and `cwd` should vary per call |
| Reusing the orchestrator's repo root as `cwd` for a worktree task | `cwd` = the worktree; `writable_roots` = the **main** repo's `.git` |
| Continuing one thread across tasks or checkouts | New task or new checkout → new session |
| Letting a reviewer session fix its own findings | Findings go to a separate implementer session |
| Treating Codex's report as ground truth | Verify claims against the diff and tests; Codex output is advisory |
| Summarizing the prompt "for" Codex in a relay | The relay sends the prompt verbatim |
