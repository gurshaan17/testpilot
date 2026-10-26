/**
 * Runs one generated test file against one revision worktree.
 * The test file is copied into the worktree; no source file is modified.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runSandboxed, type Isolation } from './exec';
import { parseJestResult, readJestJson, type JestRunResult } from './jestResult';

export interface RunTestOptions {
  worktreeDir: string;
  testFile: string;
  timeoutMs?: number;
  changedFiles?: string[];
  docker?: boolean;
}

export interface TestRunOutcome {
  result: JestRunResult;
  isolation: Isolation;
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * The test always runs from __testpilot__/ inside the worktree, so its own
 * relative imports (../src/...) resolve the same way they do for a generated
 * test. Only the file name is kept.
 */
function normalizeRelative(testFile: string): string {
  const relative = testFile.split(path.sep).join('/');
  const name = relative.slice(relative.lastIndexOf('/') + 1);
  return `__testpilot__/${name}`;
}

export async function runTestOnRevision(
  options: RunTestOptions
): Promise<TestRunOutcome> {
  const relative = normalizeRelative(options.testFile);
  const target = path.join(options.worktreeDir, relative);
  const source = path.resolve(options.testFile);

  await mkdir(path.dirname(target), { recursive: true });
  const { copyFile } = await import('node:fs/promises');
  await copyFile(source, target);

  const outputDir = await mkdtemp(path.join(tmpdir(), 'testpilot-jest-'));
  const outputFile = path.join(outputDir, 'result.json');

  try {
    const run = await runSandboxed({
      cwd: options.worktreeDir,
      command: 'npx',
      args: [
        'jest',
        '--runTestsByPath',
        relative,
        '--ci',
        '--json',
        `--outputFile=${outputFile}`,
        '--silent=false'
      ],
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    });

    const jestJson = await readJestJson(outputFile);
    const result = parseJestResult({
      stdout: run.stdout,
      stderr: run.stderr,
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      jestJson,
      changedFiles: options.changedFiles ?? []
    });

    return { result, isolation: run.isolation, durationMs: run.durationMs };
  } finally {
    await rm(outputDir, { recursive: true, force: true });
    await rm(target, { force: true });
  }
}
