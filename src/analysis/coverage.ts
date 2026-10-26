/**
 * Per-test-file coverage mapping. Jest's aggregate report cannot attribute
 * lines to individual tests, so each test file runs alone with coverage.
 * Results are cached by HEAD SHA under .testpilot-cache/.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execa } from 'execa';

export interface TestRunResult {
  file: string;
  passed: boolean;
  durationMs: number;
}

export type CoverageMap = Record<string, Record<string, number[]>>;

export interface CoverageData {
  headSha: string;
  testFiles: TestRunResult[];
  baselineFailures: TestRunResult[];
  map: CoverageMap;
}

export interface CoverageOptions {
  repoPath: string;
  worktreePath: string;
  headSha: string;
  testFiles?: string[];
  noCache?: boolean;
  concurrency?: number;
}

export interface FunctionCoverageTarget {
  file: string;
  startLine: number;
  endLine: number;
}

export interface ChangedLineCoverage {
  percentage: number;
  coveredLines: number[];
  uncoveredLines: number[];
}

const CACHE_VERSION = 1;

function normalize(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function cachePaths(repoPath: string, headSha: string): { dir: string; file: string } {
  const dir = path.join(process.cwd(), '.testpilot-cache');
  return { dir, file: path.join(dir, `${path.basename(path.resolve(repoPath))}-${headSha}.json`) };
}

function isCoverageData(value: unknown, headSha: string): value is CoverageData {
  const candidate = value as Partial<CoverageData> | undefined;
  return Boolean(
    candidate &&
      candidate.headSha === headSha &&
      Array.isArray(candidate.testFiles) &&
      Array.isArray(candidate.baselineFailures) &&
      candidate.map &&
      typeof candidate.map === 'object'
  );
}

async function readCache(repoPath: string, headSha: string): Promise<CoverageData | undefined> {
  const { file } = cachePaths(repoPath, headSha);
  if (!existsSync(file)) return undefined;

  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as {
      version?: number;
      data?: unknown;
    };
    if (parsed.version !== CACHE_VERSION) return undefined;
    return isCoverageData(parsed.data, headSha) ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

async function writeCache(repoPath: string, data: CoverageData): Promise<void> {
  const { dir, file } = cachePaths(repoPath, data.headSha);
  await mkdir(dir, { recursive: true });
  await writeFile(file, JSON.stringify({ version: CACHE_VERSION, data }), 'utf8');
}

export async function discoverTestFiles(worktreePath: string): Promise<string[]> {
  const { stdout } = await execa('npx', ['jest', '--listTests'], { cwd: worktreePath });
  const realWorktree = await realpath(worktreePath);

  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((absolute) => normalize(path.relative(realWorktree, absolute)))
    .filter(
      (relative) =>
        relative.startsWith('src/') &&
        relative.endsWith('.test.ts') &&
        !relative.includes('__testpilot__/')
    )
    .sort();
}

function executedLines(coverageFile: string, worktreePath: string): Record<string, number[]> {
  const entries: Record<string, number[]> = {};

  for (const [absolutePath, fileCoverage] of Object.entries(coverageFile)) {
    const relative = normalize(path.relative(worktreePath, absolutePath));
    if (!relative.startsWith('src/') || relative.includes('__testpilot__/')) continue;

    const coverage = fileCoverage as {
      statementMap?: Record<string, { start: { line: number }; end: { line: number } }>;
      s?: Record<string, number>;
    };
    const lines = new Set<number>();

    for (const [id, statement] of Object.entries(coverage.statementMap ?? {})) {
      if ((coverage.s?.[id] ?? 0) <= 0) continue;
      for (let line = statement.start.line; line <= statement.end.line; line += 1) {
        lines.add(line);
      }
    }

    if (lines.size > 0) entries[relative] = [...lines].sort((a, b) => a - b);
  }

  return entries;
}

async function runOneTest(
  worktreePath: string,
  realWorktree: string,
  testFile: string
): Promise<{ result: TestRunResult; covered: Record<string, number[]> }> {
  const coverageDir = await mkdtemp(path.join(tmpdir(), 'testpilot-cov-'));
  const startedAt = Date.now();

  try {
    const run = await execa(
      'npx',
      [
        'jest',
        '--runTestsByPath',
        testFile,
        '--coverage',
        '--coverageReporters=json',
        `--coverageDirectory=${coverageDir}`,
        '--collectCoverageFrom=src/**/*.ts',
        '--silent'
      ],
      { cwd: worktreePath, reject: false }
    );

    const coveragePath = path.join(coverageDir, 'coverage-final.json');
    const covered = existsSync(coveragePath)
      ? executedLines(JSON.parse(await readFile(coveragePath, 'utf8')), realWorktree)
      : {};

    return {
      result: {
        file: testFile,
        passed: run.exitCode === 0,
        durationMs: Date.now() - startedAt
      },
      covered
    };
  } finally {
    await rm(coverageDir, { recursive: true, force: true });
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await fn(items[index]);
    }
  }

  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}

export async function computeCoverageMap(options: CoverageOptions): Promise<CoverageData> {
  if (!options.noCache) {
    const cached = await readCache(options.repoPath, options.headSha);
    if (cached) return cached;
  }

  const testFiles = options.testFiles ?? (await discoverTestFiles(options.worktreePath));
  const realWorktree = await realpath(options.worktreePath);
  const runs = await mapWithConcurrency(testFiles, options.concurrency ?? 4, (testFile) =>
    runOneTest(options.worktreePath, realWorktree, testFile)
  );

  const map: CoverageMap = {};
  for (const run of runs) map[run.result.file] = run.covered;

  const testResults = runs.map((run) => run.result);
  const data: CoverageData = {
    headSha: options.headSha,
    testFiles: testResults,
    baselineFailures: testResults.filter((result) => !result.passed),
    map
  };

  await writeCache(options.repoPath, data);
  return data;
}

export function testsCoveringFunction(
  coverage: CoverageData,
  target: FunctionCoverageTarget
): string[] {
  const covering: string[] = [];

  for (const [testFile, files] of Object.entries(coverage.map)) {
    const lines = files[target.file] ?? [];
    if (lines.some((line) => line >= target.startLine && line <= target.endLine)) {
      covering.push(testFile);
    }
  }

  return covering.sort();
}

export function changedLineCoverage(
  coverage: CoverageData,
  target: FunctionCoverageTarget & { changedLines: number[] }
): ChangedLineCoverage {
  const covered = new Set<number>();
  for (const files of Object.values(coverage.map)) {
    for (const line of files[target.file] ?? []) covered.add(line);
  }

  const coveredLines = target.changedLines.filter((line) => covered.has(line));
  const uncoveredLines = target.changedLines.filter((line) => !covered.has(line));
  const percentage =
    target.changedLines.length === 0
      ? 100
      : Math.round((coveredLines.length / target.changedLines.length) * 1000) / 10;

  return { percentage, coveredLines, uncoveredLines };
}