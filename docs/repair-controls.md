# Repair controls

Generated: 2026-10-27T04:15:16.004Z

Hand-written patches; no LLM involved. `fixed_by_revert` means the fix restores the base function body.

| Control | Expected | Actual | Result |
| --- | --- | --- | --- |
| payment revert | fixed_by_revert | fixed_by_revert | PASS |
| user lean revert | fixed_by_revert | fixed_by_revert | PASS |
| payment intent-preserving | fixed | fixed | PASS |
| comment-only no-op | failed | failed | PASS |
| fix breaks existing suite | failed | failed | PASS |
| edits the test file | rejected | rejected | PASS |
| JEST_WORKER_ID special case | rejected | rejected | PASS |
| modifies package.json | rejected | rejected | PASS |
| patch does not apply | patch_failed | patch_failed | PASS |

9/9 repair controls passed.
