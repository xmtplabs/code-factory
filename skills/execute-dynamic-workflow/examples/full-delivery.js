export const meta = {
  name: 'full-delivery',
  description: 'Take a design spec from plan to PR with green CI: plan-approval gate, JIT-elaborated phases, worktree-parallel implementers, cross-model adversarial review, phase-boundary verification',
  whenToUse: 'Dispatched by the execute-dynamic-workflow skill with args {specPath, planDir, repoRoot, skillDir, baseBranch, branch, prTitle, approved?, feedback?, clarifications?}',
  phases: [
    { title: 'Plan', detail: 'branch setup, planner explores + writes plan dir, adversarial plan review, approval page' },
    { title: 'Deliver', detail: 'worktree sweep, PR, CI to green, final adversarial sweeps' },
  ],
}

// ============================== Args guard ==============================
// `args` is injected by the Workflow runtime. Two things go wrong in practice:
//
// 1. Injection does not happen at all, and every interpolation silently becomes
//    the string "undefined" — the planner is dispatched with a prompt reading
//    "Spec path: undefined" and tens of thousands of tokens burn before an
//    agent notices. Fail here instead, in milliseconds, naming what is wrong.
// 2. The object arrives JSON-encoded as a string. It carries exactly the
//    information we need, so parse it rather than rejecting the run.
const REQUIRED_ARGS = ['specPath', 'planDir', 'repoRoot', 'skillDir', 'baseBranch', 'branch', 'prTitle']

function normalizeArgs(raw) {
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (!text) throw new Error('full-delivery: `args` is an empty string.')
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (e) {
      throw new Error(`full-delivery: \`args\` is a string that is not valid JSON (${e.message}). Pass args as a JSON object with: ${REQUIRED_ARGS.join(', ')}.`)
    }
    return normalizeArgs(parsed)
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`full-delivery: \`args\` is ${raw === null ? 'null' : Array.isArray(raw) ? 'an array' : typeof raw} — expected an object with: ${REQUIRED_ARGS.join(', ')}.`)
  }
  const bad = REQUIRED_ARGS.filter((k) => typeof raw[k] !== 'string' || !raw[k].trim() || raw[k].trim() === 'undefined')
  if (bad.length) {
    throw new Error(`full-delivery: missing or invalid required args: ${bad.join(', ')}. Each must be a non-empty string. (skillDir = absolute path to the execute-dynamic-workflow skill directory — its scripts/ are used at phase boundaries.)`)
  }
  return raw
}

const ARGS = normalizeArgs(typeof args === 'undefined' ? undefined : args)

// ============================== Configuration ==============================
// Model map per task difficulty. Codex model names and effort values must come
// from the codex-mcp skill's verified tables. The Anthropic column is the
// fallback when the Codex MCP is unavailable or failing.
// Implementation is NEVER high-complexity — hard problems are handled by
// expensive planning/elaboration up front and expensive review behind.
// Subtle tasks get difficulty=average plus risk=high (two reviewers).
const MODELS = {
  simple: { codex: { model: 'gpt-5.6-luna', effort: 'low' }, anthropic: { model: 'haiku', effort: 'medium' } },
  average: { codex: { model: 'gpt-5.6-terra', effort: 'medium' }, anthropic: { model: 'sonnet', effort: 'medium' } },
}
// Escalation tier: the second review-fix cycle gets a FRESH session on this —
// same-session retries that failed once tend to repeat their misunderstanding.
const MODEL_ESCALATED = { codex: { model: 'gpt-5.6-terra', effort: 'high' }, anthropic: { model: 'sonnet', effort: 'high' } }
const REVIEW_TASK_CODEX = { model: 'gpt-5.6-sol', effort: 'high' }   // cross-model 2nd reviewer on risk=high tasks
const REVIEW_DEEP_CODEX = { model: 'gpt-5.6-sol', effort: 'xhigh' }  // plan review + final sweeps
// Effort for Anthropic-side deep-thinking roles. 'xhigh' is only accepted when
// thinking is enabled on the session's model; 'high' is safe everywhere.
const DEEP_EFFORT = 'high'
const MAX_FIX_CYCLES = 2      // per-task review→fix cycles (cycle 2 escalates)
const MAX_CHECK_ROUNDS = 3    // phase-boundary fix rounds
const MAX_CI_ROUNDS = 3       // CI fix rounds
const MAX_PLAN_REVIEW_CYCLES = 2
const PR_WATCH_ROUNDS = 4     // comment sweeps after CI settles (GitHub has no push channel)
const PR_WATCH_INTERVAL_S = 90 // ≥ GitHub's X-Poll-Interval floor (60s)

// Every task implements in its own git worktree on a short-lived task branch —
// no shared index, no file locks, waves bounded only by true dependencies.
// All worktrees live under one sweepable root, sibling to the repo.
const WT_BASE = `${ARGS.repoRoot}.worktrees`
const wtPath = (taskId) => `${WT_BASE}/${String(taskId).replace(/[^a-zA-Z0-9._-]/g, '_')}`
const wtBranch = (taskId) => `task/${String(taskId).replace(/[^a-zA-Z0-9._/-]/g, '_')}`

// ============================== Schemas ==============================
const STR_ARR = { type: 'array', items: { type: 'string' } }
const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    preface: { type: 'string' },
    phases: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' }, name: { type: 'string' }, slug: { type: 'string' },
          goal: { type: 'string' }, ears: STR_ARR, deps: { type: 'array', items: { type: 'integer' } },
        },
        required: ['id', 'name', 'slug', 'goal'],
      },
    },
    checks: STR_ARR,
    idPattern: { type: 'string' },  // extended-regex for the spec's requirement-id scheme, for the vocab scan
    flags: STR_ARR,
    status: { enum: ['DONE', 'NEEDS_CONTEXT'] },
    questions: STR_ARR,
  },
  required: ['status'],
}
const TASKS_SCHEMA = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' }, title: { type: 'string' },
          difficulty: { enum: ['simple', 'average'] },
          risk: { enum: ['mechanical', 'standard', 'high'] },
          files: STR_ARR, deps: STR_ARR, ears: STR_ARR, refs: STR_ARR,
          context: { type: 'string' }, tests: STR_ARR, verify: STR_ARR,
        },
        required: ['id', 'title', 'difficulty', 'risk', 'files', 'deps', 'context'],
      },
    },
    needsReelaboration: { type: 'boolean' },
    phaseNotes: STR_ARR,
    flags: STR_ARR,
  },
  required: ['tasks'],
}
const RUNNER_SCHEMA = {
  type: 'object',
  properties: {
    status: { enum: ['DONE', 'DONE_WITH_CONCERNS', 'BLOCKED', 'CODEX_UNAVAILABLE'] },
    threadId: { type: 'string' }, commits: STR_ARR, filesChanged: STR_ARR,
    summary: { type: 'string' }, concerns: { type: 'string' },
  },
  required: ['status', 'summary'],
}
const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { enum: ['PASS', 'ISSUES'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { enum: ['CRITICAL', 'MAJOR', 'MINOR'] },
          file: { type: 'string' }, summary: { type: 'string' },
          scenario: { type: 'string' }, requirement: { type: 'string' },
        },
        required: ['severity', 'summary'],
      },
    },
    threadId: { type: 'string' },
    codexUnavailable: { type: 'boolean' },
  },
  required: ['verdict', 'findings'],
}
const CHECKS_SCHEMA = {
  type: 'object',
  properties: {
    green: { type: 'boolean' },
    groups: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' }, summary: { type: 'string' },
          commands: STR_ARR, files: STR_ARR,
        },
        required: ['name', 'summary'],
      },
    },
    notes: { type: 'string' },
  },
  required: ['green', 'groups'],
}
const INTEGRATE_SCHEMA = {
  type: 'object',
  properties: {
    merged: STR_ARR,     // task ids merged cleanly (or after conflict resolution)
    failed: STR_ARR,     // task ids whose branch could not be integrated
    notes: { type: 'string' },
  },
  required: ['merged', 'failed'],
}
const PR_SCHEMA = {
  type: 'object',
  properties: { url: { type: 'string' }, notes: { type: 'string' } },
  required: ['url'],
}
const COMMENTS_SCHEMA = {
  type: 'object',
  properties: {
    comments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },            // numeric comment id (for replies)
          threadId: { type: 'string' },       // GraphQL PRRT_ node id (for resolving)
          author: { type: 'string' },
          isBot: { type: 'boolean' },
          path: { type: 'string' },
          body: { type: 'string' },
          disposition: { enum: ['fix', 'reply', 'escalate'] },
          rationale: { type: 'string' },
        },
        required: ['id', 'author', 'body', 'disposition'],
      },
    },
    notes: { type: 'string' },
  },
  required: ['comments'],
}
const RETRO_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    substantialDrift: { type: 'boolean' },
    driftNotes: { type: 'string' },
    lessons: STR_ARR,
  },
  required: ['summary', 'substantialDrift'],
}

// ============================== State ==============================
const flags = []           // issues to surface at the end — never stop for them
const phaseSummaries = []  // one paragraph per completed phase, fed to next elaboration
const boundaryResults = [] // {phase, green} per phase boundary — reported honestly at the end
const lessons = []         // distilled cross-phase guidance, grows at phase boundaries
const retroSignals = []    // raw correction signals for the current phase, reset each phase
let codexFailures = 0
let codexHealthy = true
let preface = ''
let ciGreen = false
let idPattern = ''         // spec requirement-id regex for the vocab scan
let worktreesUsed = false  // gate the final sweep on whether any were created

// ============================== Prompts ==============================
// Iron laws — stated first in every implementer prompt. Violations are review
// blockers and boundary-gate failures, not style notes.
const ironLaws = `## Iron laws (violations block the phase)
- NEVER put plan vocabulary in code, tests, identifiers, comments, or commit messages: no requirement ids, no EARS ids, no phase/task numbers, no "per the plan/spec". A deterministic scan runs at the phase boundary and the phase cannot close while it hits.
- NEVER write a test that can't fail for a real bug: no file-existence, symbol-name, or module-structure assertions; no asserting a mock returned its configured value; no bare "does not throw" with no state/output validation.
- NEVER commit scratch code, debug scripts, or one-off verification — observations go in your report; throwaway checks live in the plan's verify commands.`

const implRules = `${ironLaws}

## Implementer rules
- Write complete, working code — no stubs, no placeholders, no TODO paths.
- Write every listed test, plus any needed to pin behavior you added — durable behavioral tests only. Write them; do NOT run them.
- Do not run build, test, lint, format, or typecheck commands, and do not start dev servers. Verification happens at the phase boundary.
- You own your worktree exclusively — edit freely within your task's scope, but stay within it: your diff is reviewed against the task, and out-of-scope edits become merge conflicts at integration.
- Git: commit your work on the current branch with plain "git add <your files>" + "git commit -m '<plain-English behavior summary>'". No stash, rebase, amend, checkout, or branch commands.
- If you need a paragraph-long comment to justify a workaround, the code is wrong — fix the code.
- If you cannot proceed without an architectural decision or missing information, stop and report BLOCKED with the specific question. Bad work is worse than no work.
Report: status, commit sha(s), files changed, concerns.`

function taskBlock(t, cwd) {
  return [
    `## Task: ${t.title}`,
    `Your worktree (work ONLY here): ${cwd}`,
    `Files in scope: ${t.files.join(', ')}`,
    t.ears && t.ears.length ? `Requirements this task must satisfy:\n${t.ears.map((e) => `- ${e}`).join('\n')}` : '',
    t.refs && t.refs.length ? `References (read these; do not search the repo):\n${t.refs.map((r) => `- ${r}`).join('\n')}` : '',
    `Context: ${t.context}`,
    t.tests && t.tests.length ? `Tests to write (write, do NOT run):\n${t.tests.map((x) => `- ${x}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n')
}

// Appended AFTER the preface in prompts: the preface stays a byte-identical
// cache-friendly prefix, and this block only changes at phase boundaries.
function lessonsBlock() {
  return lessons.length ? `\n\n## Lessons from earlier phases (binding — follow these)\n${lessons.map((l) => `- ${l}`).join('\n')}` : ''
}

const adversarialInline = `Adversarially review this change with a clean eye. Assume the code is wrong and try to prove it. Priorities: (1) for each requirement listed, locate the exact code satisfying it and a test that would catch its removal — missing either is CRITICAL; (2) correctness under hostile inputs — boundaries, error paths, concurrency, cleanup, eager-vs-lazy; (3) plan vocabulary leaking into code, tests, comments, or commit messages (requirement ids, phase/task references) — MAJOR, always; (4) test quality: for each new test ask what realistic bug would make it fail and whether a valid refactor would break it — a test with no answer to the first or "yes" to the second is a finding; mock-echo assertions, bare does-not-throw, and tests reimplementing production logic are findings; (5) paragraph-long justification comments mean the code is wrong; (6) stubs and swallowed errors. Ignore style/formatting (CI owns those). Report only findings you can anchor to a file and a concrete failure scenario, each with severity CRITICAL|MAJOR|MINOR. Verdict PASS or ISSUES (MINOR-only is PASS).`

// ============================== Codex relay ==============================
// Codex invocation follows the codex-mcp skill: workspace-write + network,
// writable_roots pointing at the MAIN repo's .git (correct for worktrees too),
// approval-policy never, cwd = the checkout the session owns. The relay agent
// is a thin generic agent — the full briefing is embedded in its prompt.
function codexConfig(m) {
  return JSON.stringify({
    model_reasoning_effort: m.effort,
    sandbox_workspace_write: { network_access: true, writable_roots: [`${ARGS.repoRoot}/.git`] },
  })
}

function relayBriefing(m, sandbox, cwd, prompt, threadId, label, reviewMode) {
  const logName = (label || 'codex').replace(/[^a-zA-Z0-9._-]/g, '_')
  const report = reviewMode
    ? `Report through the structured output: verdict PASS|ISSUES (map Codex's review honestly — ambiguity about whether an issue is real means it IS a finding; never infer a verdict Codex didn't state), one findings entry per defect (severity/file/summary/scenario), threadId, and codexUnavailable=true (verdict PASS, empty findings) ONLY if the Codex call failed after the retry.`
    : `Report through the structured output: status DONE|DONE_WITH_CONCERNS|BLOCKED|CODEX_UNAVAILABLE (map Codex's self-reported outcome honestly — "could not finish" or a blocking question is BLOCKED, not DONE), threadId, commits, filesChanged, summary (Codex's report condensed to substance), concerns.`
  return [
    `You are a Codex session runner — a thin relay. You never write code or run repo commands yourself; the single exception is writing the run log, which is required.`,
    `1. ToolSearch \`select:mcp__codex__codex,mcp__codex__codex-reply\`.`,
    `2. THREAD is "${threadId || 'new'}". If "new", call mcp__codex__codex with: prompt = everything after the PROMPT: line, verbatim (do not summarize, reorder, or annotate); model ${m.model}; sandbox ${sandbox}; approval-policy never; cwd ${cwd}; config ${codexConfig(m)}. Otherwise call mcp__codex__codex-reply with threadId THREAD and that prompt.`,
    `3. Capture threadId from the result.`,
    `4. Write the run log to ${ARGS.planDir}runs/${logName}.md (create parent dirs; if it exists, append after a --- separator): the config used, the threadId, the full PROMPT verbatim, and Codex's complete final response verbatim — not your summary. Codex's inner transcript is retrievable from ~/.codex/sessions/ by threadId.`,
    `5. If the Codex call errors, retry once with identical parameters. If it errors again, report CODEX_UNAVAILABLE with the literal error text. Do not attempt the work yourself.`,
    report,
    `PROMPT:`,
    prompt,
  ].join('\n')
}

function codexFailed() {
  codexFailures += 1
  if (codexFailures >= 2 && codexHealthy) {
    codexHealthy = false
    flags.push('Codex MCP marked unhealthy after repeated failures — remaining work ran on Anthropic fallback models')
    log('Codex unavailable twice — falling back to Anthropic models for the rest of the run')
  }
}

async function runCodex(m, cwd, prompt, opts, threadId) {
  if (!codexHealthy) return null
  const r = await agent(relayBriefing(m, 'workspace-write', cwd, prompt, threadId, opts && opts.label, false), {
    model: 'haiku', schema: RUNNER_SCHEMA, ...opts,
  })
  if (!r || r.status === 'CODEX_UNAVAILABLE') { codexFailed(); return null }
  return r
}

async function runCodexReview(m, prompt, opts, threadId) {
  if (!codexHealthy) return null
  const r = await agent(relayBriefing(m, 'read-only', ARGS.repoRoot, prompt, threadId, opts && opts.label, true), {
    model: 'haiku', schema: REVIEW_SCHEMA, ...opts,
  })
  if (!r || r.codexUnavailable) { codexFailed(); return null }
  return r
}

// cwd: the checkout this session owns — a task worktree during phases, the
// main checkout for boundary/CI/sweep fixes.
async function implement(models, cwd, prompt, opts, threadId) {
  const viaCodex = await runCodex(models.codex, cwd, prompt, opts, threadId)
  if (viaCodex) return { engine: 'codex', ...viaCodex }
  const r = await agent(`${prompt}\n\nWork in ${cwd}.`, {
    model: models.anthropic.model, effort: models.anthropic.effort, schema: RUNNER_SCHEMA, ...opts,
  })
  return r ? { engine: 'anthropic', ...r } : null
}

function recordResult(task, r) {
  if (!r || r.status === 'BLOCKED') {
    flags.push(`Task ${task.id} (${task.title}) ended BLOCKED: ${r ? r.summary : 'agent died'}`)
    log(`  ✗ ${task.id} ${task.title} — BLOCKED: ${r ? firstSentence(r.summary, 110) : 'agent died'}`)
    return false
  }
  if (r.status === 'DONE_WITH_CONCERNS' && r.concerns) flags.push(`Task ${task.id} concern: ${r.concerns}`)
  return true
}

function firstSentence(text, max) {
  if (!text) return ''
  const clean = String(text).replace(/\s+/g, ' ').trim()
  const cut = clean.indexOf('. ')
  const s = cut > 0 && cut < max ? clean.slice(0, cut) : clean
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function narrateTask(task, impl, verdict) {
  const what = firstSentence(impl && impl.summary, 100) || task.title
  const n = (impl && impl.filesChanged && impl.filesChanged.length) || (task.files && task.files.length) || 0
  const eng = impl && impl.engine === 'anthropic' ? ', claude' : ''
  log(`  ✓ ${task.id} ${what} (${n} file${n === 1 ? '' : 's'}${eng})${verdict ? ` — review ${verdict}` : ''}`)
}

// ============================== Tasks ==============================
// Returns 'DONE' or 'FAILED'. FAILED means dependents must not build on this
// task, and its branch is discarded at integration.
async function runTask(task, phaseLabel) {
  const cwd = wtPath(task.id)
  const models = MODELS[task.difficulty] || MODELS.average
  const prompt = `${preface}${lessonsBlock()}\n\n${taskBlock(task, cwd)}\n\n${implRules}`
  let impl = await implement(models, cwd, prompt, { label: `impl:${task.id}`, phase: phaseLabel })
  if (!recordResult(task, impl)) return 'FAILED'

  const nReviewers = task.risk === 'high' ? 2 : task.risk === 'standard' ? 1 : 0
  if (nReviewers === 0) { narrateTask(task, impl, null); return 'DONE' }

  // Reviewers run against the task branch from the MAIN checkout (branches
  // share the object database) with a clean context per task — never the
  // implementer's session, never reused across tasks.
  const reviewBody = () => `${preface}${lessonsBlock()}\n\nReview the implementation of: ${task.title}\nIn ${ARGS.repoRoot}, the change is the diff ${ARGS.branch}...${wtBranch(task.id)} (commits: ${(impl.commits || []).join(', ') || 'all commits on the task branch'}).\nRequirements:\n${(task.ears || []).map((e) => `- ${e}`).join('\n') || '- n/a'}\nTask context: ${task.context}`

  let priorFindings = null
  let codexReviewId = null
  for (let cycle = 0; cycle <= MAX_FIX_CYCLES; cycle++) {
    const recheck = priorFindings
      ? `\n\nA fix was applied (commits: ${(impl.commits || []).join(', ') || 'latest on the task branch'}). Verify each previous finding below is actually resolved, and that the fix introduced no new CRITICAL defect. Do not re-litigate areas that already passed.\nPrevious findings:\n${priorFindings.map((f) => `- [${f.severity}] ${f.summary}`).join('\n')}`
      : ''
    const reviewers = [() => agent(reviewBody() + recheck, {
      agentType: 'code-factory:adversarial-reviewer', model: 'opus', effort: 'high',
      schema: REVIEW_SCHEMA, label: `review:${task.id}`, phase: phaseLabel,
    })]
    if (nReviewers === 2) {
      reviewers.push(async () => {
        const r = await runCodexReview(REVIEW_TASK_CODEX,
          codexReviewId ? reviewBody() + recheck : `${reviewBody()}\n\n${adversarialInline}`,
          { label: `review-x:${task.id}`, phase: phaseLabel }, codexReviewId)
        if (r) { codexReviewId = r.threadId || codexReviewId; return r }
        return agent(`${reviewBody() + recheck}\n\nTake a security-and-data-integrity lens in addition to correctness.`, {
          agentType: 'code-factory:adversarial-reviewer', model: 'opus', effort: 'high',
          schema: REVIEW_SCHEMA, label: `review-x:${task.id}`, phase: phaseLabel,
        })
      })
    }
    // A dead reviewer must not pass the gate: retry once, then flag honestly.
    let results = (await parallel(reviewers)).filter(Boolean)
    if (!results.length) results = (await parallel(reviewers)).filter(Boolean)
    if (!results.length) {
      flags.push(`Task ${task.id}: review gate UNVERIFIED — all reviewers failed twice`)
      return 'DONE'
    }
    if (results.length < nReviewers) flags.push(`Task ${task.id}: only ${results.length}/${nReviewers} reviewers returned`)
    const findings = results.flatMap((x) => x.findings || []).filter((f) => f.severity !== 'MINOR')
    if (!results.some((x) => x.verdict === 'ISSUES') || !findings.length) {
      narrateTask(task, impl, cycle === 0 ? 'PASS' : 'PASS after fixes')
      return 'DONE'
    }
    findings.forEach((f) => retroSignals.push(`review ${task.id}: [${f.severity}] ${f.summary}`))

    if (cycle === MAX_FIX_CYCLES) {
      flags.push(`Task ${task.id}: unresolved review findings after ${MAX_FIX_CYCLES} fix cycles: ${findings.map((f) => `[${f.severity}] ${f.summary}`).join('; ')}`)
      const worst = findings.some((f) => f.severity === 'CRITICAL') ? 'FAILED' : 'DONE'
      log(`  ${worst === 'FAILED' ? '✗' : '!'} ${task.id} ${task.title} — ${findings.length} unresolved finding(s): ${firstSentence(findings[0].summary, 90)}`)
      return worst
    }
    priorFindings = findings
    const fixPrompt = `An independent review of your work on "${task.title}" found issues. Resolve every finding, or state precisely why one is wrong instead of changing code. Make one additional commit.\n\nFindings:\n${findings.map((f) => `- [${f.severity}] ${f.file || ''} ${f.summary}${f.scenario ? ` | Scenario: ${f.scenario}` : ''}`).join('\n')}\n\n${implRules}`
    if (cycle === 0 && impl.engine === 'codex' && impl.threadId) {
      // Cycle 1: continue the implementer's own session — it has the context.
      log(`  ↻ ${task.id} review found ${findings.length} issue(s): ${firstSentence(findings[0].summary, 90)} — fixing (same session)`)
      impl = await implement(models, cwd, fixPrompt, { label: `fix:${task.id}`, phase: phaseLabel }, impl.threadId)
    } else {
      // Cycle 2 (or non-resumable session): a FRESH session on the escalated
      // tier — a session that failed to fix once tends to repeat its
      // misunderstanding; a clean look on a stronger config breaks the loop.
      log(`  ↻ ${task.id} review still failing — fresh escalated implementer`)
      impl = await implement(MODEL_ESCALATED, cwd, `${preface}${lessonsBlock()}\n\n${taskBlock(task, cwd)}\n\nThe work is already implemented on this branch but an independent review found unresolved issues. Read the existing diff first, then:\n\n${fixPrompt}`, { label: `fix2:${task.id}`, phase: phaseLabel })
    }
    if (!recordResult(task, impl)) return 'FAILED'
  }
  return 'DONE'
}

// Wave scheduler: waves are bounded ONLY by dependencies — worktree isolation
// removed the file-lock constraint. Failed tasks propagate: dependents are
// skipped, never run on top of missing or review-rejected work.
async function runPhaseTasks(tasks, phaseLabel) {
  const done = new Set()
  const failed = new Set()
  let pending = [...tasks]
  while (pending.length) {
    let dropped = true
    while (dropped) {
      dropped = false
      for (const t of [...pending]) {
        if (t.deps.some((d) => failed.has(d))) {
          failed.add(t.id)
          flags.push(`Task ${t.id} (${t.title}) skipped: depends on a failed task`)
          pending = pending.filter((x) => x.id !== t.id)
          dropped = true
        }
      }
    }
    if (!pending.length) break
    const wave = pending.filter((t) => t.deps.every((d) => done.has(d)))
    if (!wave.length) {
      flags.push(`Dependency deadlock in ${phaseLabel}; skipped tasks: ${pending.map((t) => t.id).join(', ')}`)
      return
    }

    // Wave setup: one cheap agent creates every worktree. Self-healing — a
    // path left behind by a crashed run is removed and recreated.
    worktreesUsed = true
    const setup = await agent(
      `In ${ARGS.repoRoot}, create one git worktree per task, each on a fresh branch from ${ARGS.branch}:\n${wave.map((t) => `- git worktree add "${wtPath(t.id)}" -b "${wtBranch(t.id)}" ${ARGS.branch}`).join('\n')}\nIf a worktree path already exists (crashed prior run), first: git worktree remove --force "<path>" and git branch -D "<branch>" (ignore errors), then create it. Create the parent directory ${WT_BASE} if missing. Report "ready" plus any task id whose worktree could not be created.`,
      { model: 'haiku', effort: 'low', label: 'worktrees:setup', phase: phaseLabel },
    )
    if (!setup) { flags.push(`${phaseLabel}: worktree setup agent died — wave skipped`); wave.forEach((t) => failed.add(t.id)); pending = pending.filter((t) => !failed.has(t.id)); continue }

    log(`${phaseLabel}: starting ${wave.length} task(s) in parallel worktrees — ${wave.map((t) => t.title).join('; ')}`)
    const results = await parallel(wave.map((t) => () => runTask(t, phaseLabel)))
    const merged = wave.filter((t, i) => results[i] === 'DONE')
    const discarded = wave.filter((t, i) => results[i] !== 'DONE')

    // Integration owns cleanup: every task branch is merged-or-discarded AND
    // its worktree removed in the same step, so worktrees never outlive their
    // task. Dependency order within the wave; conflicts are resolved by the
    // integrator (it has both diffs), unresolvable ones fail the task.
    const integ = await agent(
      `In ${ARGS.repoRoot} on branch ${ARGS.branch} (git checkout ${ARGS.branch} first), integrate this wave of task branches.\n\nMerge IN THIS ORDER (dependency order):\n${merged.map((t) => `- ${t.id}: git merge --no-ff "${wtBranch(t.id)}" -m "merge: ${t.title.replace(/"/g, "'")}"`).join('\n') || '- (none to merge)'}\n\nOn a merge conflict: resolve it yourself — read both sides, keep BOTH tasks' intended behavior, stage, and complete the merge with the same message. Only if the two changes are fundamentally incompatible: git merge --abort and report that task id under failed.\n\nAfter each task branch is merged, immediately clean it up: git worktree remove --force "<its worktree path>" then git branch -D "<its branch>". For these failed/blocked tasks, remove the worktree the same way WITHOUT merging, but RENAME the branch to "salvage/<id>" instead of deleting it — work that failed review is usually mostly right and must stay recoverable: ${discarded.map((t) => `${t.id} (${wtPath(t.id)}, ${wtBranch(t.id)})`).join('; ') || '(none)'}.\n\nWorktree paths: ${merged.concat(discarded).map((t) => `${t.id} → ${wtPath(t.id)}`).join('; ')}\nFinish with: git worktree prune. Report merged ids and failed ids.`,
      { model: 'sonnet', effort: 'medium', schema: INTEGRATE_SCHEMA, label: 'worktrees:integrate', phase: phaseLabel },
    )
    if (!integ) {
      flags.push(`${phaseLabel}: integration agent died — wave's branches left unmerged; run the worktree sweep and inspect task/* branches manually`)
      wave.forEach((t) => failed.add(t.id))
    } else {
      const mergedIds = new Set(integ.merged || [])
      for (const t of merged) {
        if (mergedIds.has(t.id)) done.add(t.id)
        else { failed.add(t.id); flags.push(`Task ${t.id} (${t.title}) failed integration: ${firstSentence(integ.notes, 140) || 'merge conflict unresolvable'}`) }
      }
      discarded.forEach((t) => failed.add(t.id))
    }
    pending = pending.filter((t) => !done.has(t.id) && !failed.has(t.id))
    log(`${phaseLabel}: ${done.size}/${tasks.length} tasks integrated${failed.size ? `, ${failed.size} failed/skipped` : ''}`)
  }
}

// ============================== Boundary ==============================
// Returns true only when hygiene AND the full suite are confirmed green.
async function boundary(phaseLabel, checks) {
  // Hygiene opens the boundary: the deterministic plan-vocabulary scan plus a
  // scaffolding-test sweep. The scan script is the gate; the agent's job is
  // stripping what it reports. Mechanical work — cheap model.
  let hygieneGreen = false
  for (let round = 1; round <= 2 && !hygieneGreen; round++) {
    const hygiene = await agent(
      `Hygiene pass in ${ARGS.repoRoot} on branch ${ARGS.branch}.\n1. Run: bash "${ARGS.skillDir}/scripts/scan-plan-vocab.sh" "${ARGS.repoRoot}" "${ARGS.baseBranch}"${idPattern ? ` "${idPattern}"` : ''}\n   If it reports hits, strip or rename every one so the code reads as if the plan never existed, then re-run it until it prints "clean".\n2. In test files changed on this branch, delete tests that assert file existence, symbol names, module structure, empty stubs, or that a mock returns its configured value — unless deletion would leave spec behavior uncovered, in which case rewrite as a behavioral test.\nCommit if any files changed (plain git add/commit, message describes the behavior change). Report "clean" only if the scan's final run printed clean; otherwise report the remaining hits.`,
      { model: 'haiku', effort: 'medium', phase: phaseLabel, label: `hygiene:r${round}` },
    )
    hygieneGreen = !!hygiene && /\bclean\b/i.test(String(hygiene))
  }
  if (!hygieneGreen) flags.push(`${phaseLabel}: plan-vocabulary/hygiene scan NOT confirmed clean`)

  for (let round = 1; ; round++) {
    const check = await agent(
      `Run the full check suite from ${ARGS.repoRoot}, in order:\n${checks.map((c) => `- ${c}`).join('\n')}\nRun every command even if an earlier one fails. Capture failures verbatim. Then group them so independent fixers can work in parallel WITHOUT touching the same files: failures sharing a root cause (e.g. dozens of type errors from one changed signature) are ONE group; failures in different packages/subsystems are separate groups. For each group report: name, failing commands, implicated files, and a summary with the key error output. Fix nothing. green=true only if every command passed.`,
      { model: 'haiku', effort: 'medium', schema: CHECKS_SCHEMA, label: `checks:r${round}`, phase: phaseLabel },
    )
    if (!check) { flags.push(`${phaseLabel}: check agent died — checks UNVERIFIED`); return false }
    if (check.green) {
      log(`${phaseLabel}: ✓ all checks green${round > 1 ? ` after ${round - 1} fix round(s)` : ''}`)
      return hygieneGreen
    }
    if (round > MAX_CHECK_ROUNDS) {
      flags.push(`${phaseLabel}: checks still failing after ${MAX_CHECK_ROUNDS} fix rounds: ${check.groups.map((g) => g.name).join(', ')}`)
      return false
    }
    check.groups.forEach((g) => retroSignals.push(`checks: ${g.name} — ${(g.summary || '').slice(0, 200)}`))
    log(`${phaseLabel}: checks red — fixing ${check.groups.length} group(s): ${check.groups.map((g) => `${g.name} (${firstSentence(g.summary, 60)})`).join('; ')}`)
    // Boundary fixers work directly in the main checkout — sequential with the
    // check loop, and the failure groups are disjoint by construction.
    await parallel(check.groups.map((g) => () => (async () => {
      const p = `${preface}${lessonsBlock()}\n\nFix this group of failing checks. You may run ONLY the specific failing commands listed while iterating — never the full suite.\nGroup: ${g.name}\nCommands: ${(g.commands || []).join('; ')}\nImplicated files: ${(g.files || []).join(', ')}\nFailure summary:\n${g.summary}\n\nFind root causes — no test deletion, no assertion weakening, no skips. Commit with plain git add/commit. ${ironLaws}`
      const r = await implement(MODELS.average, ARGS.repoRoot, p, { label: `fixer:${g.name}`, phase: phaseLabel })
      if (!r || r.status === 'BLOCKED') flags.push(`${phaseLabel}: fixer for "${g.name}" blocked: ${r ? r.summary : 'agent died'}`)
    })()))
  }
}

// ============================== Phase: Plan ==============================
phase('Plan')

const approvalDoc = `${ARGS.planDir}approval.md`
const approvalTask = `Finally, write the developer's approval briefing to ${approvalDoc} (clean, scannable markdown — headers, tables, short bullets, no filler):\n1. High-level summary: what will be built, on branch ${ARGS.branch} → PR "${ARGS.prTitle}".\n2. Per phase in order: name, goal, EARS requirements covered, and the 3-5 MOST IMPORTANT verifications that will prove the phase worked at its boundary. Synthesize these from the phase goal, the Checks commands, and the spec's acceptance criteria — each concrete and checkable; "all tests pass" is banned.\n3. The full check suite that runs at every boundary.\n4. Assumptions you made and anything you flagged.`

log('Planning: branch setup, codebase exploration, plan directory')
let plan = await agent(
  `Spec path: ${ARGS.specPath}\nOutput directory: ${ARGS.planDir}\nRepo root: ${ARGS.repoRoot}\nBase branch: ${ARGS.baseBranch}\nWork branch: ${ARGS.branch}\n${ARGS.clarifications ? `\nClarifications from the developer (answers to earlier questions — treat as authoritative):\n${ARGS.clarifications}\n` : ''}\nFIRST, set up the branch: verify the working tree is clean (git status). If it is dirty, STOP — return status NEEDS_CONTEXT with a question naming the uncommitted files; do not plan. Otherwise fetch origin and create/check out ${ARGS.branch} from ${ARGS.baseBranch} (check it out if it already exists), then confirm you are on ${ARGS.branch} before exploring.\n\nTHEN produce the plan directory per your instructions (plan.md, preface.md, phases/*.md, empty tasks/).\n\nAlso return idPattern: an extended-regex matching the spec's requirement-id scheme (e.g. "REQ-[0-9]+"), used by the boundary scan that keeps requirement ids out of code; empty string if the spec has no id scheme.\n\n${approvalTask}\n\nReturn the structured summary. If the spec is too ambiguous to phase, return NEEDS_CONTEXT with questions.`,
  { agentType: 'code-factory:workflow-planner', effort: DEEP_EFFORT, schema: PLAN_SCHEMA, phase: 'Plan', label: 'planner' },
)
const planIncomplete = (p) => !p || p.status !== 'DONE' || !p.preface || !p.phases || !p.phases.length || !p.checks || !p.checks.length
if (planIncomplete(plan)) {
  // Only a planner that RAN and asked real questions means the spec was
  // ambiguous — that one is fixed with ARGS.clarifications. A planner that
  // died or returned garbage is a run failure with its own outcome.
  const askedQuestions = plan && plan.status === 'NEEDS_CONTEXT' && plan.questions && plan.questions.length
  if (!askedQuestions) {
    return {
      outcome: 'PLANNER_FAILED',
      detail: !plan
        ? 'planner agent returned nothing (died, errored, or was rejected by the API before producing output)'
        : `planner returned an unusable plan (status=${plan.status || 'none'}, phases=${plan.phases ? plan.phases.length : 0}, checks=${plan.checks ? plan.checks.length : 0}, preface=${plan.preface ? 'present' : 'missing'})`,
      planDir: ARGS.planDir,
      flags,
    }
  }
  return { outcome: 'NEEDS_CONTEXT', questions: plan.questions, flags }
}
preface = plan.preface
idPattern = plan.idPattern || ''
if (plan.flags) flags.push(...plan.flags)

for (let cycle = 1; cycle <= MAX_PLAN_REVIEW_CYCLES; cycle++) {
  const planReviewPrompt = `Adversarially review the work plan in ${ARGS.planDir} against the spec at ${ARGS.specPath}. Assume the plan is wrong; attack: EARS requirements missing from the coverage matrix or double-assigned; phase seams that leave work unowned or owned twice; dependency errors between phases; phases that cannot be verified by the Checks commands; codebase claims that contradict the actual repo (read the files). Severity CRITICAL|MAJOR|MINOR per finding; verdict PASS or ISSUES (MINOR-only is PASS).`
  let review = await runCodexReview(REVIEW_DEEP_CODEX, planReviewPrompt, { label: 'plan-review', phase: 'Plan' })
  if (!review) review = await agent(planReviewPrompt, { agentType: 'code-factory:adversarial-reviewer', model: 'opus', effort: DEEP_EFFORT, schema: REVIEW_SCHEMA, label: 'plan-review', phase: 'Plan' })
  if (!review) { flags.push('Plan review gate UNVERIFIED — reviewer agents failed'); break }
  if (review.verdict === 'PASS') break
  log(`Plan review found issues (cycle ${cycle}) — dispatching planner fixes`)
  const fixed = await agent(
    `Fix mode. Plan directory: ${ARGS.planDir}. Spec: ${ARGS.specPath}. Apply these adversarial review findings (or rebut with reasons):\n${review.findings.map((f) => `- [${f.severity}] ${f.summary}`).join('\n')}\nThen refresh ${approvalDoc} so the briefing matches the corrected plan.\nReturn the updated structured summary.`,
    { agentType: 'code-factory:workflow-planner', effort: DEEP_EFFORT, schema: PLAN_SCHEMA, phase: 'Plan', label: 'planner-fix' },
  )
  if (!planIncomplete(fixed)) { plan = fixed; preface = plan.preface; idPattern = plan.idPattern || idPattern }
  if (cycle === MAX_PLAN_REVIEW_CYCLES) flags.push('Plan review issues may remain after max fix cycles')
}
log(`Plan ready: ${plan.phases.length} phases`)

// ============================== Approval gate ==============================
// The one human checkpoint. First launch (no ARGS.approved) writes a markdown
// briefing and pauses. The relaunch with resumeFromRunId + approved:true
// replays everything above from cache.
if (!ARGS.approved) {
  return {
    outcome: 'AWAITING_APPROVAL',
    approvalDoc,
    planDir: ARGS.planDir,
    phases: plan.phases.map((p) => `${p.id}: ${p.name} — ${p.goal}`),
    flags,
  }
}
if (ARGS.feedback) {
  log('Applying plan feedback before implementation')
  const revised = await agent(
    `Fix mode. Plan directory: ${ARGS.planDir}. Spec: ${ARGS.specPath}. The developer reviewed the plan and gave this feedback — apply it (update plan.md / preface.md / phase sketches as needed), refresh ${approvalDoc} to match, and return the updated structured summary:\n${ARGS.feedback}`,
    { agentType: 'code-factory:workflow-planner', effort: DEEP_EFFORT, schema: PLAN_SCHEMA, phase: 'Plan', label: 'planner-feedback' },
  )
  if (planIncomplete(revised)) {
    return { outcome: 'FEEDBACK_FAILED', detail: revised && revised.questions ? revised.questions.join('; ') : 'planner could not apply the feedback', planDir: ARGS.planDir, flags }
  }
  plan = revised
  preface = plan.preface
  idPattern = plan.idPattern || idPattern
}

// ============================== Execution phases ==============================
// Elaboration is pipelined one phase ahead: phase N+1's elaborator runs while
// phase N implements; a drift check at the boundary triggers re-elaboration
// only when needed.
const NN = (id) => String(id).padStart(2, '0')

function elaborate(p, extraNote) {
  const landed = phaseSummaries.map((s) => `- ${s}`).join('\n') || '- nothing yet (first phase)'
  return agent(
    `Plan directory: ${ARGS.planDir}\nPhase id: ${p.id} (phases/${NN(p.id)}-${p.slug}.md)\nSpec: ${ARGS.specPath}\nRepo root: ${ARGS.repoRoot}\nWhat prior phases actually landed:\n${landed}${lessonsBlock()}${extraNote ? `\n\n${extraNote}` : ''}\n\nElaborate this phase per your instructions: verify assumptions, produce the task list, write tasks/*.md files, update the phase file and plan.md status. Bake the lessons above (if any) into task context and references so implementers cannot repeat those mistakes.`,
    { agentType: 'code-factory:dynamic-elaborator', effort: DEEP_EFFORT, schema: TASKS_SCHEMA, phase: `Phase ${p.id}: ${p.name}`, label: `elaborate:${p.id}` },
  )
}

function inFlightNote(p) {
  return `LOOKAHEAD MODE: Phase ${p.id} (${p.name}) is being implemented RIGHT NOW — its files are mid-flight; do not treat their current state as final. For what phase ${p.id} will produce, trust its task files (tasks/${NN(p.id)}-*.md) and its goal: ${p.goal} Verify only earlier phases' code against the tree. If your task list depends heavily on phase ${p.id}'s exact output shapes, set needsReelaboration=true so the orchestrator re-elaborates against the stable tree before executing.`
}

let lookahead = elaborate(plan.phases[0], null)
for (let i = 0; i < plan.phases.length; i++) {
  const p = plan.phases[i]
  const next = plan.phases[i + 1]
  const label = `Phase ${p.id}: ${p.name}`
  phase(label)
  retroSignals.length = 0
  const flagsBefore = flags.length
  let elaborated = await lookahead
  if (elaborated && elaborated.needsReelaboration) {
    log(`${label}: lookahead flagged dependency on in-flight work — re-elaborating against the stable tree`)
    elaborated = await elaborate(p, `RE-ELABORATION: your earlier lookahead pass flagged that this phase depends on the prior phase's exact output. The tree is now stable. Re-verify every assumption and overwrite the stale task files.`)
  }
  if (!elaborated || !elaborated.tasks || !elaborated.tasks.length) {
    flags.push(`${label}: elaboration failed or returned no tasks — phase skipped`)
    if (next) lookahead = elaborate(next, null)
    continue
  }
  if (elaborated.flags) flags.push(...elaborated.flags)
  const riskyCount = elaborated.tasks.filter((t) => t.risk === 'high').length
  log(`${label}: ${p.goal}`)
  log(`${label}: ${elaborated.tasks.length} task(s)${riskyCount ? `, ${riskyCount} high-risk (dual review)` : ''}${elaborated.phaseNotes && elaborated.phaseNotes.length ? ` — ${firstSentence(elaborated.phaseNotes[0], 120)}` : ''}`)

  // Start the next phase's elaboration now — it runs while this phase implements.
  if (next) lookahead = elaborate(next, inFlightNote(p))

  await runPhaseTasks(elaborated.tasks, label)

  const extraVerify = elaborated.tasks.flatMap((t) => t.verify || [])
  const green = await boundary(label, [...plan.checks, ...extraVerify])
  boundaryResults.push({ phase: label, green })

  // One phase-closing agent: reads the phase diff once and returns the landed
  // summary, the drift verdict, and the distilled lessons together. Its
  // progress.md entry is the run's recovery ledger — structured enough that a
  // resumed orchestrator (or a human) can re-derive exactly what is done.
  const newFlags = flags.slice(flagsBefore)
  const hasSignals = retroSignals.length || newFlags.length
  const summ = await agent(
    `In ${ARGS.repoRoot} on branch ${ARGS.branch}, review the git log/diff for the work just completed ("${p.name}") and close out the phase.\n\nPlanned tasks:\n${elaborated.tasks.map((t) => `- ${t.title} → ${t.files.join(', ')}`).join('\n')}\n\nFirst, append a section to ${ARGS.planDir}progress.md (create the file with an "# Progress" heading if missing): "## Phase ${p.id}: ${p.name}", then one line per planned task ("done: <title> → <files>" or "failed/skipped: <title> — <why>"), the boundary result (${green ? 'checks green' : 'CHECKS NOT GREEN'}), the last commit sha on the branch, and any lessons you distill below. This file is the run's recovery ledger — a resumed orchestrator must be able to tell from it exactly which phases and tasks are complete.\n\nThen return:\n1. summary: ≤120 words of plain prose on what actually landed — files created/modified, key interfaces.\n2. substantialDrift: true ONLY if files, interfaces, or contracts that LATER phases build on ended up different from the planned tasks above (renames, moved modules, changed signatures, dropped tasks). Routine fixes and internal details are not drift. Set driftNotes when true.${next && hasSignals ? `\n3. lessons: this phase's correction signals are below. Distill ONLY systemic, forward-applicable lessons — recurring coding-style/standards/convention violations or misused APIs that FUTURE tasks in this plan are likely to repeat. One-off bugs are not lessons; an empty list is a fine answer. Max 3, each a single imperative line an implementer can follow. Do NOT repeat or rephrase lessons already in force.\n\nCorrection signals:\n${retroSignals.map((s) => `- ${s}`).join('\n')}\n${newFlags.map((f) => `- flag: ${f}`).join('\n')}\n\nLessons already in force:\n${lessons.map((l) => `- ${l}`).join('\n') || '- none'}\n\nFor each NEW lesson that is really a standing project convention the preface should have stated, append it to ${ARGS.planDir}preface.md under a "## Learned during execution" section (create the section if missing). Append all new lessons, tagged with this phase's name, to ${ARGS.planDir}lessons.md.` : '\n3. lessons: return an empty array.'}`,
    { model: 'sonnet', effort: 'medium', schema: RETRO_SCHEMA, phase: label, label: `close:${p.id}` },
  )
  phaseSummaries.push(`Phase ${p.id} (${p.name}): ${summ ? summ.summary : p.goal}`)
  log(`${label} ${green ? 'complete' : 'complete (checks not green)'} — ${firstSentence(summ && summ.summary, 200) || p.goal}`)
  if (summ && summ.lessons && summ.lessons.length) {
    lessons.push(...summ.lessons)
    log(`${label}: learned — ${summ.lessons.join(' | ')}`)
  }

  if (next && summ && summ.substantialDrift) {
    log(`${label}: substantial drift from plan — re-elaborating next phase`)
    await lookahead // let the stale lookahead finish its file writes before overwriting
    lookahead = elaborate(next, `RE-ELABORATION: a lookahead elaboration already wrote tasks/${NN(next.id)}-*.md for this phase, but the just-finished phase drifted from plan: ${summ.driftNotes || 'see landed summary above'}. Re-verify against the now-stable working tree and overwrite the stale task files.`)
  }
}

// ============================== Phase: Deliver ==============================
phase('Deliver')

// Worktree sweep — the crash-safety backstop. Integration already removed
// every worktree it touched; this catches leftovers from died agents, failed
// waves, and resumed runs, so nothing under WT_BASE outlives the run.
if (worktreesUsed) {
  const swept = await agent(
    `In ${ARGS.repoRoot}: run git worktree prune. Then list any remaining worktrees under ${WT_BASE} (git worktree list) — for each: git worktree remove --force "<path>". Delete any remaining local branches matching task/* (git branch -D). Finally remove the directory ${WT_BASE} if it exists and is empty of worktrees. Report what you removed, or "clean".`,
    { model: 'haiku', effort: 'low', label: 'worktrees:sweep', phase: 'Deliver' },
  )
  if (!swept) flags.push(`Worktree sweep agent died — check ${WT_BASE} and task/* branches manually`)
}

log('Opening PR')
const pr = await agent(
  `In ${ARGS.repoRoot} on branch ${ARGS.branch}: push the branch and open a PR against ${ARGS.baseBranch} titled ${JSON.stringify(ARGS.prTitle)} using gh. PR body: short summary of the change, link to the spec at ${ARGS.specPath}, and this note verbatim if any items exist — "Flagged for human attention:" followed by these items:\n${flags.map((f) => `- ${f}`).join('\n') || '(none)'}\nEnd the body with the standard Claude Code attribution. Return the PR URL.`,
  { model: 'sonnet', effort: 'low', schema: PR_SCHEMA, phase: 'Deliver', label: 'open-pr' },
)
const prUrl = pr ? pr.url : null
if (!prUrl) flags.push('PR creation failed — branch is pushed or local; open PR manually')
else log(`PR open: ${prUrl}`)

log('Running final adversarial sweeps while CI runs')
const sweepDefs = [
  { key: 'quality', prompt: `Review the complete diff of branch ${ARGS.branch} against ${ARGS.baseBranch} in ${ARGS.repoRoot}. Hunt: dead code, low-value or dishonest tests (tests that can't fail for a real bug, mock-echo assertions, does-not-throw with no validation), duplicated logic that should merge, missing documentation where a maintainer needs it, poor naming, refactor opportunities that reduce net complexity, and any plan vocabulary (requirement ids, phase/task references) that survived the boundary scans. Anchor every finding to files. Severity CRITICAL|MAJOR|MINOR, verdict PASS or ISSUES.` },
  { key: 'compliance', prompt: `Review the complete diff of branch ${ARGS.branch} against ${ARGS.baseBranch} in ${ARGS.repoRoot}, against the spec at ${ARGS.specPath}. For EVERY EARS requirement: locate the implementing code and the test that would catch its removal. Also verify non-goals were not built and constraints were not broken. Missing implementation or test coverage for a requirement is CRITICAL. Severity per finding, verdict PASS or ISSUES.` },
]
const sweeps = await parallel(sweepDefs.map((s) => () => (async () => {
  const viaCodex = await runCodexReview(REVIEW_DEEP_CODEX, s.prompt, { label: `sweep:${s.key}`, phase: 'Deliver' })
  if (viaCodex) return { key: s.key, ...viaCodex }
  const r = await agent(s.prompt, { agentType: 'code-factory:adversarial-reviewer', model: 'opus', effort: DEEP_EFFORT, schema: REVIEW_SCHEMA, label: `sweep:${s.key}`, phase: 'Deliver' })
  return r ? { key: s.key, ...r } : null
})()))
sweepDefs.forEach((s, i) => { if (!sweeps[i]) flags.push(`Final ${s.key} sweep did not return — UNVERIFIED`) })
const sweepFindings = sweeps.filter(Boolean).flatMap((s) => (s.verdict === 'ISSUES' ? s.findings.map((f) => ({ ...f, sweep: s.key })) : []))
const actionable = sweepFindings.filter((f) => f.severity !== 'MINOR')
sweepFindings.filter((f) => f.severity === 'MINOR').forEach((f) => flags.push(`Final sweep (${f.sweep}, minor): ${f.summary}`))
if (!actionable.length) log(`Final sweeps: clean${sweepFindings.length ? ` (${sweepFindings.length} minor note(s))` : ''}`)
if (actionable.length) {
  log(`Final sweeps: fixing ${actionable.length} finding(s) — ${actionable.slice(0, 3).map((f) => `${f.sweep}: ${firstSentence(f.summary, 70)}`).join('; ')}`)
  const p = `${preface}${lessonsBlock()}\n\nFinal review of the full branch diff surfaced these findings. You own every file named in a finding, plus any test file covering it. Fix each finding or rebut with a precise reason. Do not run build/test/lint/format/typecheck commands. One commit per logical fix, plain git add/commit. Push when done.\n\n${ironLaws}\n\nFindings:\n${actionable.map((f) => `- [${f.severity}] (${f.sweep}) ${f.file || ''} ${f.summary}`).join('\n')}`
  const r = await implement(MODELS.average, ARGS.repoRoot, p, { label: 'sweep-fixes', phase: 'Deliver' })
  if (!r || r.status === 'BLOCKED') flags.push(`Final sweep fixes incomplete: ${r ? r.summary : 'agent died'}`)
}

if (prUrl) {
  // CI first: gh pr checks --watch is the one genuine streaming signal.
  for (let round = 1; ; round++) {
    const ci = await agent(
      `Watch CI for ${prUrl} from ${ARGS.repoRoot} (gh pr checks ${prUrl} --watch; push the branch first if there are unpushed commits). When checks settle, report green=true/false. For failures, group them by root cause and report: check name as group name, key log output as summary, implicated files. Review comments are handled separately — ignore them here. Do not fix anything.`,
      { model: 'sonnet', effort: 'medium', schema: CHECKS_SCHEMA, label: `ci:r${round}`, phase: 'Deliver' },
    )
    if (!ci) { flags.push('CI watch agent died — CI status UNVERIFIED, check the PR manually'); break }
    if (ci.green) { ciGreen = true; log('CI green'); break }
    if (round > MAX_CI_ROUNDS) {
      flags.push(`CI not green after ${MAX_CI_ROUNDS} fix rounds: ${ci.groups.map((g) => g.name).join(', ')}`)
      break
    }
    log(`CI red — fixing ${ci.groups.length} group(s): ${ci.groups.map((g) => g.name).join(', ')}`)
    await parallel(ci.groups.map((g) => () => (async () => {
      const p = `${preface}${lessonsBlock()}\n\nCI on PR ${prUrl} is failing. Fix this group at the root cause — no test deletion, no skips, no assertion weakening. You may run only the narrow commands needed to reproduce this failure locally. Commit with plain git add/commit, then push.\nGroup: ${g.name}\nImplicated files: ${(g.files || []).join(', ')}\nFailure detail:\n${g.summary}\n\n${ironLaws}`
      const r = await implement(MODELS.average, ARGS.repoRoot, p, { label: `ci-fix:${g.name}`, phase: 'Deliver' })
      if (!r || r.status === 'BLOCKED') flags.push(`CI fixer for "${g.name}" blocked: ${r ? r.summary : 'agent died'}`)
    })()))
  }

  // Review comments from humans and bots: triage fix / reply / escalate.
  // Every reply is 🤖-prefixed; only threads whose issue was actually fixed
  // get resolved.
  const handledIds = new Set()
  for (let round = 1; round <= PR_WATCH_ROUNDS; round++) {
    const seen = [...handledIds]
    const triage = await agent(
      `Read review feedback on PR ${prUrl} from ${ARGS.repoRoot} and triage it. Do not change any code.\n\nFetch all three buckets (they hold different things):\n- inline review threads via GraphQL reviewThreads — take each thread's id (PRRT_…), isResolved, and each comment's databaseId, author, path, body\n- review submissions: gh api repos/{owner}/{repo}/pulls/{n}/reviews (bodies of COMMENTED/CHANGES_REQUESTED submissions)\n- conversation comments: gh api repos/{owner}/{repo}/issues/{n}/comments\nUse conditional requests (If-None-Match/If-Modified-Since) where you can — a 304 costs no rate limit.\n\nSkip: resolved threads, anything authored by the PR author or a 🤖-prefixed reply, and these already-handled comment ids: ${seen.join(', ') || '(none)'}.\n\nFor each remaining comment classify disposition:\n- "fix" — a real defect, missing edge case, or security/correctness issue in this PR's diff\n- "reply" — a question, a misunderstanding, an already-handled point, or a preference/scope request that should NOT change this PR\n- "escalate" — feedback that invalidates the plan or spec, requires an architectural decision, or asks for work outside this PR's scope\nBots (CodeRabbit, Copilot, Greptile, Bugbot) are frequently wrong or out of scope — judge the code, not the confidence of the comment. Report id (numeric, for replies), threadId (PRRT_ node id when inline), author, isBot, path, body (trimmed to its substance), disposition, and a one-line rationale.\n\nIf there is no unhandled feedback, return an empty comments array.`,
      { model: 'sonnet', effort: 'medium', schema: COMMENTS_SCHEMA, label: `pr-comments:r${round}`, phase: 'Deliver' },
    )
    if (!triage) { flags.push('PR comment triage agent died — review feedback UNVERIFIED, check the PR manually'); break }

    const fresh = (triage.comments || []).filter((c) => !handledIds.has(c.id))
    fresh.forEach((c) => handledIds.add(c.id))
    const toFix = fresh.filter((c) => c.disposition === 'fix')
    const toReply = fresh.filter((c) => c.disposition === 'reply')
    const toEscalate = fresh.filter((c) => c.disposition === 'escalate')

    toEscalate.forEach((c) => flags.push(`PR feedback needs your decision (@${c.author}${c.path ? ` on ${c.path}` : ''}): ${firstSentence(c.body, 160)}`))

    if (!fresh.length) {
      if (round === PR_WATCH_ROUNDS) break
      const waited = await agent(
        `Sleep ${PR_WATCH_INTERVAL_S} seconds, then report "done". Run: sleep ${PR_WATCH_INTERVAL_S}`,
        { model: 'haiku', effort: 'low', label: `pr-wait:r${round}`, phase: 'Deliver' },
      )
      if (!waited) break
      continue
    }

    log(`PR feedback: ${toFix.length} to fix, ${toReply.length} to answer, ${toEscalate.length} escalated`)

    if (toFix.length) {
      const p = `${preface}${lessonsBlock()}\n\nReviewers raised real issues on PR ${prUrl}. Fix each at the root cause — no test deletion, no assertion weakening, no skips. You own the files named below plus their tests. You may run only the narrow commands needed to verify a specific fix. Commit with plain git add/commit, then push.\n\n${ironLaws}\n\nFindings:\n${toFix.map((c) => `- @${c.author}${c.path ? ` (${c.path})` : ''}: ${c.body}`).join('\n')}`
      const r = await implement(MODELS.average, ARGS.repoRoot, p, { label: `pr-fix:r${round}`, phase: 'Deliver' })
      if (!r || r.status === 'BLOCKED') flags.push(`PR review fixes incomplete: ${r ? r.summary : 'agent died'}`)
      else { ciGreen = false; retroSignals.push(...toFix.map((c) => `pr review: ${firstSentence(c.body, 120)}`)) }
    }

    const replyPlan = [
      ...toFix.map((c) => ({ ...c, kind: 'fixed' })),
      ...toReply.map((c) => ({ ...c, kind: 'answer' })),
      ...toEscalate.map((c) => ({ ...c, kind: 'escalated' })),
    ]
    if (replyPlan.length) {
      const r = await agent(
        `Post replies on PR ${prUrl} from ${ARGS.repoRoot}. Every reply body MUST start with "🤖 ". Reply in the same place the comment lives: inline thread comments via gh api repos/{owner}/{repo}/pulls/comments/{comment_id}/replies, review-submission and conversation comments via gh api repos/{owner}/{repo}/issues/{n}/comments.\n\n${replyPlan.map((c) => {
          const how = c.kind === 'fixed'
            ? 'Say specifically what changed and reference the fixing commit. Then resolve the thread (GraphQL resolveReviewThread) if threadId is present.'
            : c.kind === 'answer'
              ? 'Answer the question or explain why no change is warranted — be concrete and cite code. Do NOT resolve the thread; leave it for the reviewer.'
              : 'Say this needs a decision from the PR author and has been flagged for them. Do NOT resolve the thread.'
          return `- comment id ${c.id}${c.threadId ? ` (thread ${c.threadId})` : ''} by @${c.author}: "${firstSentence(c.body, 200)}" → ${how}`
        }).join('\n')}\n\n${toFix.length ? `Fixes just pushed, for reference when describing what changed: ${toFix.map((c) => firstSentence(c.body, 80)).join('; ')}` : ''}\nReport which replies posted and which threads you resolved.`,
        { model: 'sonnet', effort: 'medium', label: `pr-reply:r${round}`, phase: 'Deliver' },
      )
      if (!r) flags.push('Posting PR replies failed — reviewers may be waiting on a response')
    }

    if (toFix.length) {
      const ci = await agent(
        `Watch CI for ${prUrl} from ${ARGS.repoRoot} (push first if there are unpushed commits, then gh pr checks ${prUrl} --watch). Report green=true/false and group any failures by root cause with implicated files. Fix nothing.`,
        { model: 'sonnet', effort: 'medium', schema: CHECKS_SCHEMA, label: `ci-recheck:r${round}`, phase: 'Deliver' },
      )
      if (ci && ci.green) { ciGreen = true; log('CI green after review fixes') }
      else if (ci) flags.push(`CI red after review fixes: ${ci.groups.map((g) => g.name).join(', ')}`)
      else flags.push('CI recheck after review fixes did not return — verify the PR manually')
    }
  }
}

// Honest outcome: PR_OPEN is reserved for confirmed-green CI.
return {
  outcome: prUrl ? (ciGreen ? 'PR_OPEN' : 'PR_OPEN_WITH_FAILURES') : 'NO_PR',
  prUrl,
  ciGreen,
  progressDoc: `${ARGS.planDir}progress.md`,
  boundaries: boundaryResults,
  phases: phaseSummaries,
  lessons,
  flags,
}
