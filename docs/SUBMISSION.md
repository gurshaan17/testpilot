# TestPilot submission

- Repo: https://github.com/gurshaan17/testpilot
- Tag: `v1.0-hackathon`
- Demo video: _placeholder (add the recording link here)_

## What it is (150 words)

TestPilot is a verification loop for code changes. It analyzes a `base...head`
diff, plans failure scenarios, and writes one Jest regression test that must
compile and pass on base. It then runs that test on head and on a patched
revision, and only reports a failure when the runner proves it. In four live
runs on two planted bugs, the regression was caught 4/4 times and repaired 4/4
times (all `fixed_by_revert`, average 1.0 attempt). The existing 15-test suite
stayed green throughout. Every verdict comes from exit codes and parsed Jest
JSON, never from the model. A repair agent proposes source-only edits, and
guards reject test edits, test-environment special cases, oversized patches and
hardcoded expectations. Results are deterministic markdown/HTML reports, a PR
comment and `fix.patch`. Seven MCP tools and a SKILL.md let an Alan agent run
the loop and report the outcome.

## Three technical points

1. **Base-pass is a gate, not a suggestion.** A generated test that does not compile or pass on base is invalid, so a wrong oracle cannot become a "caught regression".
2. **Verdicts are runner-derived.** Base/head/fixed runs are repeated, parsed from Jest JSON, and classified with a pure function; the LLM only proposes scenarios and edits.
3. **Fixes are proven, not asserted.** A patch is accepted only if the test passes on the patched code, the existing suite stays green, the test file hash is unchanged, and the guards pass.

## How to run

```bash
npm install
cp .env.example .env            # set one provider key
npm run preflight
npm run demo                    # offline replay, zero API cost
npm run demo -- --live          # real loop against ../demo-shop
npm run demo:report             # recorded report page
npm run dev -- mcp              # MCP server over stdio
```

## Files to open first

1. [`README.md`](../README.md) - pitch, architecture, verdicts, limits.
2. [`docs/DEMO.md`](DEMO.md) - 90-second script and Q&A.
3. [`docs/slides/index.html`](slides/index.html) - 3 slides.
4. [`demo-artifacts/report-payment.html`](../demo-artifacts/report-payment.html) and [`report-user.html`](../demo-artifacts/report-user.html) - rendered reports.
5. [`docs/STATS.md`](STATS.md) - every number with its source and n.

## Honest limitations

TypeScript and Jest only, evaluated on two planted bugs in one demo repo, with
one provider (Google). Coverage is mapped per test file, not per test case.
Isolation is a process sandbox; Docker support exists but was not exercised.
Repair guards are heuristic, and a generated test can still encode a wrong
oracle, which is why base-pass is mandatory and suspect verdicts exist. The
numbers are four runs, not a cross-model benchmark.
