# TestPilot

Analyzes a code change, generates a targeted regression test, and proves the
test distinguishes the base revision from the changed one.

Planned pipeline:

- **Resolve revisions** — validate the repo and diff `base...head` with git.
- **Find the blast radius** — map changed files to source files and existing coverage.
- **Prompt an LLM** — send the diff, impacted code, and failure gaps to the configured provider.
- **Generate one test** — write a focused regression test into `__testpilot__/`.
- **Verify both revisions** — run the test in isolated worktrees against base and head.
- **Report** — emit a Markdown verdict: regression reproduced, test flaky, or no signal.

## Status

Implemented: deterministic analysis (diff, changed functions, per-test coverage,
caller graph) and the multi-provider LLM layer. Test generation, verification,
and the Markdown report are still stubs.

## Commands

```bash
npm install
cp .env.example .env

# Analyze a change. Writes ./out/analysis.json by default.
npm run dev -- analyze --repo ../demo-shop --base main --head bug/user-lean
npm run dev -- analyze --repo ../demo-shop --base main --head bug/user-lean \
  --out report.json --json --no-cache

# Generate tests from a saved report.
npm run dev -- generate --analysis out/analysis.json --repo ../demo-shop \
  --base main --head bug/user-lean --max-scenarios 1

# Analyze and generate in one command.
npm run dev -- run --repo ../demo-shop --base main --head bug/user-lean \
  --provider anthropic --max-scenarios 1

# Check which configured providers can complete a trivial structured call.
npm run dev -- llm-check --provider all

# Acceptance checks against both demo-shop bug branches.
npm run check-analysis

# Generation acceptance (live providers only; skipped without keys).
npm run check-generation -- --runs 3

# Verify one test or a whole generated directory.
npm run dev -- verify --repo ../demo-shop --base main --head bug/user-lean \
  --test __testpilot__/some.testpilot.test.ts --analysis out/analysis.json
npm run dev -- verify --repo ../demo-shop --base main --head bug/user-lean \
  --generated out/generated/bug-user-lean --repeat 3

# Analyze + generate + verify in one command.
npm run dev -- run --repo ../demo-shop --base main --head bug/user-lean \
  --max-scenarios 1 --out out/generated

# Runner controls and end-to-end LLM evidence.
npm run check-verification
npm run e2e-verification
npm run check-repair
npm run e2e-loop

# Replay a recorded run offline, or run the real thing.
npm run demo -- --branch bug-user-lean
npm run demo -- --live

npm run build
```

`analyze` opens a temporary git worktree at HEAD, symlinks `node_modules`, runs
each Jest test file in isolation for per-test coverage, builds the caller graph
up to depth 2, and cleans up the worktree on success or failure. Coverage
results are cached by HEAD SHA in `.testpilot-cache/`; pass `--no-cache` to
ignore the cache.

`generate`/`run` plan up to three scenarios, generate one Jest test per selected
scenario, then validate it on BASE with `tsc --noEmit` and Jest. Failed attempts
are retried up to three times with the exact error. Valid tests are written to
`<out>/<sanitized-head>/__testpilot__/`; every run also writes `generation.json`
and the exact prompts under `prompts/`. The analyzed repository's working tree
is never modified.

`run` then verifies each valid test. `verify` runs a test repeatedly on BASE,
HEAD and an optional `--fixed` revision, records the existing suite on HEAD, and
writes `<out>/<sanitized-head>/verification.json`. Every child process runs with
a minimal environment, so provider keys are never visible to code under test.

### Verdicts

| Verdict | Meaning |
| --- | --- |
| `regression_caught` | Stable pass on base, stable behavioural fail on head (and on fixed, when supplied). |
| `regression_caught_suspect` | Base passes and head fails, but the failure is a compile/timeout error, outside changed code, or still fails on fixed. |
| `not_demonstrated_passes_both` | The test passes on both revisions, so it does not detect the change. |
| `invalid_fails_on_base` | The test fails, errors or does not compile on base. |
| `flaky` | The status changed across repeated runs on at least one revision. |
| `inconclusive` | Infrastructure problem, such as a base timeout. |

Confidence is `high` only for `regression_caught` with at least three stable runs
on every revision and a failure location inside a changed file; `medium` when
caught with fewer runs or no changed-file location; `low` for suspects.

### Repair loop

`testpilot loop` closes the circle: analyze -> generate -> verify -> repair ->
re-verify. When a test is `regression_caught`, the repair agent proposes source
edits; the verification runner decides whether the fix worked. The fix is only
written as `fix.patch`, never into the analyzed repository's working tree.

| Repair status | Meaning |
| --- | --- |
| `fixed` | Test passes on the patched code, the existing suite is green, and the test file is untouched. |
| `fixed_by_revert` | As `fixed`, but the patched function body is identical to base after whitespace normalization. |
| `failed` | Attempts exhausted; `repair.json` holds the best attempt's failure. |
| `skipped` | The verdict was not `regression_caught`, so no repair was attempted. |

Every proposed fix must pass these guards before any test runs:

- `onlySourceFiles` - only existing files under `src/`, never tests, configs, lockfiles, scripts or CI.
- `noTestTampering` - the test file is byte-identical and no test special-casing (`jest.mock`, `.skip`/`.only`, `NODE_ENV`/`JEST_WORKER_ID`) is added.
- `sizeBudget` - at most 3 files and 60 changed lines.
- `noHardcoding` - no test-assertion literals copied into source.
- `compiles` - `tsc --noEmit` succeeds in the patched worktree.

Add `--apply-to-branch <name>` to commit the fix on a branch inside a temporary
clone; the analyzed repository is never modified and nothing is pushed.

## LLM providers

Set `TESTPILOT_PROVIDER` to `anthropic`, `openai`, or `google`, or let TestPilot
pick the first provider with an API key. Model overrides use
`TESTPILOT_MODEL_ANTHROPIC`, `TESTPILOT_MODEL_OPENAI`, and
`TESTPILOT_MODEL_GOOGLE`. Default model ids live in one map in
`src/llm/client.ts` and should be re-verified against each provider's current
model list before production use.

## Reports and the run store

Every `loop` / `run` execution is stored under `out/runs/<runId>/` with
`run.json` plus `analysis.json`, `generation.json`, `verification.json`,
`repair.json`, `timeline.json`, `fix.patch` and the generated test.
`run.json` is updated at each stage so a caller can poll progress.

```bash
npm run dev -- runs import demo-artifacts
npm run dev -- report --run <runId>                 # markdown
npm run dev -- report --run <runId> --format html --out report.html
npm run dev -- report --run <runId> --format comment
npm run dev -- serve --port 4317                    # http://127.0.0.1:4317
npm run demo:report                                 # recorded demo, no live calls
```

The HTML page is self-contained (inline CSS/JS, CSP, light/dark, escaped
output) and ships with static fallbacks at `demo-artifacts/report-payment.html`
and `demo-artifacts/report-user.html`.

## MCP server

```bash
npm run dev -- mcp                 # stdio (default)
npm run dev -- mcp --http --port 4318
npx tsx src/mcp/server.ts          # same as the stdio server
```

| Tool | Use it when |
| --- | --- |
| `analyze_pull_request` | Start here: changed functions, callers, callers without tests. |
| `generate_regression_tests` | Plan and generate base-validated tests for a run. |
| `run_regression_tests` | Verify the generated test on base and head. |
| `repair_regression` | Propose and verify a guarded fix for `regression_caught`. |
| `get_verification_report` | Summary or full markdown report. |
| `run_testpilot_loop` | Run the whole pipeline in the background. |
| `get_run_status` | Poll stage, status and verdict. |

A generic stdio config shape (with TODOs) is in
`alan/mcp-config.example.json`. **Alan's exact config format is not known**;
adapt that mapping and keep the key in your secret manager.

The Alan skill lives at `alan/skills/testpilot-verify/SKILL.md`.

## Security model

- **Repo allowlist:** `TESTPILOT_ALLOWED_REPOS` (colon-separated) is resolved
  with `realpath`; symlink escapes are rejected. Default is `../demo-shop`.
- **Ref validation:** refs match `^[A-Za-z0-9._/@-]+$`, may not start with `-`,
  and must resolve with `git rev-parse --verify`.
- **Scrubbed environment:** every child runs with only PATH, a temp HOME,
  TMPDIR, `NODE_ENV=test` and `CI=true`; provider keys are never visible.
- **Escaped output:** repo and LLM text is escaped once in `esc()` for HTML and
  fenced for markdown; reports contain no external requests.
- **Localhost only:** the report server and streamable HTTP transport bind to
  `127.0.0.1`, and artifact routes reject ids outside the run-store pattern.
