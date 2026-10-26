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

# Check which configured providers can complete a trivial structured call.
npm run dev -- llm-check --provider all

# Acceptance checks against both demo-shop bug branches.
npm run check-analysis

npm run build
```

`analyze` opens a temporary git worktree at HEAD, symlinks `node_modules`, runs
each Jest test file in isolation for per-test coverage, builds the caller graph
up to depth 2, and cleans up the worktree on success or failure. Coverage
results are cached by HEAD SHA in `.testpilot-cache/`; pass `--no-cache` to
ignore the cache.

## LLM providers

Set `TESTPILOT_PROVIDER` to `anthropic`, `openai`, or `google`, or let TestPilot
pick the first provider with an API key. Model overrides use
`TESTPILOT_MODEL_ANTHROPIC`, `TESTPILOT_MODEL_OPENAI`, and
`TESTPILOT_MODEL_GOOGLE`. Default model ids live in one map in
`src/llm/client.ts` and should be re-verified against each provider's current
model list before production use.
