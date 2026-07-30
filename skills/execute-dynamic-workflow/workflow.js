export const meta = {
  name: 'execute-dynamic-workflow',
  description: 'Take a design spec from plan to PR with green CI: plan-approval gate, JIT-elaborated phases, cross-model implement/review loops, phase-boundary verification',
  whenToUse: 'Dispatched by the execute-dynamic-workflow skill with args {specPath, planDir, repoRoot, baseBranch, branch, prTitle, approved?, feedback?, clarifications?}',
  phases: [
    { title: 'Plan', detail: 'branch setup, planner explores + writes plan dir, adversarial plan review, approval page' },
    { title: 'Deliver', detail: 'PR, CI to green, final adversarial sweeps' },
  ],
}

// ============================== Configuration ==============================
// Model map per task difficulty. Codex names must match the Codex account's
// model strings; effort maps to model_reasoning_effort. Anthropic side is the
// fallback when the Codex MCP is unavailable or failing.
// Implementation is NEVER high-complexity — hard problems are handled by
// expensive planning/elaboration up front and expensive review behind, with
// implementers in the middle doing well-specified work. Subtle tasks get
// difficulty=average plus risk=high (two reviewers), not a bigger model.
const MODELS = {
  simple: { codex: { model: 'gpt-5.6-terra', effort: 'low' }, anthropic: { model: 'haiku', effort: 'medium' } },
  average: { codex: { model: 'gpt-5.6-terra', effort: 'medium' }, anthropic: { model: 'sonnet', effort: 'medium' } },
}
// Review tiers: per-task review is scoped to one diff — High is enough.
// Plan review and final sweeps guard the entire run — XHigh.
const REVIEW_TASK_CODEX = { model: 'gpt-5.6-sol', effort: 'high' }   // cross-model 2nd reviewer on risk=high tasks
const REVIEW_DEEP_CODEX = { model: 'gpt-5.6-sol', effort: 'xhigh' }  // plan review + final sweeps
const MAX_FIX_CYCLES = 2      // per-task review→fix cycles
const MAX_CHECK_ROUNDS = 3    // phase-boundary fix rounds (plus a final observation)
const MAX_CI_ROUNDS = 3       // CI fix rounds (plus a final observation)
const MAX_PLAN_REVIEW_CYCLES = 2
// PR review-comment watch. GitHub offers no push channel a laptop agent can
// subscribe to (no GraphQL subscriptions, no SSE/long-poll, and the official
// MCP server declares no subscribe capability), so this polls — but polls
// conditionally: a 304 costs zero primary rate limit. Bots differ in how they
// publish (CodeRabbit posts no check run; Greptile/Bugbot do), so checks alone
// are not a completion signal — the reviews bucket is the reliable one.
const PR_WATCH_ROUNDS = 4        // comment sweeps after CI settles
const PR_WATCH_INTERVAL_S = 90   // ≥ GitHub's X-Poll-Interval (60s)

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
          files: STR_ARR, shared: STR_ARR, deps: STR_ARR, ears: STR_ARR, refs: STR_ARR,
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
    conversationId: { type: 'string' }, commits: STR_ARR, filesChanged: STR_ARR,
    summary: { type: 'string' }, ephemeralTests: STR_ARR, concerns: { type: 'string' },
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
    conversationId: { type: 'string' },
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
// One agent closes each phase: it reads the phase's diff once and returns the
// landed summary, the drift verdict, and the distilled lessons together.
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
const ephemeralTests = []  // accumulated from implementer reports, cleaned per boundary
const implConvos = new Map() // taskId -> {conversationId, difficulty, files, claimed} for chain reuse
// Feedback loop owned by this orchestrator: correction signals accumulate per
// phase (retroSignals), a retro agent distills them into binding lessons at
// the boundary, and lessons are injected into every later prompt.
const lessons = []       // distilled cross-phase guidance, grows at phase boundaries
const retroSignals = []  // raw correction signals for the current phase, reset each phase
let codexFailures = 0
let codexHealthy = true
let preface = ''
let ciGreen = false

// ============================== Prompts ==============================
// Commits use the pathspec form (`git commit -m "..." -- <files>`) so that a
// commit only ever includes the named paths, even when a concurrently-running
// agent has staged other files in the shared index.
const commitRule = 'Commit with: git add <only your files> then git commit -m "<plain-English behavior summary>" -- <only your files>. The `-- <files>` pathspec is mandatory — it protects concurrent agents sharing the git index. No stash, rebase, amend, checkout, or branch commands.'

const implRules = `## Implementer rules
- Write complete, working code — no stubs, no placeholders, no TODO paths.
- Write every listed test, plus any needed to pin behavior you added — durable behavioral tests only. Write them; do NOT run them. Never write scaffolding tests (file-existence, symbol-name, module-structure, or mock-echo assertions) and never commit scratch scripts, debug code, or one-off verification — observations go in your report, and the plan's verify commands run at the phase boundary. If you committed a temporary artifact anyway, list it under ephemeral tests so the boundary removes it; that is a deviation, not a workflow.
- Do not run build, test, lint, format, or typecheck commands, and do not start dev servers. Verification happens at the phase boundary.
- Only make substantive edits to files listed under "Files you own". For files listed under "Shared", make only the minimal append-style edit described; other tasks may touch those files concurrently — re-read a shared file immediately before editing it, and if your edit conflicts on commit, re-apply just your lines.
- Git: exactly one commit for this task. ${commitRule}
- No plan vocabulary anywhere in code, tests, identifiers, comments, or the commit message: no task ids, phase numbers, requirement ids, or "per the plan" references.
- If you need a paragraph-long comment to justify a workaround, the code is wrong — fix the code.
- If you cannot proceed without an architectural decision or missing information, stop and report BLOCKED with the specific question. Bad work is worse than no work.
Report: status, commit sha(s), files changed, ephemeral tests still present (file + test name, or none), concerns.`

function taskBlock(t) {
  return [
    `## Task: ${t.title}`,
    `Files you own (substantive edits allowed): ${t.files.join(', ')}`,
    t.shared && t.shared.length ? `Shared (minimal append-style edits only): ${t.shared.join(', ')}` : '',
    t.ears && t.ears.length ? `Requirements this task must satisfy:\n${t.ears.map((e) => `- ${e}`).join('\n')}` : '',
    t.refs && t.refs.length ? `References (read these; do not search the repo):\n${t.refs.map((r) => `- ${r}`).join('\n')}` : '',
    `Context: ${t.context}`,
    t.tests && t.tests.length ? `Tests to write (write, do NOT run):\n${t.tests.map((x) => `- ${x}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n')
}

function codexBriefing(m, sandbox, prompt, continueId, label) {
  const logName = (label || 'codex').replace(/[^a-zA-Z0-9._-]/g, '_')
  return [
    `CODEX_MODEL: ${m.model}`, `EFFORT: ${m.effort}`, `SANDBOX: ${sandbox}`,
    `CWD: ${args.repoRoot}`, `LOG: ${args.planDir}runs/${logName}.md`,
    `CONTINUE: ${continueId || 'new'}`, 'PROMPT:', prompt,
  ].join('\n')
}

// Appended AFTER the preface in prompts: the preface stays a byte-identical
// cache-friendly prefix, and this block only changes at phase boundaries.
function lessonsBlock() {
  return lessons.length ? `\n\n## Lessons from earlier phases (binding — follow these)\n${lessons.map((l) => `- ${l}`).join('\n')}` : ''
}

const adversarialInline = `Adversarially review this change with a clean eye. Assume the code is wrong and try to prove it. Priorities: (1) for each requirement listed, locate the exact code satisfying it and a test that would catch its removal — missing either is CRITICAL; (2) correctness under hostile inputs — boundaries, error paths, concurrency, cleanup, eager-vs-lazy; (3) paragraph-long justification comments mean the code is wrong; (4) stubs, swallowed errors, tests that assert mocks. Ignore style/formatting (CI owns those). Report only findings you can anchor to a file and a concrete failure scenario, each with severity CRITICAL|MAJOR|MINOR. Verdict PASS or ISSUES (MINOR-only is PASS).`

// ============================== Helpers ==============================
function codexFailed() {
  codexFailures += 1
  if (codexFailures >= 2 && codexHealthy) {
    codexHealthy = false
    flags.push('Codex MCP marked unhealthy after repeated failures — remaining work ran on Anthropic fallback models')
    log('Codex unavailable twice — falling back to Anthropic models for the rest of the run')
  }
}

async function runCodex(m, sandbox, prompt, opts, continueId) {
  if (!codexHealthy) return null
  const r = await agent(codexBriefing(m, sandbox, prompt, continueId, opts && opts.label), {
    agentType: 'code-factory:codex-runner', schema: RUNNER_SCHEMA, ...opts,
  })
  if (!r || r.status === 'CODEX_UNAVAILABLE') { codexFailed(); return null }
  return r
}

// Review-mode Codex call: the runner reports Codex's verdict/findings through
// REVIEW_SCHEMA directly — no regex inference on free-text summaries.
async function runCodexReview(m, prompt, opts, continueId) {
  if (!codexHealthy) return null
  const briefing = `MODE: review — after the Codex call completes, report Codex's verdict and findings through the structured output (verdict PASS|ISSUES; one findings entry per defect with severity/file/summary/scenario; include the conversation id). If Codex is unavailable after one retry, set codexUnavailable=true with verdict PASS and empty findings.\n${codexBriefing(m, 'read-only', prompt, continueId, opts && opts.label)}`
  const r = await agent(briefing, { agentType: 'code-factory:codex-runner', schema: REVIEW_SCHEMA, ...opts })
  if (!r || r.codexUnavailable) { codexFailed(); return null }
  return r
}

async function implement(task, prompt, opts, continueId) {
  const m = MODELS[task.difficulty] || MODELS.average
  const viaCodex = await runCodex(m.codex, 'danger-full-access', prompt, opts, continueId)
  if (viaCodex) return { engine: 'codex', ...viaCodex }
  const r = await agent(`${prompt}\n\nWork in ${args.repoRoot}.`, {
    model: m.anthropic.model, effort: m.anthropic.effort, schema: RUNNER_SCHEMA, ...opts,
  })
  return r ? { engine: 'anthropic', ...r } : null
}

function recordResult(task, r) {
  if (!r || r.status === 'BLOCKED') {
    flags.push(`Task ${task.id} (${task.title}) ended BLOCKED: ${r ? r.summary : 'agent died'}`)
    log(`  ✗ ${task.id} ${task.title} — BLOCKED: ${r ? firstSentence(r.summary, 110) : 'agent died'}`)
    return false
  }
  if (r.ephemeralTests && r.ephemeralTests.length) ephemeralTests.push(...r.ephemeralTests)
  if (r.status === 'DONE_WITH_CONCERNS' && r.concerns) flags.push(`Task ${task.id} concern: ${r.concerns}`)
  return true
}

// Narration: the orchestrator is the only layer that sees every result, so it
// is the only layer that can tell the story. These helpers turn results the
// script already holds into user-facing progress lines — no extra dispatches.
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

function registerConvo(task, impl) {
  if (impl && impl.engine === 'codex' && impl.conversationId) {
    implConvos.set(task.id, { conversationId: impl.conversationId, difficulty: task.difficulty, files: task.files, claimed: false })
  }
}

// Returns 'DONE' or 'FAILED'. FAILED means dependents must not build on this
// task: implementation blocked/died, or review ended with unresolved CRITICALs.
async function runTask(task, phaseLabel) {
  // Chain reuse: continue the Codex session of a completed dependency that
  // touched the same files — its context (and provider cache) already holds
  // the relevant code. Sessions are claimed so two same-wave tasks never
  // reply to one conversation concurrently. Reviewers are NEVER chained
  // across tasks: adversarial independence requires a clean context per task.
  let chainId = null
  for (const d of task.deps) {
    const c = implConvos.get(d)
    if (c && !c.claimed && c.conversationId && c.difficulty === task.difficulty && task.files.some((f) => c.files.includes(f))) {
      c.claimed = true
      chainId = c.conversationId
      break
    }
  }
  const prompt = chainId
    ? `${taskBlock(task)}${lessonsBlock()}\n\n(Conventions: ${args.planDir}preface.md — consult only if needed.)\n\n${implRules}`
    : `${preface}${lessonsBlock()}\n\n${taskBlock(task)}\n\n${implRules}`
  let impl = await implement(task, prompt, { label: `impl:${task.id}`, phase: phaseLabel }, chainId)
  if (!recordResult(task, impl)) return 'FAILED'
  registerConvo(task, impl)

  const nReviewers = task.risk === 'high' ? 2 : task.risk === 'standard' ? 1 : 0
  if (nReviewers === 0) { narrateTask(task, impl, null); return 'DONE' }

  const reviewBody = () => `${preface}${lessonsBlock()}\n\nReview the implementation of: ${task.title}\nCommits: ${(impl.commits || []).join(', ') || 'most recent commits touching ' + task.files.join(', ')}\nFiles: ${task.files.join(', ')}\nRequirements:\n${(task.ears || []).map((e) => `- ${e}`).join('\n') || '- n/a'}\nTask context: ${task.context}`

  let priorFindings = null
  let codexReviewId = null
  for (let cycle = 0; cycle <= MAX_FIX_CYCLES; cycle++) {
    // After a fix, re-checks are scoped — verify the specific findings were
    // resolved (continuing the Codex reviewer's own session where possible)
    // instead of paying for a second full review.
    const recheck = priorFindings
      ? `\n\nA fix was applied (commits: ${(impl.commits || []).join(', ') || 'latest'}). Verify each previous finding below is actually resolved, and that the fix introduced no new CRITICAL defect. Do not re-litigate areas that already passed.\nPrevious findings:\n${priorFindings.map((f) => `- [${f.severity}] ${f.summary}`).join('\n')}`
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
        if (r) { codexReviewId = r.conversationId || codexReviewId; return r }
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
    log(`  ↻ ${task.id} review found ${findings.length} issue(s): ${firstSentence(findings[0].summary, 90)} — fixing`)
    const fixPrompt = `An independent review of your work on "${task.title}" found issues. Resolve every finding, or state precisely why one is wrong instead of changing code. Make one additional commit.\n\nFindings:\n${findings.map((f) => `- [${f.severity}] ${f.file || ''} ${f.summary}${f.scenario ? ` | Scenario: ${f.scenario}` : ''}`).join('\n')}\n\n${implRules}`
    impl = impl.engine === 'codex' && impl.conversationId
      ? await implement(task, fixPrompt, { label: `fix:${task.id}`, phase: phaseLabel }, impl.conversationId)
      : await implement(task, `${preface}\n\n${fixPrompt}\n\nContext — what was built: ${impl.summary}`, { label: `fix:${task.id}`, phase: phaseLabel })
    if (!recordResult(task, impl)) return 'FAILED'
    registerConvo(task, impl)
  }
  return 'DONE'
}

// Wave scheduler: deps must be done; `files` are exclusive locks, `shared` is
// not. Failed tasks propagate: dependents are skipped, never run on top of
// missing or review-rejected work.
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
    const locked = new Set()
    const wave = []
    for (const t of pending) {
      if (t.deps.every((d) => done.has(d)) && !t.files.some((f) => locked.has(f))) {
        wave.push(t)
        t.files.forEach((f) => locked.add(f))
      }
    }
    if (!wave.length) {
      flags.push(`Dependency deadlock in ${phaseLabel}; skipped tasks: ${pending.map((t) => t.id).join(', ')}`)
      return
    }
    log(`${phaseLabel}: starting ${wave.length} task(s) in parallel — ${wave.map((t) => t.title).join('; ')}`)
    const results = await parallel(wave.map((t) => () => runTask(t, phaseLabel)))
    wave.forEach((t, i) => { (results[i] === 'DONE' ? done : failed).add(t.id) })
    pending = pending.filter((t) => !done.has(t.id) && !failed.has(t.id))
    log(`${phaseLabel}: ${done.size}/${tasks.length} tasks complete${failed.size ? `, ${failed.size} failed/skipped` : ''}`)
  }
}

// Returns true only when the full suite is confirmed green.
async function boundary(phaseLabel, checks) {
  // Hygiene runs once, separately from the check loop: it is a repo-wide
  // grep-and-strip with no dependency on check results, so fusing it into the
  // check runner would make every later round re-read instructions it can't
  // act on. Mechanical work — cheap model.
  const hygieneResult = await agent(
    `Hygiene pass on this phase's diff in ${args.repoRoot} (git diff against the commit where the phase started, or the phase's commits):\n1. Plan-vocabulary scan: grep the changed files for plan structure leaking into code — requirement ids (REQ-, EARS, or the spec's id scheme), phase/task/cycle references ("Phase 2", "Task 3.1", "Cycle B", "satisfies requirement"). Strip or rename every hit so the code reads as if the plan never existed.\n2. Scaffolding-test scan: in changed test files, delete tests that assert file existence, symbol names, module structure, empty stubs, or that a mock returns its configured value — unless deletion would leave a spec requirement without behavioral coverage, in which case rewrite as a behavioral test.${ephemeralTests.length ? `\n3. Remove these implementer-reported temporary artifacts: ${ephemeralTests.join('; ')}.` : ''}\nDo not run build/test/lint commands. Commit if any files changed (${commitRule}) Report what you stripped, or "clean".`,
    { model: 'haiku', effort: 'medium', phase: phaseLabel, label: 'hygiene' },
  )
  if (hygieneResult) ephemeralTests.length = 0 // cleared only after hygiene actually ran

  for (let round = 1; ; round++) {
    // Running commands and reporting exit codes is mechanical; the judgment is
    // in grouping failures so parallel fixers don't collide on the same file.
    // Haiku handles both here because the plan's check commands are explicit.
    const check = await agent(
      `Run the full check suite from ${args.repoRoot}, in order:\n${checks.map((c) => `- ${c}`).join('\n')}\nRun every command even if an earlier one fails. Capture failures verbatim. Then group them so independent fixers can work in parallel WITHOUT touching the same files: failures sharing a root cause (e.g. dozens of type errors from one changed signature) are ONE group; failures in different packages/subsystems are separate groups. For each group report: name, failing commands, implicated files, and a summary with the key error output. Fix nothing. green=true only if every command passed.`,
      { model: 'haiku', effort: 'medium', schema: CHECKS_SCHEMA, label: `checks:r${round}`, phase: phaseLabel },
    )
    if (!check) { flags.push(`${phaseLabel}: check agent died — checks UNVERIFIED`); return false }
    if (check.green) { log(`${phaseLabel}: ✓ all checks green${round > 1 ? ` after ${round - 1} fix round(s)` : ''}`); return true }
    if (round > MAX_CHECK_ROUNDS) {
      flags.push(`${phaseLabel}: checks still failing after ${MAX_CHECK_ROUNDS} fix rounds: ${check.groups.map((g) => g.name).join(', ')}`)
      return false
    }
    check.groups.forEach((g) => retroSignals.push(`checks: ${g.name} — ${(g.summary || '').slice(0, 200)}`))
    log(`${phaseLabel}: checks red — fixing ${check.groups.length} group(s): ${check.groups.map((g) => `${g.name} (${firstSentence(g.summary, 60)})`).join('; ')}`)
    await parallel(check.groups.map((g) => () => (async () => {
      const p = `${preface}${lessonsBlock()}\n\nFix this group of failing checks. You may run ONLY the specific failing commands listed while iterating — never the full suite.\nGroup: ${g.name}\nCommands: ${(g.commands || []).join('; ')}\nImplicated files: ${(g.files || []).join(', ')}\nFailure summary:\n${g.summary}\n\nFind root causes — no test deletion, no assertion weakening, no skips. ${commitRule} No plan vocabulary.`
      const r = await implement({ difficulty: 'average' }, p, { label: `fixer:${g.name}`, phase: phaseLabel })
      if (!r || r.status === 'BLOCKED') flags.push(`${phaseLabel}: fixer for "${g.name}" blocked: ${r ? r.summary : 'agent died'}`)
    })()))
  }
}

// ============================== Phase: Plan ==============================
phase('Plan')

// The planner owns the whole planning phase now: it sets up the branch first
// (so it explores the exact tree implementation will start from, and a dirty
// tree aborts before expensive exploration), writes the plan directory, and
// writes the human approval briefing from the plan it just built — no second
// agent re-reading the same files to describe them.
const approvalDoc = `${args.planDir}approval.md`
const approvalTask = `Finally, write the developer's approval briefing to ${approvalDoc} (clean, scannable markdown — headers, tables, short bullets, no filler):\n1. High-level summary: what will be built, on branch ${args.branch} → PR "${args.prTitle}".\n2. Per phase in order: name, goal, EARS requirements covered, and the 3-5 MOST IMPORTANT verifications that will prove the phase worked at its boundary. Synthesize these from the phase goal, the Checks commands, and the spec's acceptance criteria — each concrete and checkable; "all tests pass" is banned.\n3. The full check suite that runs at every boundary.\n4. Assumptions you made and anything you flagged.`

log('Planning: branch setup, codebase exploration, plan directory')
let plan = await agent(
  `Spec path: ${args.specPath}\nOutput directory: ${args.planDir}\nRepo root: ${args.repoRoot}\nBase branch: ${args.baseBranch}\nWork branch: ${args.branch}\n${args.clarifications ? `\nClarifications from the developer (answers to earlier questions — treat as authoritative):\n${args.clarifications}\n` : ''}\nFIRST, set up the branch: verify the working tree is clean (git status). If it is dirty, STOP — return status NEEDS_CONTEXT with a question naming the uncommitted files; do not plan. Otherwise fetch origin and create/check out ${args.branch} from ${args.baseBranch} (check it out if it already exists), then confirm you are on ${args.branch} before exploring.\n\nTHEN produce the plan directory per your instructions (plan.md, preface.md, phases/*.md, empty tasks/).\n\n${approvalTask}\n\nReturn the structured summary. If the spec is too ambiguous to phase, return NEEDS_CONTEXT with questions.`,
  { agentType: 'code-factory:workflow-planner', effort: 'xhigh', schema: PLAN_SCHEMA, phase: 'Plan', label: 'planner' },
)
const planIncomplete = (p) => !p || p.status !== 'DONE' || !p.preface || !p.phases || !p.phases.length || !p.checks || !p.checks.length
if (planIncomplete(plan)) {
  return {
    outcome: 'NEEDS_CONTEXT',
    questions: plan && plan.questions && plan.questions.length ? plan.questions : ['planner returned no usable plan — check the spec, the working tree state, and planner output'],
    flags,
  }
}
preface = plan.preface
if (plan.flags) flags.push(...plan.flags)

for (let cycle = 1; cycle <= MAX_PLAN_REVIEW_CYCLES; cycle++) {
  const planReviewPrompt = `Adversarially review the work plan in ${args.planDir} against the spec at ${args.specPath}. Assume the plan is wrong; attack: EARS requirements missing from the coverage matrix or double-assigned; phase seams that leave work unowned or owned twice; dependency errors between phases; phases that cannot be verified by the Checks commands; codebase claims that contradict the actual repo (read the files). Severity CRITICAL|MAJOR|MINOR per finding; verdict PASS or ISSUES (MINOR-only is PASS).`
  let review = await runCodexReview(REVIEW_DEEP_CODEX, planReviewPrompt, { label: 'plan-review', phase: 'Plan' })
  if (!review) review = await agent(planReviewPrompt, { agentType: 'code-factory:adversarial-reviewer', model: 'opus', effort: 'xhigh', schema: REVIEW_SCHEMA, label: 'plan-review', phase: 'Plan' })
  if (!review) { flags.push('Plan review gate UNVERIFIED — reviewer agents failed'); break }
  if (review.verdict === 'PASS') break
  log(`Plan review found issues (cycle ${cycle}) — dispatching planner fixes`)
  const fixed = await agent(
    `Fix mode. Plan directory: ${args.planDir}. Spec: ${args.specPath}. Apply these adversarial review findings (or rebut with reasons):\n${review.findings.map((f) => `- [${f.severity}] ${f.summary}`).join('\n')}\nThen refresh ${approvalDoc} so the briefing matches the corrected plan.\nReturn the updated structured summary.`,
    { agentType: 'code-factory:workflow-planner', effort: 'xhigh', schema: PLAN_SCHEMA, phase: 'Plan', label: 'planner-fix' },
  )
  if (!planIncomplete(fixed)) { plan = fixed; preface = plan.preface }
  if (cycle === MAX_PLAN_REVIEW_CYCLES) flags.push('Plan review issues may remain after max fix cycles')
}
log(`Plan ready: ${plan.phases.length} phases`)

// ============================== Approval gate ==============================
// The one human checkpoint. First launch (no args.approved) writes a markdown
// briefing and pauses. The relaunch with resumeFromRunId + approved:true
// replays everything above from cache, applies feedback (if any), and runs
// the rest fully autonomously.
if (!args.approved) {
  return {
    outcome: 'AWAITING_APPROVAL',
    approvalDoc,
    planDir: args.planDir,
    phases: plan.phases.map((p) => `${p.id}: ${p.name} — ${p.goal}`),
    flags,
  }
}
if (args.feedback) {
  log('Applying plan feedback before implementation')
  const revised = await agent(
    `Fix mode. Plan directory: ${args.planDir}. Spec: ${args.specPath}. The developer reviewed the plan and gave this feedback — apply it (update plan.md / preface.md / phase sketches as needed), refresh ${approvalDoc} to match, and return the updated structured summary:\n${args.feedback}`,
    { agentType: 'code-factory:workflow-planner', effort: 'xhigh', schema: PLAN_SCHEMA, phase: 'Plan', label: 'planner-feedback' },
  )
  if (planIncomplete(revised)) {
    // The user's approval was conditional on this feedback. Proceeding with
    // the unmodified plan would implement something they did not approve.
    return { outcome: 'FEEDBACK_FAILED', detail: revised && revised.questions ? revised.questions.join('; ') : 'planner could not apply the feedback', planDir: args.planDir, flags }
  }
  plan = revised
  preface = plan.preface
}

// ============================== Execution phases ==============================
// Wall-clock: elaboration is pipelined one phase ahead. Phase N+1's elaborator
// starts the moment phase N's tasks begin implementing; a drift check at the
// boundary (plus the elaborator's own needsReelaboration signal) triggers
// re-elaboration only when it is actually needed (expected to be rare).
const NN = (id) => String(id).padStart(2, '0')

function elaborate(p, extraNote) {
  const landed = phaseSummaries.map((s) => `- ${s}`).join('\n') || '- nothing yet (first phase)'
  return agent(
    `Plan directory: ${args.planDir}\nPhase id: ${p.id} (phases/${NN(p.id)}-${p.slug}.md)\nSpec: ${args.specPath}\nRepo root: ${args.repoRoot}\nWhat prior phases actually landed:\n${landed}${lessonsBlock()}${extraNote ? `\n\n${extraNote}` : ''}\n\nElaborate this phase per your instructions: verify assumptions, produce the task list, write tasks/*.md files, update the phase file and plan.md status. Bake the lessons above (if any) into task context and references so implementers cannot repeat those mistakes.`,
    { agentType: 'code-factory:dynamic-elaborator', effort: 'xhigh', schema: TASKS_SCHEMA, phase: `Phase ${p.id}: ${p.name}`, label: `elaborate:${p.id}` },
  )
}

function inFlightNote(p, tasks) {
  return `LOOKAHEAD MODE: Phase ${p.id} (${p.name}) is being implemented RIGHT NOW — its files are mid-flight in the working tree; do not treat their current state as final. For what phase ${p.id} will produce, trust its task files (tasks/${NN(p.id)}-*.md) and its goal: ${p.goal} Verify only earlier phases' code against the tree. If your task list depends heavily on phase ${p.id}'s exact output shapes, set needsReelaboration=true so the orchestrator re-elaborates against the stable tree before executing.`
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
  if (next) lookahead = elaborate(next, inFlightNote(p, elaborated.tasks))

  await runPhaseTasks(elaborated.tasks, label)

  const extraVerify = elaborated.tasks.flatMap((t) => t.verify || [])
  const green = await boundary(label, [...plan.checks, ...extraVerify])
  boundaryResults.push({ phase: label, green })

  // One phase-closing agent: reads the phase diff once and returns the landed
  // summary, the drift verdict, and the distilled lessons together. (Splitting
  // these meant two sequential agents reading the same diff at every boundary.)
  // Lessons feed every later prompt; the next phase's lookahead elaboration
  // predates them by design, but its implementers get them at dispatch time.
  const newFlags = flags.slice(flagsBefore)
  const hasSignals = retroSignals.length || newFlags.length
  const summ = await agent(
    `In ${args.repoRoot} on branch ${args.branch}, review the git log/diff for the work just completed ("${p.name}") and close out the phase.\n\nPlanned tasks:\n${elaborated.tasks.map((t) => `- ${t.title} → ${t.files.join(', ')}`).join('\n')}\n\nFirst, append a section to ${args.planDir}progress.md (create the file with an "# Progress" heading if missing): "## Phase ${p.id}: ${p.name}", your summary paragraph, the boundary check result (${green ? 'checks green' : 'CHECKS NOT GREEN'}), and any lessons you distill below. This file is the run's human-readable record — keep each phase's entry to a few lines.\n\nThen return:\n1. summary: ≤120 words of plain prose on what actually landed — files created/modified, key interfaces.\n2. substantialDrift: true ONLY if files, interfaces, or contracts that LATER phases build on ended up different from the planned tasks above (renames, moved modules, changed signatures, dropped tasks). Routine fixes and internal details are not drift. Set driftNotes when true.${next && hasSignals ? `\n3. lessons: this phase's correction signals are below. Distill ONLY systemic, forward-applicable lessons — recurring coding-style/standards/convention violations or misused APIs that FUTURE tasks in this plan are likely to repeat. One-off bugs are not lessons; an empty list is a fine answer. Max 3, each a single imperative line an implementer can follow ("Use the shared X helper for Y", "Never Z"). Do NOT repeat or rephrase lessons already in force.\n\nCorrection signals:\n${retroSignals.map((s) => `- ${s}`).join('\n')}\n${newFlags.map((f) => `- flag: ${f}`).join('\n')}\n\nLessons already in force:\n${lessons.map((l) => `- ${l}`).join('\n') || '- none'}\n\nFor each NEW lesson that is really a standing project convention the preface should have stated, append it to ${args.planDir}preface.md under a "## Learned during execution" section (create the section if missing). Append all new lessons, tagged with this phase's name, to ${args.planDir}lessons.md.` : '\n3. lessons: return an empty array.'}`,
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
log('Opening PR')
const pr = await agent(
  `In ${args.repoRoot} on branch ${args.branch}: push the branch and open a PR against ${args.baseBranch} titled ${JSON.stringify(args.prTitle)} using gh. PR body: short summary of the change, link to the spec at ${args.specPath}, and this note verbatim if any items exist — "Flagged for human attention:" followed by these items:\n${flags.map((f) => `- ${f}`).join('\n') || '(none)'}\nEnd the body with the standard Claude Code attribution. Return the PR URL.`,
  { model: 'sonnet', effort: 'low', schema: PR_SCHEMA, phase: 'Deliver', label: 'open-pr' },
)
const prUrl = pr ? pr.url : null
if (!prUrl) flags.push('PR creation failed — branch is pushed or local; open PR manually')
else log(`PR open: ${prUrl}`)

log('Running final adversarial sweeps while CI runs')
const sweepDefs = [
  { key: 'quality', prompt: `Review the complete diff of branch ${args.branch} against ${args.baseBranch} in ${args.repoRoot}. Hunt: dead code, low-value or dishonest tests, duplicated logic that should merge, missing documentation where a maintainer needs it, poor naming, refactor opportunities that reduce net complexity. Anchor every finding to files. Severity CRITICAL|MAJOR|MINOR, verdict PASS or ISSUES.` },
  { key: 'compliance', prompt: `Review the complete diff of branch ${args.branch} against ${args.baseBranch} in ${args.repoRoot}, against the spec at ${args.specPath}. For EVERY EARS requirement: locate the implementing code and the test that would catch its removal. Also verify non-goals were not built and constraints were not broken. Missing implementation or test coverage for a requirement is CRITICAL. Severity per finding, verdict PASS or ISSUES.` },
]
const sweeps = await parallel(sweepDefs.map((s) => () => (async () => {
  const viaCodex = await runCodexReview(REVIEW_DEEP_CODEX, s.prompt, { label: `sweep:${s.key}`, phase: 'Deliver' })
  if (viaCodex) return { key: s.key, ...viaCodex }
  const r = await agent(s.prompt, { agentType: 'code-factory:adversarial-reviewer', model: 'opus', effort: 'xhigh', schema: REVIEW_SCHEMA, label: `sweep:${s.key}`, phase: 'Deliver' })
  return r ? { key: s.key, ...r } : null
})()))
sweepDefs.forEach((s, i) => { if (!sweeps[i]) flags.push(`Final ${s.key} sweep did not return — UNVERIFIED`) })
const sweepFindings = sweeps.filter(Boolean).flatMap((s) => (s.verdict === 'ISSUES' ? s.findings.map((f) => ({ ...f, sweep: s.key })) : []))
const actionable = sweepFindings.filter((f) => f.severity !== 'MINOR')
sweepFindings.filter((f) => f.severity === 'MINOR').forEach((f) => flags.push(`Final sweep (${f.sweep}, minor): ${f.summary}`))
if (!actionable.length) log(`Final sweeps: clean${sweepFindings.length ? ` (${sweepFindings.length} minor note(s))` : ''}`)
if (actionable.length) {
  log(`Final sweeps: fixing ${actionable.length} finding(s) — ${actionable.slice(0, 3).map((f) => `${f.sweep}: ${firstSentence(f.summary, 70)}`).join('; ')}`)
  const p = `${preface}${lessonsBlock()}\n\nFinal review of the full branch diff surfaced these findings. You own every file named in a finding, plus any test file covering it. Fix each finding or rebut with a precise reason. Do not run build/test/lint/format/typecheck commands. No plan vocabulary in code, tests, or commit messages. One commit per logical fix — ${commitRule} Push when done.\n\nFindings:\n${actionable.map((f) => `- [${f.severity}] (${f.sweep}) ${f.file || ''} ${f.summary}`).join('\n')}`
  const r = await implement({ difficulty: 'average' }, p, { label: 'sweep-fixes', phase: 'Deliver' })
  if (!r || r.status === 'BLOCKED') flags.push(`Final sweep fixes incomplete: ${r ? r.summary : 'agent died'}`)
}

if (prUrl) {
  // CI first: gh pr checks --watch is the one genuine streaming signal
  // available, so getting checks green before reading comments avoids
  // triaging feedback against code that is about to change anyway.
  for (let round = 1; ; round++) {
    const ci = await agent(
      `Watch CI for ${prUrl} from ${args.repoRoot} (gh pr checks ${prUrl} --watch; push the branch first if there are unpushed commits). When checks settle, report green=true/false. For failures, group them by root cause and report: check name as group name, key log output as summary, implicated files. Review comments are handled separately — ignore them here. Do not fix anything.`,
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
      const p = `${preface}${lessonsBlock()}\n\nCI on PR ${prUrl} is failing. Fix this group at the root cause — no test deletion, no skips, no assertion weakening. You may run only the narrow commands needed to reproduce this failure locally. ${commitRule} Then push.\nGroup: ${g.name}\nImplicated files: ${(g.files || []).join(', ')}\nFailure detail:\n${g.summary}`
      const r = await implement({ difficulty: 'average' }, p, { label: `ci-fix:${g.name}`, phase: 'Deliver' })
      if (!r || r.status === 'BLOCKED') flags.push(`CI fixer for "${g.name}" blocked: ${r ? r.summary : 'agent died'}`)
    })()))
  }

  // Review comments from humans and bots. Not every comment is a fix request:
  // questions get answers, and feedback that invalidates the plan stops the
  // run rather than being silently "fixed". Every reply is 🤖-prefixed, and
  // only threads whose issue was actually fixed get resolved.
  const handledIds = new Set()
  for (let round = 1; round <= PR_WATCH_ROUNDS; round++) {
    const seen = [...handledIds]
    const triage = await agent(
      `Read review feedback on PR ${prUrl} from ${args.repoRoot} and triage it. Do not change any code.\n\nFetch all three buckets (they hold different things):\n- inline review threads via GraphQL reviewThreads — take each thread's id (PRRT_…), isResolved, and each comment's databaseId, author, path, body\n- review submissions: gh api repos/{owner}/{repo}/pulls/{n}/reviews (bodies of COMMENTED/CHANGES_REQUESTED submissions)\n- conversation comments: gh api repos/{owner}/{repo}/issues/{n}/comments\nUse conditional requests (If-None-Match/If-Modified-Since) where you can — a 304 costs no rate limit.\n\nSkip: resolved threads, anything authored by the PR author or a 🤖-prefixed reply, and these already-handled comment ids: ${seen.join(', ') || '(none)'}.\n\nFor each remaining comment classify disposition:\n- "fix" — a real defect, missing edge case, or security/correctness issue in this PR's diff\n- "reply" — a question, a misunderstanding, an already-handled point, or a preference/scope request that should NOT change this PR\n- "escalate" — feedback that invalidates the plan or spec, requires an architectural decision, or asks for work outside this PR's scope\nBots (CodeRabbit, Copilot, Greptile, Bugbot) are frequently wrong or out of scope — judge the code, not the confidence of the comment. Report id (numeric, for replies), threadId (PRRT_ node id when inline), author, isBot, path, body (trimmed to its substance), disposition, and a one-line rationale.\n\nIf there is no unhandled feedback, return an empty comments array.`,
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
      // Nothing new. Wait a poll interval and look once more; bots often post
      // minutes after CI settles, and CodeRabbit/Copilot publish no check run.
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
      const p = `${preface}${lessonsBlock()}\n\nReviewers raised real issues on PR ${prUrl}. Fix each at the root cause — no test deletion, no assertion weakening, no skips. You own the files named below plus their tests. You may run only the narrow commands needed to verify a specific fix. ${commitRule} Then push.\n\nFindings:\n${toFix.map((c) => `- @${c.author}${c.path ? ` (${c.path})` : ''}: ${c.body}`).join('\n')}`
      const r = await implement({ difficulty: 'average' }, p, { label: `pr-fix:r${round}`, phase: 'Deliver' })
      if (!r || r.status === 'BLOCKED') flags.push(`PR review fixes incomplete: ${r ? r.summary : 'agent died'}`)
      else { ciGreen = false; retroSignals.push(...toFix.map((c) => `pr review: ${firstSentence(c.body, 120)}`)) }
    }

    // Reply to everything — fixed items get "what changed", others get a real
    // answer. Silence reads as ignoring the reviewer.
    const replyPlan = [
      ...toFix.map((c) => ({ ...c, kind: 'fixed' })),
      ...toReply.map((c) => ({ ...c, kind: 'answer' })),
      ...toEscalate.map((c) => ({ ...c, kind: 'escalated' })),
    ]
    if (replyPlan.length) {
      const r = await agent(
        `Post replies on PR ${prUrl} from ${args.repoRoot}. Every reply body MUST start with "🤖 ". Reply in the same place the comment lives: inline thread comments via gh api repos/{owner}/{repo}/pulls/comments/{comment_id}/replies, review-submission and conversation comments via gh api repos/{owner}/{repo}/issues/{n}/comments.\n\n${replyPlan.map((c) => {
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

    // Fixes were pushed: re-run CI once so the PR does not end red.
    if (toFix.length) {
      const ci = await agent(
        `Watch CI for ${prUrl} from ${args.repoRoot} (push first if there are unpushed commits, then gh pr checks ${prUrl} --watch). Report green=true/false and group any failures by root cause with implicated files. Fix nothing.`,
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
  progressDoc: `${args.planDir}progress.md`,
  boundaries: boundaryResults,
  phases: phaseSummaries,
  lessons,
  flags,
}
