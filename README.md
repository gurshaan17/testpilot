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

## LLM providers

Set `TESTPILOT_PROVIDER` to `anthropic`, `openai`, or `google`, or let TestPilot
pick the first provider with an API key. Model overrides use
`TESTPILOT_MODEL_ANTHROPIC`, `TESTPILOT_MODEL_OPENAI`, and
`TESTPILOT_MODEL_GOOGLE`. Default model ids live in one map in
`src/llm/client.ts` and should be re-verified against each provider's current
model list before production use.
