/**
 * Runs the existing (non-generated) test suite on a revision worktree.
 * This is the "existing tests are green but the bug is real" evidence.
 */
import { runSandboxed, type Isolation } from './exec';
import type { JestJsonShape } from './jestResult';
import type { ExistingSuite } from './schema';

export interface ExistingSuiteOptions {
  worktreeDir: string;
  timeoutMs?: number;
}

export interface ExistingSuiteOutcome {
  suite: ExistingSuite;
  isolation: Isolation;
  durationMs: number;
}

function parseJestJson(stdout: string): JestJsonShape | undefined {
  const text = stdout.trim();
  if (!text.startsWith('{')) return undefined;
  try {
    return JSON.parse(text) as JestJsonShape;
  } catch {
    return undefined;
  }
}

export async function runExistingSuite(
  options: ExistingSuiteOptions
): Promise<ExistingSuiteOutcome> {
  const startedAt = Date.now();
  const run = await runSandboxed({
    cwd: options.worktreeDir,
    command: 'npx',
    args: [
      'jest',
      '--ci',
      '--json',
      '--testPathIgnorePatterns',
      '/node_modules/',
      '__testpilot__'
    ],
    timeoutMs: options.timeoutMs ?? 300_000
  });

  // With --json and no --outputFile, Jest prints the JSON report on stdout.
  const parsed = parseJestJson(run.stdout);

  if (!parsed) {
    return {
      suite: {
        ran: false,
        passed: 0,
        failed: 0,
        total: 0,
        error: (run.stderr || run.stdout).slice(-1_000)
      },
      isolation: run.isolation,
      durationMs: Date.now() - startedAt
    };
  }

  return {
    suite: {
      ran: true,
      passed: parsed.numPassedTests ?? 0,
      failed: parsed.numFailedTests ?? 0,
      total: parsed.numTotalTests ?? 0
    },
    isolation: run.isolation,
    durationMs: Date.now() - startedAt
  };
}
