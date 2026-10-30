export const meta = {
  name: 'judge-round',
  description: 'Score a committed repo against docs/judge/RUBRIC.md: six dimension agents, a Meta bonus agent, an adversary with two refuters per critical finding, and a final judge',
  phases: [
    {title: 'Score', detail: 'one agent per rubric dimension, plus the Meta tooling bonus', model: 'haiku'},
    {title: 'Attack', detail: 'one adversarial agent tries to break every README claim', model: 'haiku'},
    {title: 'Refute', detail: 'two independent refuters per critical finding', model: 'haiku'},
    {title: 'Judge', detail: 'final verdict at max effort', model: 'fable'},
  ],
}

const {ref, round, wt, node_bin, today} = args
const WEIGHTS = {ambition: 0.25, depth: 0.25, works: 0.20, evidence: 0.15, clarity: 0.10, execution: 0.05}

const EVIDENCE_ITEM = {
  type: 'object',
  properties: {
    ref: {type: 'string', description: 'repo-relative path:line (e.g. pipeline/steps/s11_ignition.py:212), or "cmd: <command>" for command output'},
    quote: {type: 'string', description: 'the exact line(s) or output this point rests on'},
    point: {type: 'string', description: 'what this shows'},
    effect: {type: 'string', enum: ['awarded', 'withheld']},
  },
  required: ['ref', 'quote', 'point', 'effect'],
}
const SCORE = {
  type: 'object',
  properties: {
    score: {type: 'number', minimum: 0, maximum: 10},
    rationale: {type: 'string'},
    evidence: {type: 'array', items: EVIDENCE_ITEM, minItems: 4},
    top_fixes: {type: 'array', items: {type: 'string'}, description: 'the changes that would raise this score most, most valuable first'},
  },
  required: ['score', 'rationale', 'evidence', 'top_fixes'],
}
const BONUS = {
  type: 'object',
  properties: {
    bonus: {type: 'number', minimum: 0, maximum: 3},
    rationale: {type: 'string'},
    evidence: {type: 'array', items: EVIDENCE_ITEM, minItems: 3},
    top_fixes: {type: 'array', items: {type: 'string'}},
  },
  required: ['bonus', 'rationale', 'evidence', 'top_fixes'],
}
const FINDINGS = {
  type: 'object',
  properties: {
    claims_checked: {type: 'array', items: {type: 'object', properties: {
      claim_ref: {type: 'string'}, claim: {type: 'string'}, verdict: {type: 'string', enum: ['holds', 'broken', 'not_counted']}, how_checked: {type: 'string'}},
      required: ['claim_ref', 'claim', 'verdict', 'how_checked']}},
    findings: {type: 'array', items: {type: 'object', properties: {
      id: {type: 'string'},
      severity: {type: 'string', enum: ['critical', 'major', 'minor']},
      claim: {type: 'string'},
      claim_ref: {type: 'string', description: 'path:line of the claim'},
      contradiction_ref: {type: 'string', description: 'path:line or "cmd: <command>" that contradicts it'},
      evidence: {type: 'string', description: 'quoted lines or command output'},
      why: {type: 'string'}},
      required: ['id', 'severity', 'claim', 'claim_ref', 'contradiction_ref', 'evidence', 'why']}},
  },
  required: ['claims_checked', 'findings'],
}
const REFUTE = {
  type: 'object',
  properties: {
    refuted: {type: 'boolean'},
    evidence: {type: 'string', description: 'quoted lines or read-only command output that support your verdict'},
    refs: {type: 'array', items: {type: 'string'}},
  },
  required: ['refuted', 'evidence', 'refs'],
}
const VERDICT = {
  type: 'object',
  properties: {
    verdict: {type: 'string', enum: ['approve', 'reject']},
    rationale: {type: 'string'},
    disagreements: {type: 'array', items: {type: 'object', properties: {
      dimension: {type: 'string'}, panel_score: {type: 'number'}, judge_score: {type: 'number'}, evidence: {type: 'string'}},
      required: ['dimension', 'panel_score', 'judge_score', 'evidence']}},
    top_fixes: {type: 'array', items: {type: 'object', properties: {
      fix: {type: 'string'}, dimension: {type: 'string'}, expected_effect: {type: 'string'}, refs: {type: 'array', items: {type: 'string'}}},
      required: ['fix', 'dimension', 'expected_effect']}, minItems: 3},
  },
  required: ['verdict', 'rationale', 'disagreements', 'top_fixes'],
}

const base = (dir, mayRun) => `You are one member of a panel judging a hackathon repository against a fixed rubric. The repository is a git worktree at:
  ${dir}
checked out at commit ${ref}. Today is ${today}, partway through the hackathon (submission is Tue Nov 3, 2026). Read the rubric first: ${dir}/docs/judge/RUBRIC.md.

Rules:
- Every point you award or withhold cites evidence as a repo-relative path:line, or "cmd: <command>" with its output, and quotes the line(s) it rests on. A score without evidence is invalid.
- Scale: 5 = an ordinary, competent hackathon entry; 8 = clearly among the best; 10 = exceptional. Use the whole range and do not default to the middle.
- Judge what the repository contains and does, not what its docs promise. The build is split into three workstreams (docs/spec/WORKSTREAMS.md). Parts the README itself marks as not started, pending an API key, or not yet run are neither broken nor credited.
- ${mayRun ? 'You may run commands in this worktree only. Do not touch any other directory.' : 'Read-only: you may run read-only commands (cat, grep, git log, python3 -c that only reads files) but must not create, edit or delete files.'} Never push, never contact anyone, never print secrets.
- Your final answer is the structured output only. Keep every quote under 200 characters, use forward slashes in paths, and never put raw newlines, tabs or backslashes inside a JSON string.`

const DIMENSIONS = [
  {key: 'ambition', dir: wt.read, run: false, prompt:
    `Score AMBITION (weight 25%). Rubric question: "Is the core problem new or hard, or is it a familiar app with a model attached? Reward something that wasn't possible a year ago." Work out what the core problem actually is from the code and README, how hard it is, and whether the repo is a familiar app with a model attached. Weigh what was not possible a year ago (data, models, methods) against what is ordinary.`},
  {key: 'depth', dir: wt.read, run: false, prompt:
    `Score DEPTH OF THE HARD PART (weight 25%). Rubric question: "How much of the repo is original logic (algorithms, pipelines, agent loops, custom evals) versus glue around one API call? A thin wrapper scores low however polished it is." Read the code itself, not just the docs: find the hard part(s), read them in full, and judge originality and correctness. Note anything that is shallow, copied, wrong, or only appears sophisticated. Estimate the share of original logic versus glue.`},
  {key: 'works', dir: wt.read, run: false, needsRunLog: true, prompt:
    `Score IT ACTUALLY WORKS (weight 20%). Rubric question: "Run the demo path in a sandbox. Flag mocked responses, hardcoded outputs and demos that only work on one canned input."
A separate runner agent executed the repository's documented commands in a clean worktree; its raw log is below. Judge from that log (exit codes, failures, whether reruns reproduce the committed numbers) and from reading the code: what does the web app actually render (web/src), which layers are real data versus simulated, does the analyst endpoint behave as documented without a key, and is anything on the demo path mocked, hardcoded or limited to one canned input? A command that failed in the log is evidence; cite it as "cmd: <command>".`},
  {key: 'evidence', dir: wt.read, run: false, prompt:
    `Score EVIDENCE (weight 15%). Rubric question: "Real data, benchmarks or eval numbers that back up the README's claims." For each quantitative claim in README.md, find the committed file that backs it (docs/RESULTS.md, web/public/data/*/eval/*.json, web/public/data/*/*.json) and check the number matches. Then judge whether the benchmarks are meaningful: what the ground truth is, whether baselines are sensible, whether evaluation data is held out, whether there is leakage, and whether limits and failures are reported.`},
  {key: 'clarity', dir: wt.read, run: false, prompt:
    `Score CLARITY OF THE PITCH (weight 10%). Rubric question: "Does the README name the user, the problem and why now, and does the demo match it?" Read README.md as a judge seeing it for the first time. Then check the demo path it describes (the "What works today" and "Reproduce" sections) against what the repository actually contains.`},
  {key: 'execution', dir: wt.read, run: false, prompt:
    `Score EXECUTION (weight 5%). Rubric question: "Are commits spread across the hackathon window rather than one big dump? This also catches code written before the event." Run git log --format='%h %ad %an %s' --date=iso and git log --stat --format='%h %ad %s' --date=iso in the worktree. The plan in docs/spec/BUILD.md (schedule section) starts Thu Oct 29, 2026. Judge the commit pattern so far (it is mid-event), the size and coherence of each commit, and any sign of code written before the event.`},
]

const RUN_PROMPT = `You are the command runner for a judging panel. Run each command below in order, in the git worktree at ${wt.run} only, each with a Bash timeout of 600000 ms. Do not edit tracked files and do not try to fix failures: record them.
  1. cd ${wt.run}/pipeline && uv sync && make test
  2. cd ${wt.run}/pipeline && make eval EVAL_DIR=/tmp/ember-judge-r${round}-run
     then compare /tmp/ember-judge-r${round}-run/ignition_holdout.json with the committed ${wt.run}/web/public/data/eaton/eval/ignition_holdout.json (python3 -c that loads both and prints any differing values).
  3. cd ${wt.run}/pipeline && make eval QUICK=1 EVAL_DIR=/tmp/ember-judge-r${round}-quick
     then print /tmp/ember-judge-r${round}-quick/ignition_check.json.
  4. cd ${wt.run}/web && export PATH="${node_bin}:$PATH" && node --version && npm ci && npm test && npm run build
  5. cd ${wt.run}/web && export PATH="${node_bin}:$PATH" && npm run eval:analyst -- --truth
Return a plain-text log (not JSON): for each command, the exact command, its exit code, its wall time, and the last 25 lines of its output, then the comparison results verbatim. Report facts only, no scores.`

const BONUS_PROMPT = `Award the META TOOLING BONUS (0 to 3 points, added to the total). Rubric: "Real effort on Meta's models or tooling (Llama, Muse Spark, SAM 3.1, the Meta Model API): code that calls them, tests or evals that exercise them, and design shaped by them. Name-dropping scores 0. A Meta API call that is gated on a key the sandbox doesn't have can earn bonus credit for design and offline tests, but not for 'it works'." Find every place a Meta model is used or mentioned (grep for muse, sam, llama, meta.ai, MODEL_API_KEY across the repo), and separate real integration (request code, tool definitions, response handling, tests, evals) from mentions. Say which parts are working, which are built but untested live, and which are only planned.`

const ATTACK_PROMPT = `Your only job is to BREAK this project's claims.
1. Read README.md and every doc it links to (docs/RESULTS.md, docs/spec/*.md, docs/judge/RUBRIC.md). List every factual claim: numbers, "works", "tested", "calibrated", "never", "held out", data provenance, privacy promises, test counts, file contents.
2. Try to break each one: recompute numbers from the committed files, read the code paths that produce each number, and look for hardcoded outputs, mocked responses, canned inputs, numbers that don't match their source, leakage between fit and evaluation, and behaviour that contradicts the docs. A runner agent has already run the README's documented commands (make test, make eval, make eval QUICK=1, npm ci/test/build, the analyst truth table) in a clean worktree; its raw log is at the end of this prompt and counts as evidence (cite it as "cmd: <command>"). Do not rerun make eval or make eval QUICK=1 (each takes 5-15 minutes of all CPUs). You may run other offline commands in this worktree, e.g.:
   cd ${wt.attack}/pipeline && uv sync && make test
   cd ${wt.attack}/web && export PATH="${node_bin}:$PATH" && npm ci && npm test && npm run eval:analyst -- --truth --fire palisades
   python3 -c '...' to recompute numbers from JSON files.
3. Default: a claim you cannot reproduce in this worktree counts as broken. Claims the README itself marks as pending, needing a key, or not run are "not_counted".
Severity: critical = the claim is false, or a demo or number is faked; major = overstated, or missing its evidence; minor = wording. Every finding cites the claim (path:line) and the contradicting path:line or command output, with quotes. Report every claim you checked in claims_checked, including the ones that hold.`

const refutePrompt = (f, i) => `An adversarial reviewer of a hackathon repository reported this CRITICAL finding:

${JSON.stringify(f, null, 2)}

You are independent refuter #${i + 1}. Try to REFUTE it: show, with evidence from the repository, that the claim is in fact true and supported, or that the README itself marks it as pending / needing a key / not run, or that the finding misreads the code or data. Read the cited files yourself and check the reviewer's reasoning step by step. Refute only with concrete evidence (quoted path:line, or read-only command output). If the finding is correct, or you are not sure, set refuted = false.`

phase('Score')
log(`Judging ${ref} (round ${round})`)

// A structured-output failure is a harness fault, not a measurement: retry once before giving up.
const RETRY_NOTE = '\n\nA previous attempt at this task failed to produce valid structured output. Keep the output compact: at most 8 evidence items, short quotes, plain ASCII punctuation inside strings.'
const ask = async (prompt, opts) => {
  const first = await agent(prompt, opts)
  if (first) return first
  log(`${opts.label}: no valid output, retrying once`)
  return agent(prompt + RETRY_NOTE, {...opts, label: `${opts.label}#retry`})
}

const runLog = agent(RUN_PROMPT, {label: 'run:commands', phase: 'Score', model: 'haiku'})
const scoreAll = DIMENSIONS.map(d => async () => {
  const extra = d.needsRunLog ? `\n\nRunner log:\n${(await runLog) || '(the runner agent failed; no commands were run)'}` : ''
  const r = await ask(`${base(d.dir, d.run)}\n\n${d.prompt}${extra}`, {label: `score:${d.key}`, phase: 'Score', schema: SCORE, model: 'haiku'})
  return r ? {key: d.key, ...r} : null
})
const bonusThunk = () => ask(`${base(wt.read, false)}\n\n${BONUS_PROMPT}`, {label: 'score:meta-bonus', phase: 'Score', schema: BONUS, model: 'haiku'})

// The adversary starts after the runner, reads its log and does not rerun the long evals:
// running both at once starved each of CPU past the 10-minute command limit.
const attackThunk = async () => {
  const runText = (await runLog) || '(the runner agent failed; no commands were run)'
  const atk = await ask(`${base(wt.attack, true)}\n\n${ATTACK_PROMPT}\n\nRunner log:\n${runText}`, {label: 'attack', phase: 'Attack', schema: FINDINGS, model: 'haiku'})
  if (!atk) return {attack: null, criticals: []}
  const crit = atk.findings.filter(f => f.severity === 'critical')
  log(`adversary: ${atk.findings.length} findings, ${crit.length} critical, ${atk.claims_checked.length} claims checked`)
  const criticals = await parallel(crit.map(f => () =>
    parallel([0, 1].map(i => () =>
      ask(`${base(wt.read, false)}\n\n${refutePrompt(f, i)}`, {label: `refute:${f.id}#${i + 1}`, phase: 'Refute', schema: REFUTE, model: 'haiku'})))
      .then(votes => {
        const v = votes.filter(Boolean)
        return {...f, refuters: v, survives: !(v.length === 2 && v.every(x => x.refuted))}
      })))
  return {attack: atk, criticals: criticals.filter(Boolean)}
}

const results = await parallel([...scoreAll, bonusThunk, attackThunk])
const scores = results.slice(0, DIMENSIONS.length)
const bonusR = results[DIMENSIONS.length]
const atkR = results[DIMENSIONS.length + 1] || {attack: null, criticals: []}

const missing = DIMENSIONS.filter((d, i) => !scores[i]).map(d => d.key)
if (missing.length) log(`missing scores (counted as 0): ${missing.join(', ')}`)
const byKey = Object.fromEntries(DIMENSIONS.map((d, i) => [d.key, scores[i] || {key: d.key, score: 0, rationale: 'agent failed', evidence: [], top_fixes: []}]))
const weighted = Math.round(Object.entries(WEIGHTS).reduce((s, [k, w]) => s + w * byKey[k].score * 10, 0) * 10) / 10
const bonus = bonusR ? Math.min(3, Math.max(0, bonusR.bonus)) : 0
const total = Math.round((weighted + bonus) * 10) / 10
const surviving = atkR.criticals.filter(c => c.survives)
log(`weighted ${weighted} + bonus ${bonus} = ${total}; surviving critical findings: ${surviving.length}`)

phase('Judge')
const panel = {
  weights: WEIGHTS,
  scores: Object.fromEntries(Object.entries(byKey).map(([k, v]) => [k, {score: v.score, rationale: v.rationale, evidence: v.evidence, top_fixes: v.top_fixes}])),
  weighted, bonus: bonusR, total,
  adversary: atkR.attack ? {findings: atkR.attack.findings, claims_checked: atkR.attack.claims_checked.length} : null,
  critical_findings: atkR.criticals.map(c => ({id: c.id, claim: c.claim, claim_ref: c.claim_ref, survives: c.survives, refuters: c.refuters})),
}
const judge = await ask(`You are the final judge of a hackathon repository, judged against the fixed rubric at ${wt.read}/docs/judge/RUBRIC.md. The repository is checked out read-only at ${wt.read} (commit ${ref}); you may read it and run read-only commands to spot-check anything. Today is ${today}, mid-hackathon.

A panel scored each dimension with file:line evidence, an adversarial agent tried to break the README's claims, and two independent refuters checked each critical finding. The arithmetic is done for you and is fixed: weighted score ${weighted}/100, Meta bonus ${bonus}/3, total ${total}; ${surviving.length} critical finding(s) survived refutation.

Panel output:
${JSON.stringify(panel, null, 2)}

Approval requires all three: total >= 80, zero surviving critical findings, and your "approve". Read the evidence critically: check the panel's strongest and weakest claims against the repository yourself, and say where you disagree with a panel score and why (your disagreement is recorded but does not change the arithmetic). Then give your verdict with a rationale, and the fixes ranked by how much they would raise the rubric score, each tied to a dimension and to the files involved. Be specific enough that an engineer could act on each fix without re-reading this panel.`, {label: 'final-judge', phase: 'Judge', schema: VERDICT, model: 'fable', effort: 'max'})

const approved = total >= 80 && surviving.length === 0 && judge?.verdict === 'approve'
return {ref, round, weights: WEIGHTS, scores: byKey, bonus: bonusR, weighted, total, run_log: await runLog,
        adversary: atkR.attack, critical_findings: atkR.criticals, surviving_critical: surviving.length,
        judge, approved}
