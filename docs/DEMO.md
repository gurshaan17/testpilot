# Demo script

Two timings, the talk track, the fallback ladder and a Q&A cheat sheet.
All numbers come from [`STATS.md`](STATS.md).

## Before you start

```bash
npm run preflight          # fast, no LLM calls
npm run demo               # offline replay (default)
npm run demo -- --live     # real loop, 6-minute safety net
```

`npm run demo` replays the recorded `bug/payment-concurrency` run and opens the
report at `http://127.0.0.1:4317`. `--branch user` switches to the `.lean()` bug.

## 90-second version

| Time | Beat | On screen |
| --- | --- | --- |
| 0:00 | The problem, one sentence. | Terminal or slide 1 |
| 0:10 | Show the "small" perf change. | `git -C ../demo-shop diff main..bug/payment-concurrency` |
| 0:20 | Start the demo. | `npm run demo` |
| 0:30 | The evidence moment. | base PASS / head FAIL / existing suite 15/15 |
| 0:50 | The fix and the proof. | diff, then "test passes on fixed, suite 15/15 green" |
| 1:05 | Open the report page. | `http://127.0.0.1:4317/runs/<id>` |
| 1:15 | The Alan angle. | MCP tools + SKILL.md, one sentence |
| 1:25 | Close with the honest limitation. | Slide 3 |

### Talk track

- "A coding agent opens a PR that replaces two awaits with `Promise.all`. Every existing test still passes."
- "The bug is real: a declined charge can mark the order paid. The suite is green."
- "TestPilot analyzes the diff, plans a failure scenario, and writes one regression test."
- "On base the test passes. On head it fails with the assertion `pending` vs `paid`. The existing suite is still 15 of 15 green."
- "The repair agent proposes the smallest source fix. The runner proves it: the test passes on the patched code and the suite stays green."
- "It labels this `fixed_by_revert`, because the fix restores the old behaviour. The PR intent was not preserved, and we say so."
- "The same run is a report page and a PR comment, and Alan can call all of it through seven MCP tools."
- "Limitation: this is TypeScript and Jest, on two planted bugs. The numbers are four live runs, not a benchmark."

## 3-minute version

| Time | Beat |
| --- | --- |
| 0:00 | Problem and the two planted bugs (payment `Promise.all`, user `.lean()`). |
| 0:20 | Show the diff and ask: "which existing test would catch this?" None do. |
| 0:35 | `npm run demo -- --live` (or the replay if the network is slow). |
| 0:50 | Analysis: changed functions, callers, callers without tests. |
| 1:10 | Scenario and generated test: what it asserts and why it is true on base. |
| 1:35 | Evidence: base pass, head fail, failure type, existing suite green. |
| 2:00 | Repair: guards, `fixed_by_revert`, proof line, `fix.patch`. |
| 2:25 | Report page and the PR-comment format. |
| 2:40 | Alan: MCP tools and the skill; close with the limitation. |

## If the live run is slow

Say: "The live run is slower than the six-minute budget, so I'm switching to the
recorded run from the same branch." Press Ctrl-C, then `npm run demo`. The replay
is labelled "recorded replay", so nobody mistakes it for a live call.

## Fallback ladder

1. **Live run:** `npm run demo -- --live`
2. **Offline replay:** `npm run demo`
3. **Static report:** open `demo-artifacts/report-payment.html` (or `report-user.html`)
4. **Slides only:** `docs/slides/index.html`

## 60-90 second recording checklist

- Run `npm run preflight` first; fix WARNs you care about.
- Clear the terminal history so no paths or keys are visible.
- Font size 18-20pt; one terminal, one browser tab.
- Record at 1080p; one take of the offline demo, then trim the waiting.
- Start on the diff, end on the report page.
- No `vhs` or `asciinema` is installed here, so no tape file is included.

## Q&A cheat sheet

**How is this different from a test generator?**
It verifies the test on both revisions and repairs only when a real failure is
proven. The verdict comes from Jest, not the model.

**How do you know what "correct" is?**
Base behaviour is the oracle. A generated test must pass on base before it is
allowed to count.

**How do you stop the repair agent cheating?**
Source-only files, a test-file hash, no `JEST_WORKER_ID` / `NODE_ENV` branches,
no hardcoded test literals, a 3-file/60-line budget, and `tsc`.

**What about flaky tests?**
Each revision runs repeatedly. Disagreeing statuses produce `flaky`, and nothing
else is trusted.

**Why does a revert count as fixed?**
It is honest: `fixed_by_revert` says the fix restores base behaviour, so the PR
intent was not preserved.

**Is running PR code safe?**
The repo must be allowlisted, refs are validated, children get a scrubbed
environment, and the servers bind to localhost. Docker mode is optional and was
not exercised in this environment.

**Why Alan?**
Seven MCP tools plus a SKILL.md let an Alan agent run the loop, read the verdict
and post the comment without new glue code.

**Cost and latency?**
Four live runs used 64,685 tokens total (about 16k each). Average stage time:
generate 56.3s, repair 30.8s, verify 12.8s, analyze 0.7s.

**What would you build next?**
Mutation testing, richer dependency analysis, more languages, and re-testing on
PR updates.
