// The minimal shape of a dynamic delivery workflow, for changes that don't
// need a spec, phases, or an approval gate: plan → implement in parallel
// worktrees → adversarial review → integrate (which cleans up its worktrees)
// → verify once at the end → PR. Copy this file as the starting point for
// custom workflows; full-delivery.js is the maximal version of the same shape.
export const meta = {
  name: 'mini-feature',
  description: 'Small scoped change: plan tasks, implement in parallel worktrees with adversarial review, verify once, open a PR',
  whenToUse: 'Dispatched by the execute-dynamic-workflow skill for small, well-scoped work with args {task, repoRoot, skillDir, baseBranch, branch, prTitle}',
  phases: [
    { title: 'Plan', detail: 'branch setup, explore, task list' },
    { title: 'Implement', detail: 'parallel worktree implementers, adversarial review, integrate' },
    { title: 'Verify', detail: 'hygiene scan, check suite, PR' },
  ],
}

const REQUIRED = ['task', 'repoRoot', 'skillDir', 'baseBranch', 'branch', 'prTitle']
const A = typeof args === 'string' ? JSON.parse(args) : args
const missing = REQUIRED.filter((k) => !A || typeof A[k] !== 'string' || !A[k].trim())
if (missing.length) throw new Error(`mini-feature: missing args: ${missing.join(', ')}`)

// Codex invocation per the codex-mcp skill (workspace-write + network +
// main-repo .git writable); Anthropic fallback if the MCP is unavailable.
const IMPL = { model: 'gpt-5.6-terra', effort: 'medium' }
const CODEX_CONFIG = JSON.stringify({
  model_reasoning_effort: IMPL.effort,
  sandbox_workspace_write: { network_access: true, writable_roots: [`${A.repoRoot}/.git`] },
})
const WT_BASE = `${A.repoRoot}.worktrees`
const wt = (id) => `${WT_BASE}/${id}`
const flags = []

const ironLaws = `Iron laws: complete working code, no stubs. Write durable behavioral tests but do NOT run them (or any build/lint commands) — verification happens later. Never reference the plan, task ids, or requirement ids in code, tests, comments, or commit messages. Commit on the current branch with plain git add/commit; no rebase, amend, or branch commands.`

function relay(cwd, prompt, label, threadId) {
  return agent([
    `You are a Codex session runner — a thin relay; never write code yourself.`,
    `1. ToolSearch \`select:mcp__codex__codex,mcp__codex__codex-reply\`.`,
    `2. ${threadId ? `Call mcp__codex__codex-reply with threadId ${threadId} and the prompt below.` : `Call mcp__codex__codex with the prompt below verbatim, model ${IMPL.model}, sandbox workspace-write, approval-policy never, cwd ${cwd}, config ${CODEX_CONFIG}.`}`,
    `3. On error retry once; on a second error report CODEX_UNAVAILABLE with the literal error.`,
    `Report: status DONE|BLOCKED|CODEX_UNAVAILABLE ("could not finish" is BLOCKED), threadId, summary.`,
    `PROMPT:`,
    prompt,
  ].join('\n'), { model: 'haiku', label, schema: RUNNER, phase: 'Implement' })
}
const RUNNER = {
  type: 'object',
  properties: { status: { enum: ['DONE', 'BLOCKED', 'CODEX_UNAVAILABLE'] }, threadId: { type: 'string' }, summary: { type: 'string' } },
  required: ['status', 'summary'],
}
async function implement(cwd, prompt, label, threadId) {
  const r = await relay(cwd, prompt, label, threadId)
  if (r && r.status !== 'CODEX_UNAVAILABLE') return r
  flags.push(`${label}: Codex unavailable — ran on Claude fallback`)
  return agent(`${prompt}\n\nWork in ${cwd}.`, { model: 'sonnet', label, schema: RUNNER, phase: 'Implement' })
}

// ---- Plan: one expensive agent does branch setup + exploration + task list.
phase('Plan')
const PLAN = {
  type: 'object',
  properties: {
    preface: { type: 'string' },  // conventions block every prompt starts with
    checks: { type: 'array', items: { type: 'string' } },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' }, title: { type: 'string' }, context: { type: 'string' },
          deps: { type: 'array', items: { type: 'string' } },
          risky: { type: 'boolean' },  // risky → adversarially reviewed
        },
        required: ['id', 'title', 'context', 'deps', 'risky'],
      },
    },
    blocked: { type: 'string' },
  },
  required: ['preface', 'checks', 'tasks'],
}
const plan = await agent(
  `In ${A.repoRoot}: verify the working tree is clean (if dirty, return blocked naming the files), then create/check out branch ${A.branch} from ${A.baseBranch}.\n\nThe change to deliver:\n${A.task}\n\nRun the repo's typecheck/build first and read every error: if the tree is already red, each error is required work and must be assigned to a task explicitly, naming file and symbol.\n\nExplore the codebase, then return: preface (≤30 lines: stack, conventions with pattern-file paths, directories not to touch), checks (the repo's build/lint/typecheck/test commands), and 1-6 tasks. Per task: id (short slug), title, context (≤150 words of current-state facts, decisions made, and file references — an implementer must never search), deps (task ids), risky (true if a defect would be subtle or damaging → gets adversarial review).\n\nSIZING: one concern per task, ~100-150 changed lines. Split a schema/data-structure change from the behavior consuming it, and both from bulk test updates — a task whose title needs "and" to join two unrelated verbs is too big. Oversized tasks are discarded whole when review fails, losing the correct parts with the bad. Tasks run in parallel worktrees, so each wave needs disjoint file footprints — when two tasks must touch one file, give the second a dep so they land in different waves rather than merging them into one big task.`,
  { model: 'opus', effort: 'high', schema: PLAN, label: 'plan', phase: 'Plan' },
)
if (!plan || plan.blocked || !plan.tasks || !plan.tasks.length) {
  return { outcome: 'BLOCKED', detail: plan ? plan.blocked || 'planner returned no tasks' : 'planner died', flags }
}
log(`Plan: ${plan.tasks.length} task(s) — ${plan.tasks.map((t) => t.title).join('; ')}`)

// ---- Implement: waves by dependency; each task in its own worktree.
phase('Implement')
const REVIEW = {
  type: 'object',
  properties: {
    verdict: { enum: ['PASS', 'ISSUES'] },
    findings: { type: 'array', items: { type: 'object', properties: { severity: { enum: ['CRITICAL', 'MAJOR', 'MINOR'] }, summary: { type: 'string' } }, required: ['severity', 'summary'] } },
  },
  required: ['verdict', 'findings'],
}

async function runTask(t) {
  const cwd = wt(t.id)
  const prompt = `${plan.preface}\n\n## Task: ${t.title}\nYour worktree (work ONLY here): ${cwd}\n${t.context}\n\n${ironLaws}`
  let impl = await implement(cwd, prompt, `impl:${t.id}`)
  if (!impl || impl.status === 'BLOCKED') { flags.push(`${t.id} blocked: ${impl ? impl.summary : 'agent died'}`); return false }
  if (!t.risky) { log(`  ✓ ${t.id}`); return true }

  // Adversarial review, clean context, from the main checkout. Cycle 1
  // continues the implementer's session; cycle 2 dispatches a fresh session
  // (a session that failed to fix once repeats its misunderstanding). After
  // the last cycle we LAND with a flag unless a CRITICAL survived — work that
  // failed review is usually mostly right, and the boundary check still runs.
  for (let cycle = 0; cycle < 3; cycle++) {
    const review = await agent(
      `${plan.preface}\n\nAdversarially review the diff ${A.branch}...task/${t.id} in ${A.repoRoot} for: "${t.title}" (context: ${t.context}). Assume it is wrong; attack correctness under hostile inputs, dishonest tests (would a real bug fail them? would a valid refactor break them?), plan vocabulary in code/tests/comments, stubs, swallowed errors. Verdict PASS or ISSUES; MINOR-only is PASS.`,
      { agentType: 'code-factory:adversarial-reviewer', model: 'opus', effort: 'high', schema: REVIEW, label: `review:${t.id}`, phase: 'Implement' },
    )
    const findings = review ? (review.findings || []).filter((f) => f.severity !== 'MINOR') : []
    if (!review) { flags.push(`${t.id}: review agent died — UNVERIFIED`); return true }
    if (review.verdict === 'PASS' || !findings.length) { log(`  ✓ ${t.id} — review PASS${cycle ? ' after fix' : ''}`); return true }
    if (cycle === 2) {
      flags.push(`${t.id}: landed with unresolved findings after 3 cycles: ${findings.map((f) => `[${f.severity}] ${f.summary}`).join('; ')}`)
      return !findings.some((f) => f.severity === 'CRITICAL')
    }
    const fixPrompt = `Review of "${t.title}" found issues — fix each at the root cause (or rebut precisely), one additional commit. Fix ONLY what is listed; do not refactor beyond the findings (scope creep here fails the next review):\n${findings.map((f) => `- [${f.severity}] ${f.summary}`).join('\n')}\n\n${ironLaws}`
    impl = cycle === 0
      ? await implement(cwd, fixPrompt, `fix:${t.id}`, impl.threadId)
      // Fresh session: it has never seen the task, so restate the context.
      : await implement(cwd, `${plan.preface}\n\nYou are taking over a task another session could not finish correctly. Its work is already committed in this worktree; review it, then fix what the findings identify.\n\n## Task: ${t.title}\nYour worktree (work ONLY here): ${cwd}\n${t.context}\n\n${fixPrompt}`, `fix2:${t.id}`)
    if (!impl || impl.status === 'BLOCKED') { flags.push(`${t.id} fix blocked`); return false }
  }
  return true
}

const done = new Set()
let pending = [...plan.tasks]
while (pending.length) {
  const wave = pending.filter((t) => t.deps.every((d) => done.has(d)))
  if (!wave.length) { flags.push(`dependency deadlock: ${pending.map((t) => t.id).join(', ')}`); break }

  await agent(
    `In ${A.repoRoot}, create a git worktree per task from ${A.branch} (remove path + branch first if left over from a crashed run):\n${wave.map((t) => `- git worktree add "${wt(t.id)}" -b "task/${t.id}" ${A.branch}`).join('\n')}\nReport "ready".`,
    { model: 'haiku', effort: 'low', label: 'worktrees:setup', phase: 'Implement' },
  )
  const results = await parallel(wave.map((t) => () => runTask(t)))
  const merged = wave.filter((_, i) => results[i])

  // Integration owns cleanup: merge or discard every task branch, and remove
  // its worktree in the same step — worktrees never outlive their task.
  await agent(
    `In ${A.repoRoot} on branch ${A.branch} (checkout first): merge in order ${merged.map((t) => `task/${t.id}`).join(', ') || '(none)'} with git merge --no-ff. Resolve conflicts yourself, keeping both tasks' intended behavior.\n\nThen remove the worktree under ${WT_BASE} for every task in this wave (git worktree remove --force), including the unmerged: ${wave.filter((_, i) => !results[i]).map((t) => `task/${t.id}`).join(', ') || '(none)'}.\n\nDelete the BRANCH (git branch -D) only for branches that merged. For unmerged tasks, RENAME the branch to "salvage/<id>" instead of deleting it — failed review usually means mostly-right work, and it must stay recoverable. Finish with git worktree prune. Report what merged and any salvage branch names.`,
    { model: 'sonnet', effort: 'medium', label: 'worktrees:integrate', phase: 'Implement' },
  )
  wave.forEach((t) => done.add(t.id))
  pending = pending.filter((t) => !done.has(t.id))
}

// ---- Verify: hygiene scan + full suite, at the end — not per task.
phase('Verify')
const CHECKS = {
  type: 'object',
  properties: { green: { type: 'boolean' }, detail: { type: 'string' } },
  required: ['green'],
}
await agent(
  `In ${A.repoRoot} on ${A.branch}: run bash "${A.skillDir}/scripts/scan-plan-vocab.sh" "${A.repoRoot}" "${A.baseBranch}". If it reports hits, strip every one and re-run until clean, then commit. Report the final scan output.`,
  { model: 'haiku', effort: 'low', label: 'hygiene', phase: 'Verify' },
)
let green = false
for (let round = 1; round <= 3 && !green; round++) {
  const check = await agent(
    `Run from ${A.repoRoot}, in order, all of:\n${plan.checks.map((c) => `- ${c}`).join('\n')}\nReport green=true only if everything passed; otherwise detail = the failures verbatim, grouped by root cause. Fix nothing.`,
    { model: 'haiku', effort: 'medium', schema: CHECKS, label: `checks:r${round}`, phase: 'Verify' },
  )
  if (!check) { flags.push('check agent died — UNVERIFIED'); break }
  green = check.green
  if (!green && round < 3) {
    await implement(A.repoRoot, `${plan.preface}\n\nFix these failing checks at the root cause — no test deletion, no assertion weakening. Run only the failing commands while iterating. Commit when done.\n\n${check.detail}\n\n${ironLaws}`, `fix-checks:r${round}`)
  } else if (!green) {
    flags.push(`checks still red after fixes: ${(check.detail || '').slice(0, 300)}`)
  }
}

const pr = await agent(
  `In ${A.repoRoot} on ${A.branch}: push and open a PR against ${A.baseBranch} titled ${JSON.stringify(A.prTitle)} using gh. Body: what changed and why${flags.length ? `, plus "Flagged for human attention:" with:\n${flags.map((f) => `- ${f}`).join('\n')}` : ''}. End with the standard Claude Code attribution. Return the URL.`,
  { model: 'sonnet', effort: 'low', schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }, label: 'open-pr', phase: 'Verify' },
)

return { outcome: pr && pr.url ? (green ? 'PR_OPEN' : 'PR_OPEN_WITH_FAILURES') : 'NO_PR', prUrl: pr ? pr.url : null, green, flags }
