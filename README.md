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

Skeleton only. No analysis, LLM, or runner logic is implemented yet.

## Development

```bash
npm install
cp .env.example .env
npm run dev -- analyze --repo ../demo-shop --base main --head bug/user-lean
npm run build
```
