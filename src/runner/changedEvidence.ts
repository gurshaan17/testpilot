/**
 * Deterministic evidence that a failing test exercises changed code.
 *
 * An assertion failure only stacks the test frame, so the stack alone cannot
 * show that the change caused the failure. This runs the test with coverage
 * and checks whether the changed lines were executed.
 */
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runSandboxed } from './exec';

export interface ChangedFileRanges {
  path: string;
  changedLineRanges: { start: number; end: number }[];
}

export interface ChangedLineHit {
  file: string;
  lines: number[];
}

function relativeToRepo(worktreeDir: string, filePath: string): string | undefined {
  const relative = path.relative(worktreeDir, filePath).split(path.sep).join('/');
  return relative.startsWith('..') ? undefined : relative;
}

export async function findChangedLineHits(options: {
  worktreeDir: string;
  testFile: string;
  changedFiles: ChangedFileRanges[];
  timeoutMs?: number;
}): Promise<ChangedLineHit[]> {
  const coverageDir = await mkdtemp(path.join(tmpdir(), 'testpilot-evidence-'));
  const testName = path.basename(options.testFile);
  const target = path.join(options.worktreeDir, '__testpilot__', testName);
  const realWorktree = await realpath(options.worktreeDir);

  try {
    // The test may already have been removed by the run phase, so copy it in.
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.resolve(options.testFile), target);
    const run = await runSandboxed({
      cwd: options.worktreeDir,
      command: 'npx',
      args: [
        'jest',
        '--runTestsByPath',
        `__testpilot__/${testName}`,
        '--ci',
        '--coverage',
        '--coverageReporters=json',
        `--coverageDirectory=${coverageDir}`,
        '--collectCoverageFrom=src/**/*.ts',
        '--silent'
      ],
      timeoutMs: options.timeoutMs ?? 60_000
    });

    // A failing test still writes coverage, so the exit code is not a gate.
    const coveragePath = path.join(coverageDir, 'coverage-final.json');
    let coverage: Record<
      string,
      { statementMap?: Record<string, { start: { line: number }; end: { line: number } }>; s?: Record<string, number> }
    >;

    try {
      coverage = JSON.parse(await readFile(coveragePath, 'utf8'));
    } catch {
      return [];
    }

    const hits: ChangedLineHit[] = [];

    for (const changed of options.changedFiles) {
      const executed = new Set<number>();

      for (const [absolute, fileCoverage] of Object.entries(coverage)) {
        const relative = relativeToRepo(realWorktree, absolute);
        if (relative !== changed.path) continue;

        for (const [id, statement] of Object.entries(fileCoverage.statementMap ?? {})) {
          if ((fileCoverage.s?.[id] ?? 0) <= 0) continue;
          for (let line = statement.start.line; line <= statement.end.line; line += 1) {
            executed.add(line);
          }
        }
      }

      const lines = changed.changedLineRanges
        .flatMap((range) => {
          const from = Math.max(range.start, 1);
          const to = Math.min(range.end, executed.size ? Number.MAX_SAFE_INTEGER : range.end);
          const list: number[] = [];
          for (let line = from; line <= to; line += 1) {
            if (executed.has(line)) list.push(line);
          }
          return list;
        })
        .sort((a, b) => a - b);

      if (lines.length > 0) hits.push({ file: changed.path, lines });
    }

    return hits;
  } finally {
    await rm(target, { force: true });
    await rm(coverageDir, { recursive: true, force: true });
  }
}
