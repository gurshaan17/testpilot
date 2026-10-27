# TestPilot - 3 slides

## 1. The problem

Agents ship faster than tests keep up. A "small" perf change can pass every
existing test and still break behaviour.

- All 15 existing tests pass: green CI, clean merge.
- Behaviour broken: a declined charge marks the order paid.
- `Promise.all([chargeCustomer(order), markOrderPaid(order.id)])` and `findById(id).lean()`.

## 2. The loop

Change -> Risk -> Test -> Evidence -> Fix -> Proof

The differentiator: the test passes on base, fails on head, and passes on fixed.
Every verdict comes from real Jest runs.

- regression_caught: 4/4 (n=4)
- fixed_by_revert: 4 (n=4)
- average repair attempts: 1.0 (n=4)
- tokens: 64,685 across 4 runs

Source: docs/STATS.md

## 3. Alan and next

Plugs into Alan:
- 7 MCP tools: analyze, generate, verify, repair, report, loop, status.
- SKILL.md tells an agent when and how to use them.
- Report page, PR comment and fix.patch.

Honest limits:
- TypeScript + Jest, two planted bugs, one provider.
- Per-test-file coverage; process isolation, not Docker.
- Guards are heuristic; generated oracles can be wrong.

Next: mutation testing, richer dependency analysis, more languages.
