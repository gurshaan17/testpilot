# Verification controls

Generated: 2026-10-26T17:36:21.356Z

These controls prove the verdict classifier independently of any LLM. Reference tests were read only as runner controls.

| Control | Expected | Actual | Confidence | Evidence | Result |
| --- | --- | --- | --- | --- | --- |
| payment regression | regression_caught | regression_caught | medium | coverage-of-changed-lines | PASS |
| lean regression | regression_caught | regression_caught | medium | coverage-of-changed-lines | PASS |
| always pass | not_demonstrated_passes_both | not_demonstrated_passes_both | high | none | PASS |
| always fail | invalid_fails_on_base | invalid_fails_on_base | high | none | PASS |
| flaky random | flaky | flaky | low | none | PASS |
| compile error | invalid_fails_on_base | invalid_fails_on_base | high | none | PASS |
| infinite loop | invalid_fails_on_base | inconclusive | inconclusive | low | none | PASS |
| reference payment | regression_caught | regression_caught | medium | coverage-of-changed-lines | PASS |
| reference lean | regression_caught | regression_caught | medium | coverage-of-changed-lines | PASS |
| fixed payment | regression_caught + fixedCheck=passed | regression_caught + fixedCheck=passed | medium | coverage-of-changed-lines | PASS |
| fixed lean | regression_caught + fixedCheck=passed | regression_caught + fixedCheck=passed | medium | coverage-of-changed-lines | PASS |

11/11 controls passed.
