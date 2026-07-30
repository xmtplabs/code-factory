export const meta = {
  name: 'execute-dynamic-workflow',
  description: 'Take a design spec from plan to PR with green CI: plan-approval gate, JIT-elaborated phases, cross-model implement/review loops, phase-boundary verification',
  whenToUse: 'Dispatched by the execute-dynamic-workflow skill with args {specPath, planDir, repoRoot, baseBranch, branch, prTitle, approved?, feedback?}',
  phases: [
    { title: 'Plan', detail: 'planner explores + writes plan dir, adversarial plan review, approval page' },
    { title: 'Deliver', detail: 'PR, CI to green, final adversarial sweeps' },
  ],
}

// ============================== Configuration ==============================
// Model map per task difficulty. Codex names must match `codex` CLI models;
// effort maps to model_reasoning_effort. Anthropic side is the fallback when
// the Codex MCP is unavailable or failing.
// Implementation is NEVER high-complexity — hard problems are handled by
// expensive planning/elaboration up front and expensive review behind, with
// implementers in the middle doing well-specified work. Subtle tasks get
// difficulty=average plus risk=high (two reviewers), not a bigger model.
const MODELS = {
  simple: { codex: { model: 'terra', effort: 'low' }, anthropic: { model: 'haiku', effort: 'medium' } },
  average: { codex: { model: 'terra', effort: 'medium' }, anthropic: { model: 'sonnet', effort: 'medium' } },
}
// Review tiers: per-task review is scoped to one diff — High is enough.
// Plan review and final sweeps guard the entire run — XHigh.
const REVIEW_TASK_CODEX = { model: 'sol', effort: 'high' }   // cross-model reviewer on risk=high tasks (pairs with Opus High)
const REVIEW_DEEP_CODEX = { model: 'sol', effort: 'xhigh' }  // plan review + final sweeps (pairs with Opus XHigh fallback)
const MAX_FIX_CYCLES = 2      // per-task review→fix cycles
const MAX_CHECK_ROUNDS = 3    // phase-boundary check→fix rounds
const MAX_CI_ROUNDS = 3       // CI watch→fix rounds
const MAX_PLAN_REVIEW_CYCLES = 2

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
  required: ['status', 'preface', 'phases', 'checks'],
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
const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    substantialDrift: { type: 'boolean' },
    driftNotes: { type: 'string' },
  },
  required: ['summary', 'substantialDrift'],
}

// ============================== State ==============================
const flags = []           // issues to surface at the end — never stop for them
const phaseSummaries = []  // one paragraph per completed phase, fed to next elaboration
const ephemeralTests = []  // accumulated from implementer reports, cleaned per boundary
const implConvos = new Map() // taskId -> {conversationId, difficulty, files, claimed} for chain reuse
let codexFailures = 0
let codexHealthy = true
let preface = ''

// ============================== Prompts ==============================
const implRules = `## Implementer rules
- Write complete, working code — no stubs, no placeholders, no TODO paths.
- Write every listed test, plus any needed to pin behavior you added — durable behavioral tests only. Write them; do NOT run them. Never write scaffolding tests (file-existence, symbol-name, module-structure, or mock-echo assertions) and never commit scratch scripts, debug code, or one-off verification — observations go in your report, and the plan's verify commands run at the phase boundary. If you committed a temporary artifact anyway, list it under ephemeral tests so the boundary removes it; that is a deviation, not a workflow.
- Do not run build, test, lint, format, or typecheck commands, and do not start dev servers. Verification happens at the phase boundary.
- Only make substantive edits to files listed under "Files you own". For files listed under "Shared", make only the minimal append-style edit described; other tasks may touch those files concurrently — re-read a shared file immediately before editing it, and if your edit conflicts on commit, re-apply just your lines.
- Git: exactly one commit for this task: git add <only your files> then git commit with a plain-English behavior summary. No stash, rebase, amend, checkout, or branch commands.
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

const adversarialInline = `Adversarially review this change with a clean eye. Assume the code is wrong and try to prove it. Priorities: (1) for each requirement listed, locate the exact code satisfying it and a test that would catch its removal — missing either is CRITICAL; (2) correctness under hostile inputs — boundaries, error paths, concurrency, cleanup, eager-vs-lazy; (3) paragraph-long justification comments mean the code is wrong; (4) stubs, swallowed errors, tests that assert mocks. Ignore style/formatting (CI owns those). Report only findings you can anchor to a file and a concrete failure scenario, each as: severity CRITICAL|MAJOR|MINOR, file, one-sentence defect, scenario, requirement id or n/a. End with verdict PASS or ISSUES (MINOR-only is PASS).`

// ============================== Helpers ==============================
async function runCodex(m, sandbox, prompt, opts, continueId) {
  if (!codexHealthy) return null
  const r = await agent(codexBriefing(m, sandbox, prompt, continueId, opts && opts.label), {
    agentType: 'code-factory:codex-runner', schema: RUNNER_SCHEMA, ...opts,
  })
  if (!r || r.status === 'CODEX_UNAVAILABLE') {
    codexFailures += 1
    if (codexFailures >= 2) {
      codexHealthy = false
      flags.push('Codex MCP marked unhealthy after repeated failures — remaining work ran on Anthropic fallback models')
      log('Codex unavailable twice — falling back to Anthropic models for the rest of the run')
    }
    return null
  }
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
    return false
  }
  if (r.ephemeralTests && r.ephemeralTests.length) ephemeralTests.push(...r.ephemeralTests)
  if (r.status === 'DONE_WITH_CONCERNS' && r.concerns) flags.push(`Task ${task.id} concern: ${r.concerns}`)
  return true
}

function registerConvo(task, impl) {
  if (impl && impl.engine === 'codex' && impl.conversationId) {
    implConvos.set(task.id, { conversationId: impl.conversationId, difficulty: task.difficulty, files: task.files, claimed: false })
  }
}

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
    ? `${taskBlock(task)}\n\n(Conventions: ${args.planDir}preface.md — consult only if needed.)\n\n${implRules}`
    : `${preface}\n\n${taskBlock(task)}\n\n${implRules}`
  let impl = await implement(task, prompt, { label: `impl:${task.id}`, phase: phaseLabel }, chainId)
  if (!recordResult(task, impl)) return
  registerConvo(task, impl)

  const nReviewers = task.risk === 'high' ? 2 : task.risk === 'standard' ? 1 : 0
  if (nReviewers === 0) return

  const reviewBody = () => `${preface}\n\nReview the implementation of: ${task.title}\nCommits: ${(impl.commits || []).join(', ') || 'most recent commits touching ' + task.files.join(', ')}\nFiles: ${task.files.join(', ')}\nRequirements:\n${(task.ears || []).map((e) => `- ${e}`).join('\n') || '- n/a'}\nTask context: ${task.context}`

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
        const r = await runCodex(REVIEW_TASK_CODEX, 'read-only',
          codexReviewId ? reviewBody() + recheck : `${reviewBody()}\n\n${adversarialInline}`,
          { label: `review-x:${task.id}`, phase: phaseLabel }, codexReviewId)
        if (!r) return agent(`${reviewBody() + recheck}\n\nTake a security-and-data-integrity lens in addition to correctness.`, {
          agentType: 'code-factory:adversarial-reviewer', model: 'opus', effort: 'high',
          schema: REVIEW_SCHEMA, label: `review-x:${task.id}`, phase: phaseLabel,
        })
        codexReviewId = r.conversationId || codexReviewId
        // Codex runner returns RUNNER_SCHEMA; map its summary into findings form
        const issues = /ISSUES/.test(r.summary) || r.status === 'DONE_WITH_CONCERNS'
        return { verdict: issues ? 'ISSUES' : 'PASS', findings: issues ? [{ severity: 'MAJOR', summary: r.summary }] : [] }
      })
    }
    const results = (await parallel(reviewers)).filter(Boolean)
    const findings = results.flatMap((x) => x.findings || []).filter((f) => f.severity !== 'MINOR')
    if (!results.some((x) => x.verdict === 'ISSUES') || !findings.length) return

    if (cycle === MAX_FIX_CYCLES) {
      flags.push(`Task ${task.id}: unresolved review findings after ${MAX_FIX_CYCLES} fix cycles: ${findings.map((f) => `[${f.severity}] ${f.summary}`).join('; ')}`)
      return
    }
    priorFindings = findings
    const fixPrompt = `An independent review of your work on "${task.title}" found issues. Resolve every finding, or state precisely why one is wrong instead of changing code. Make one additional commit.\n\nFindings:\n${findings.map((f) => `- [${f.severity}] ${f.file || ''} ${f.summary}${f.scenario ? ` | Scenario: ${f.scenario}` : ''}`).join('\n')}\n\n${implRules}`
    impl = impl.engine === 'codex' && impl.conversationId
      ? await implement(task, fixPrompt, { label: `fix:${task.id}`, phase: phaseLabel }, impl.conversationId)
      : await implement(task, `${preface}\n\n${fixPrompt}\n\nContext — what was built: ${impl.summary}`, { label: `fix:${task.id}`, phase: phaseLabel })
    if (!recordResult(task, impl)) return
    registerConvo(task, impl)
  }
}

// Wave scheduler: deps must be done; `files` are exclusive locks, `shared` is not.
async function runPhaseTasks(tasks, phaseLabel) {
  const done = new Set()
  let pending = [...tasks]
  while (pending.length) {
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
    await parallel(wave.map((t) => () => runTask(t, phaseLabel)))
    wave.forEach((t) => done.add(t.id))
    pending = pending.filter((t) => !done.has(t.id))
    log(`${phaseLabel}: ${done.size}/${tasks.length} tasks complete`)
  }
}

async function boundary(phaseLabel, checks) {
  for (let round = 1; round <= MAX_CHECK_ROUNDS; round++) {
    // Round 1 opens with a mechanical hygiene pass so plan artifacts and
    // throwaway code are stripped BEFORE any checks or reviews spend cycles
    // on them. Prevention lives upstream (elaborator + implementer rules);
    // this is the deterministic backstop.
    const hygiene = round === 1
      ? `First, a hygiene pass on this phase's diff (git diff against the commit where the phase started, or the phase's commits):\n1. Plan-vocabulary scan: grep the changed files for plan structure leaking into code — requirement ids (REQ-, EARS, or the spec's id scheme), phase/task/cycle references ("Phase 2", "Task 3.1", "Cycle B", "satisfies requirement"). Strip or rename every hit so the code reads as if the plan never existed.\n2. Scaffolding-test scan: in changed test files, delete tests that assert file existence, symbol names, module structure, empty stubs, or that a mock returns its configured value — unless deletion would leave a spec requirement without behavioral coverage, in which case rewrite as a behavioral test.${ephemeralTests.length ? `\n3. Implementer-reported temporary artifacts to remove: ${ephemeralTests.join('; ')}.` : ''}\nCommit hygiene fixes (plain-English message) if any files changed.\n\nThen: ` : ''
    const check = await agent(
      `${hygiene}Run the full check suite from ${args.repoRoot}, in order:\n${checks.map((c) => `- ${c}`).join('\n')}\nCapture failures. Group them by subsystem/package so independent fixers can work without touching the same files. For each group report: name, failing commands, implicated files, and a summary with the key error output. Do not fix anything yourself beyond the hygiene pass. green=true only if every command passed.`,
      { model: 'sonnet', effort: 'medium', schema: CHECKS_SCHEMA, label: `checks:r${round}`, phase: phaseLabel },
    )
    if (round === 1) ephemeralTests.length = 0
    if (!check) { flags.push(`${phaseLabel}: check agent died`); return }
    if (check.green) { log(`${phaseLabel}: checks green (round ${round})`); return }
    if (round === MAX_CHECK_ROUNDS) {
      flags.push(`${phaseLabel}: checks still failing after ${MAX_CHECK_ROUNDS} rounds: ${check.groups.map((g) => g.name).join(', ')}`)
      return
    }
    log(`${phaseLabel}: ${check.groups.length} failure group(s), dispatching fixers`)
    await parallel(check.groups.map((g) => () => (async () => {
      const p = `${preface}\n\nFix this group of failing checks. You may run ONLY the specific failing commands listed while iterating — never the full suite.\nGroup: ${g.name}\nCommands: ${(g.commands || []).join('; ')}\nImplicated files: ${(g.files || []).join(', ')}\nFailure summary:\n${g.summary}\n\nFind root causes — no test deletion, no assertion weakening, no skips. Commit your fix with a plain-English message. No plan vocabulary.`
      const r = await implement({ difficulty: 'average' }, p, { label: `fixer:${g.name}`, phase: phaseLabel })
      if (!r || r.status === 'BLOCKED') flags.push(`${phaseLabel}: fixer for "${g.name}" blocked: ${r ? r.summary : 'agent died'}`)
    })()))
  }
}

// ============================== Phase: Plan ==============================
phase('Plan')
log('Planning: exploring codebase and writing plan directory')
let plan = await agent(
  `Spec path: ${args.specPath}\nOutput directory: ${args.planDir}\nRepo root: ${args.repoRoot}\nBase branch: ${args.baseBranch}\n\nProduce the plan directory per your instructions (plan.md, preface.md, phases/*.md, empty tasks/). Return the structured summary. If the spec is too ambiguous to phase, return NEEDS_CONTEXT with questions.`,
  { agentType: 'code-factory:workflow-planner', effort: 'xhigh', schema: PLAN_SCHEMA, phase: 'Plan', label: 'planner' },
)
if (!plan || plan.status === 'NEEDS_CONTEXT') {
  return { outcome: 'NEEDS_CONTEXT', questions: plan ? plan.questions : ['planner agent died'], flags }
}
preface = plan.preface
if (plan.flags) flags.push(...plan.flags)

for (let cycle = 1; cycle <= MAX_PLAN_REVIEW_CYCLES; cycle++) {
  const planReviewPrompt = `Adversarially review the work plan in ${args.planDir} against the spec at ${args.specPath}. Assume the plan is wrong; attack: EARS requirements missing from the coverage matrix or double-assigned; phase seams that leave work unowned or owned twice; dependency errors between phases; phases that cannot be verified by the Checks commands; codebase claims that contradict the actual repo (read the files). Report findings with severity CRITICAL|MAJOR|MINOR and verdict PASS or ISSUES (MINOR-only is PASS).`
  let review = null
  const viaCodex = await runCodex(REVIEW_DEEP_CODEX, 'read-only', planReviewPrompt, { label: 'plan-review', phase: 'Plan' })
  if (viaCodex) review = { verdict: /ISSUES/.test(viaCodex.summary) ? 'ISSUES' : 'PASS', findings: [{ severity: 'MAJOR', summary: viaCodex.summary }] }
  else review = await agent(planReviewPrompt, { agentType: 'code-factory:adversarial-reviewer', model: 'opus', effort: 'xhigh', schema: REVIEW_SCHEMA, label: 'plan-review', phase: 'Plan' })
  if (!review || review.verdict === 'PASS') break
  log(`Plan review found issues (cycle ${cycle}) — dispatching planner fixes`)
  const fixed = await agent(
    `Fix mode. Plan directory: ${args.planDir}. Spec: ${args.specPath}. Apply these adversarial review findings (or rebut with reasons):\n${review.findings.map((f) => `- [${f.severity}] ${f.summary}`).join('\n')}\nReturn the updated structured summary.`,
    { agentType: 'code-factory:workflow-planner', effort: 'xhigh', schema: PLAN_SCHEMA, phase: 'Plan', label: 'planner-fix' },
  )
  if (fixed && fixed.status === 'DONE') { plan = fixed; preface = plan.preface }
  if (cycle === MAX_PLAN_REVIEW_CYCLES) flags.push('Plan review issues may remain after max fix cycles')
}
log(`Plan ready: ${plan.phases.length} phases`)

// ============================== Approval gate ==============================
// The one human checkpoint. First launch (no args.approved) writes an HTML
// briefing and pauses. The relaunch with resumeFromRunId + approved:true
// replays everything above from cache, applies feedback (if any), and runs
// the rest fully autonomously.
const approvalDoc = `${args.planDir}approval.md`
await agent(
  `Read ${args.planDir}plan.md, ${args.planDir}preface.md, and every phase sketch in ${args.planDir}phases/. Write a clean, well-formatted markdown briefing to ${approvalDoc} for the developer to review before implementation starts. Content, in order:\n1. High-level summary: what will be built, on branch ${args.branch} → PR "${args.prTitle}".\n2. Per phase (in order): name, goal, EARS requirements covered, and the 3-5 MOST IMPORTANT verifications that will prove the phase worked at its boundary — synthesize these from the phase goal, the Checks commands, and the spec's acceptance criteria; make each one concrete and checkable, not generic ("all tests pass" is banned).\n3. The full check suite that runs at every boundary.\n4. Assumptions and open flags: ${flags.join('; ') || 'none'}.\nKeep it tight and scannable — headers, tables, and short bullets; no filler. Return a 3-sentence plain-text summary of the plan.`,
  { model: 'sonnet', effort: 'medium', phase: 'Plan', label: 'approval-doc' },
)
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
    `Fix mode. Plan directory: ${args.planDir}. Spec: ${args.specPath}. The developer reviewed the plan and gave this feedback — apply it (update plan.md / preface.md / phase sketches as needed) and return the updated structured summary:\n${args.feedback}`,
    { agentType: 'code-factory:workflow-planner', effort: 'xhigh', schema: PLAN_SCHEMA, phase: 'Plan', label: 'planner-feedback' },
  )
  if (revised && revised.status === 'DONE') { plan = revised; preface = plan.preface }
  else flags.push('Applying plan feedback failed — proceeded with the plan as approved-page written; verify the feedback was honored')
}

// ============================== Execution phases ==============================
// Wall-clock: elaboration is pipelined one phase ahead. Phase N+1's elaborator
// starts the moment phase N's tasks begin implementing; a cheap drift check at
// the boundary triggers re-elaboration only when review/boundary fixes
// substantially changed what later phases build on (expected to be rare).
const NN = (id) => String(id).padStart(2, '0')

function elaborate(p, extraNote) {
  const landed = phaseSummaries.map((s) => `- ${s}`).join('\n') || '- nothing yet (first phase)'
  return agent(
    `Plan directory: ${args.planDir}\nPhase id: ${p.id} (phases/${NN(p.id)}-${p.slug}.md)\nSpec: ${args.specPath}\nRepo root: ${args.repoRoot}\nWhat prior phases actually landed:\n${landed}${extraNote ? `\n\n${extraNote}` : ''}\n\nElaborate this phase per your instructions: verify assumptions, produce the task list, write tasks/*.md files, update the phase file and plan.md status.`,
    { agentType: 'code-factory:dynamic-elaborator', effort: 'xhigh', schema: TASKS_SCHEMA, phase: `Phase ${p.id}: ${p.name}`, label: `elaborate:${p.id}` },
  )
}

function inFlightNote(p, tasks) {
  return `LOOKAHEAD MODE: Phase ${p.id} (${p.name}) is being implemented RIGHT NOW — its files are mid-flight in the working tree; do not treat their current state as final. For what phase ${p.id} will produce, trust its task files (tasks/${NN(p.id)}-*.md) and its goal: ${p.goal} Verify only earlier phases' code against the tree. If your task list depends heavily on phase ${p.id}'s exact output shapes, say so in phaseNotes so the orchestrator knows re-elaboration is likely if that phase drifts.`
}

const branchSetup = await agent(
  `In ${args.repoRoot}: create and check out branch ${args.branch} from ${args.baseBranch} (fetch first; if the branch exists, check it out and report its state). Report what you did.`,
  { model: 'haiku', effort: 'low', phase: 'Plan', label: 'branch-setup' },
)
if (!branchSetup) flags.push('Branch setup agent died — verify branch state')

let lookahead = elaborate(plan.phases[0], null)
for (let i = 0; i < plan.phases.length; i++) {
  const p = plan.phases[i]
  const next = plan.phases[i + 1]
  const label = `Phase ${p.id}: ${p.name}`
  phase(label)
  const elaborated = await lookahead
  if (!elaborated || !elaborated.tasks || !elaborated.tasks.length) {
    flags.push(`${label}: elaboration failed or returned no tasks — phase skipped`)
    if (next) lookahead = elaborate(next, null)
    continue
  }
  if (elaborated.flags) flags.push(...elaborated.flags)

  // Start the next phase's elaboration now — it runs while this phase implements.
  if (next) lookahead = elaborate(next, inFlightNote(p, elaborated.tasks))

  await runPhaseTasks(elaborated.tasks, label)

  const extraVerify = elaborated.tasks.flatMap((t) => t.verify || [])
  await boundary(label, [...plan.checks, ...extraVerify])

  const summ = await agent(
    `In ${args.repoRoot} on branch ${args.branch}, review the git log/diff for the work just completed ("${p.name}"). 1) summary: ≤120 words of plain prose on what actually landed — files created/modified, key interfaces. 2) substantialDrift: true ONLY if files, interfaces, or contracts that LATER phases build on ended up different from the planned tasks below (renames, moved modules, changed signatures, dropped tasks). Routine fixes and internal details are not drift.\nPlanned tasks:\n${elaborated.tasks.map((t) => `- ${t.title} → ${t.files.join(', ')}`).join('\n')}`,
    { model: 'haiku', effort: 'low', schema: SUMMARY_SCHEMA, phase: label, label: `summary:${p.id}` },
  )
  phaseSummaries.push(`Phase ${p.id} (${p.name}): ${summ ? summ.summary : p.goal}`)

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

log('Running final adversarial sweeps while CI runs')
const sweepDefs = [
  { key: 'quality', prompt: `Review the complete diff of branch ${args.branch} against ${args.baseBranch} in ${args.repoRoot}. Hunt: dead code, low-value or dishonest tests, duplicated logic that should merge, missing documentation where a maintainer needs it, poor naming, refactor opportunities that reduce net complexity. Anchor every finding to files. Severity CRITICAL|MAJOR|MINOR, verdict PASS or ISSUES.` },
  { key: 'compliance', prompt: `Review the complete diff of branch ${args.branch} against ${args.baseBranch} in ${args.repoRoot}, against the spec at ${args.specPath}. For EVERY EARS requirement: locate the implementing code and the test that would catch its removal. Also verify non-goals were not built and constraints were not broken. Missing implementation or test coverage for a requirement is CRITICAL. Severity per finding, verdict PASS or ISSUES.` },
]
const sweeps = await parallel(sweepDefs.map((s) => () => (async () => {
  const viaCodex = await runCodex(REVIEW_DEEP_CODEX, 'read-only', s.prompt, { label: `sweep:${s.key}`, phase: 'Deliver' })
  if (viaCodex) return { key: s.key, verdict: /ISSUES/.test(viaCodex.summary) ? 'ISSUES' : 'PASS', findings: [{ severity: 'MAJOR', summary: viaCodex.summary }] }
  const r = await agent(s.prompt, { agentType: 'code-factory:adversarial-reviewer', model: 'opus', effort: 'xhigh', schema: REVIEW_SCHEMA, label: `sweep:${s.key}`, phase: 'Deliver' })
  return r ? { key: s.key, ...r } : null
})()))
const sweepFindings = sweeps.filter(Boolean).flatMap((s) => (s.verdict === 'ISSUES' ? s.findings.map((f) => ({ ...f, sweep: s.key })) : []))
const actionable = sweepFindings.filter((f) => f.severity !== 'MINOR')
sweepFindings.filter((f) => f.severity === 'MINOR').forEach((f) => flags.push(`Final sweep (${f.sweep}, minor): ${f.summary}`))
if (actionable.length) {
  log(`Final sweeps: ${actionable.length} actionable finding(s) — dispatching fixes`)
  const p = `${preface}\n\nFinal review of the full branch diff surfaced these findings. Fix each or rebut with a precise reason. Commit in logical units and push.\n${actionable.map((f) => `- [${f.severity}] (${f.sweep}) ${f.file || ''} ${f.summary}`).join('\n')}\n\n${implRules.replace('exactly one commit for this task', 'one commit per logical fix')}`
  const r = await implement({ difficulty: 'average' }, p, { label: 'sweep-fixes', phase: 'Deliver' })
  if (!r || r.status === 'BLOCKED') flags.push(`Final sweep fixes incomplete: ${r ? r.summary : 'agent died'}`)
}

if (prUrl) {
  for (let round = 1; round <= MAX_CI_ROUNDS; round++) {
    const ci = await agent(
      `Watch CI for ${prUrl} from ${args.repoRoot} (gh pr checks ${prUrl} --watch; push the branch first if there are unpushed commits). When checks settle, report green=true/false. For failures, group them and report: check name as group name, key log output as summary, implicated files. Also read unresolved PR review comments from CI reviewer bots and include each as its own group. Do not fix anything.`,
      { model: 'sonnet', effort: 'medium', schema: CHECKS_SCHEMA, label: `ci:r${round}`, phase: 'Deliver' },
    )
    if (!ci) { flags.push('CI watch agent died — check PR manually'); break }
    if (ci.green) { log('CI green'); break }
    if (round === MAX_CI_ROUNDS) {
      flags.push(`CI not green after ${MAX_CI_ROUNDS} fix rounds: ${ci.groups.map((g) => g.name).join(', ')}`)
      break
    }
    log(`CI round ${round}: ${ci.groups.length} failing group(s), dispatching fixers`)
    await parallel(ci.groups.map((g) => () => (async () => {
      const p = `${preface}\n\nCI on PR ${prUrl} is failing. Fix this group at the root cause — no test deletion, no skips, no assertion weakening. You may run only the narrow commands needed to reproduce this failure locally. Commit and push.\nGroup: ${g.name}\nImplicated files: ${(g.files || []).join(', ')}\nFailure detail:\n${g.summary}`
      const r = await implement({ difficulty: 'average' }, p, { label: `ci-fix:${g.name}`, phase: 'Deliver' })
      if (!r || r.status === 'BLOCKED') flags.push(`CI fixer for "${g.name}" blocked: ${r ? r.summary : 'agent died'}`)
    })()))
  }
}

return {
  outcome: prUrl ? 'PR_OPEN' : 'NO_PR',
  prUrl,
  phases: phaseSummaries,
  flags,
}
