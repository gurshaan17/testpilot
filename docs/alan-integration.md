# Alan integration checks

Generated: 2026-10-27T07:47:39.375Z

| Check | Expected | Actual | Result |
| --- | --- | --- | --- |
| import recorded runs | 2 | 2 | PASS |
| payment md sections | yes | yes | PASS |
| payment html banner | amber | amber | PASS |
| payment fixed_by_revert | yes | yes | PASS |
| lean md sections | yes | yes | PASS |
| lean html banner | amber | amber | PASS |
| lean fixed_by_revert | yes | yes | PASS |
| no-repair state | not attempted | not attempted | PASS |
| XSS escaped | escaped | escaped | PASS |
| id traversal rejected | rejected | rejected | PASS |
| MCP tool names | analyze_pull_request,generate_regression_tests,get_run_status,get_verification_report,repair_regression,run_regression_tests,run_testpilot_loop | analyze_pull_request,generate_regression_tests,get_run_status,get_verification_report,repair_regression,run_regression_tests,run_testpilot_loop | PASS |
| MCP descriptions | all present | all present | PASS |
| MCP report call | ok | ok | PASS |
| invalid input: outside allowlist | clean error | clean error | PASS |
| invalid input: ref injection | clean error | clean error | PASS |
| invalid input: missing run | clean error | clean error | PASS |
| MCP loop started | running | running | PASS |
| MCP loop finished | done | done | PASS |
| MCP final report | ok | ok | PASS |
| served HTML for new run | 200 | 200 | PASS |
| stdio stdout is JSON-RPC only | 0 non-JSON lines | 0 non-JSON line(s) | PASS |

21/21 checks passed.
