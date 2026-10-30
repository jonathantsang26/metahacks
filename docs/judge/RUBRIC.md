# Judge rubric

We score the repo with this rubric every round, so the result stays consistent from round to round. The rubric is fixed before the first round and does not change between rounds. If it ever has to change, the change is committed here with a reason.

## Dimensions and weights

Each dimension is scored **0–10** by its own agent. Every point awarded or withheld must cite file:line evidence.

| Dimension | Weight | Question |
|---|---|---|
| Ambition | 25% | Is the core problem new or hard, or is it a familiar app with a model attached? Reward something that wasn't possible a year ago. |
| Depth of the hard part | 25% | How much of the repo is original logic (algorithms, pipelines, agent loops, custom evals) versus glue around one API call? A thin wrapper scores low however polished it is. |
| It actually works | 20% | Run the demo path in a sandbox. Flag mocked responses, hardcoded outputs and demos that only work on one canned input. |
| Evidence | 15% | Real data, benchmarks or eval numbers that back up the README's claims. |
| Clarity of the pitch | 10% | Does the README name the user, the problem and why now, and does the demo match it? |
| Execution | 5% | Are commits spread across the hackathon window rather than one big dump? This also catches code written before the event. |

**Weighted score** = Σ weight × score × 10, giving a total out of 100. The workflow script computes it, so it is the same arithmetic every round.

**Meta tooling bonus**: 0 to +3 points, added to the total.
- Real effort on Meta's models or tooling (Llama, Muse Spark, SAM 3.1, the Meta Model API): code that calls them, tests or evals that exercise them, and design shaped by them.
- Name-dropping scores 0.
- A Meta API call that is gated on a key the sandbox doesn't have can earn bonus credit for design and offline tests, but not for "it works".

## Adversarial agent

One agent's only job is to break the project's claims.
- **Coverage:** it reads every factual claim in the README and the docs it links to.
- **Evidence:** every finding cites the claim (file:line) and the contradicting file:line or the command output.
- **Default:** a claim it cannot reproduce in the sandbox counts as broken. Claims the README itself marks as pending, needing a key, or not run are not counted.
- **Severity:**
  - **critical**: the claim is false, or the demo or number is faked.
  - **major**: overstated, or missing its evidence.
  - **minor**: wording.

Each critical finding then goes to two independent refuters. It **survives** unless both refute it with evidence.

## Approval rule

A round is approved when all three hold:

1. The weighted score plus the Meta bonus is **≥ 80**.
2. **Zero surviving critical findings** from the adversarial agent.
3. The final judge (Fable 5.1, max effort) gives an **approve** verdict, having read the scores, the evidence and the surviving findings.

## Mechanics

- **What gets judged:** the committed `HEAD` of the branch, checked out into a separate git worktree, never the working tree.
- **Who runs commands:** a runner agent, in its own worktree, runs the documented offline commands: `make test`, `make eval` and `make eval QUICK=1` (against committed outputs), and `cd web && npm ci && npm test && npm run build`. It returns the raw log, which the "works" scorer judges. The adversarial agent may run commands in its own worktree. `make all` needs network and is optional.
- **Models:** the dimension agents, the runner and the adversarial agent run on Haiku 5.5, and the final judge runs on Fable 5.1.
- **Harness:** [`judge-round.js`](judge-round.js) is the workflow script. It does the weighted arithmetic and the approval rule in code. An agent whose structured output fails validation is retried once; one that still fails counts as 0.
- **Round records:** each round's raw results are saved to `docs/judge/rounds/round-N.json`.

**Harness changes** (the rubric itself is unchanged):
- **After round 1:** two of seven scoring agents failed on output formatting and were counted as 0. That was a harness fault, not a measurement, so agents now get one retry.
- **The "works" agent is split** into a runner (raw command log) and a scorer, so a formatting failure can't erase what the commands showed.
