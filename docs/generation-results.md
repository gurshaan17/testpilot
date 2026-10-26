# Test generation results

Generated: 2026-10-26T13:33:47.981Z

## Status

**Blocked: no provider API keys are configured.** Skipped: anthropic (ANTHROPIC_API_KEY), openai (OPENAI_API_KEY), google (GOOGLE_GENERATIVE_AI_API_KEY). No live generation runs were executed, so the 2/3 valid and caught-on-head targets remain unverified.

The validation loop itself was exercised on both bug branches with deterministic canned candidates by `npm test`; the base checks passed and the head previews failed for both planted regressions.

## Results

| Branch | Provider | Runs | Valid rate | Avg attempts | Caught on head | Target |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| bug/payment-concurrency | anthropic | - | n/a | n/a | n/a | SKIPPED (ANTHROPIC_API_KEY not set) |
| bug/payment-concurrency | openai | - | n/a | n/a | n/a | SKIPPED (OPENAI_API_KEY not set) |
| bug/payment-concurrency | google | - | n/a | n/a | n/a | SKIPPED (GOOGLE_GENERATIVE_AI_API_KEY not set) |
| bug/user-lean | anthropic | - | n/a | n/a | n/a | SKIPPED (ANTHROPIC_API_KEY not set) |
| bug/user-lean | openai | - | n/a | n/a | n/a | SKIPPED (OPENAI_API_KEY not set) |
| bug/user-lean | google | - | n/a | n/a | n/a | SKIPPED (GOOGLE_GENERATIVE_AI_API_KEY not set) |

## Reference comparison

Reference tests were read only for this comparison; they were never passed to an LLM.

| Branch | Reference file | Availability | Note |
| --- | --- | --- | --- |
| bug/payment-concurrency | `__testpilot__/payment-failure.reference.test.ts` | available | reference available; no generated runs to compare |
| bug/user-lean | `__testpilot__/profile-lean.reference.test.ts` | available | reference available; no generated runs to compare |

## Per-run details

No live runs (no provider keys).

## Improvement rounds

Round 1: not run. No prompt changes were made because there were no provider credentials to measure a before/after.
