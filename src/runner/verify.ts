/**
 * Verification pipeline: runs a generated test against base, head and an
 * optional fixed revision, then classifies the outcome from runner output.
 */
import path from 'node:path';
import type { AnalysisReport } from '../analysis/schema';
import { createWorktree, type Worktree } from './worktree';
import { runExistingSuite } from './existingSuite';
import { findChangedLineHits } from './changedEvidence';
import { runTestOnRevision } from './runTest';
import { runRepeated } from './stability';
import { classify } from './classify';
import {
  VerificationResultSchema,
  type RevisionResult,
  type TestRunResult,
  type VerificationResult
} from './schema';
import type { Isolation } from './exec';

export interface VerifyTestOptions {
  repoPath: string;
  base: string;
  head: string;
  fixed?: string;
  testFile: string;
  analysisReport?: AnalysisReport;
  repeat?: number;
  timeoutMs?: number;
  scenarioId?: string;
  scenarioTitle?: string;
  docker?: boolean;
}

function firstFailureType(runs: TestRunResult[]): RevisionResult['failureType'] {
  for (const run of runs) {
    for (const test of run.tests) {
      if (test.failureType) return test.failureType as RevisionResult['failureType'];
    }
  }
  return undefined;
}

function firstFailureLocation(runs: TestRunResult[]): RevisionResult['failureLocation'] {
  for (const run of runs) {
    if (run.failureLocation) return run.failureLocation;
  }
  return undefined;
}

/**
 * Decides whether a head failure is evidence about changed code.
 *
 * Primary evidence is a stack frame inside a changed file. An assertion
 * failure only stacks the test frame, so the fallback is the analysis
 * report: if the failing test is listed as covering a changed function, the
 * failure necessarily exercises changed code.
 */
export function changedCodeEvidence(options: {
  head: RevisionResult;
  analysisReport?: AnalysisReport;
  testFile: string;
}): RevisionResult['changedCodeEvidence'] {
  const location = firstFailureLocation(options.head.runs);
  if (location) {
    const changed = (options.analysisReport?.changedFiles ?? []).map((file) => file.path);
    if (changed.includes(location.file)) return 'stack-frame';
  }

  const report = options.analysisReport;
  if (report) {
    const testBase = options.testFile.split('/').pop() ?? options.testFile;
    const coversChanged = report.changedFunctions.some((fn) =>
      fn.coveringTests.some((test) => test.split('/').pop() === testBase)
    );
    if (coversChanged) return 'coverage-of-changed-function';
  }

  return 'none';
}

async function runOnWorktree(options: {
  worktree: Worktree;
  ref: string;
  testFile: string;
  repeat: number;
  timeoutMs: number;
  changedFiles: string[];
}): Promise<RevisionResult> {
  const startedAt = Date.now();

  const stability = await runRepeated(async () => {
    const outcome = await runTestOnRevision({
      worktreeDir: options.worktree.dir,
      testFile: options.testFile,
      timeoutMs: options.timeoutMs,
      changedFiles: options.changedFiles
    });
    return outcome;
  }, options.repeat);

  return {
    ref: options.ref,
    sha: options.worktree.sha,
    runs: stability.runs.map((run) => run.result) as TestRunResult[],
    consistentStatus: stability.consistentStatus,
    stable: stability.stable,
    failureType: firstFailureType(stability.runs.map((run) => run.result)),
    failureLocation: firstFailureLocation(stability.runs.map((run) => run.result)),
    changedCodeEvidence: 'none',
    durationMs: Date.now() - startedAt
  };
}

export async function verifyTest(
  options: VerifyTestOptions
): Promise<VerificationResult> {
  const startedAt = Date.now();
  const repoPath = path.resolve(options.repoPath);
  const repeat = Math.max(1, options.repeat ?? 3);
  const timeoutMs = options.timeoutMs ?? 60_000;
  const changedFiles = (options.analysisReport?.changedFiles ?? []).map((file) => file.path);

  const baseWorktree = await createWorktree(repoPath, options.base);
  const headWorktree = await createWorktree(repoPath, options.head);
  const fixedWorktree = options.fixed
    ? await createWorktree(repoPath, options.fixed)
    : undefined;

  try {
    const base = await runOnWorktree({
      worktree: baseWorktree,
      ref: options.base,
      testFile: options.testFile,
      repeat,
      timeoutMs,
      changedFiles
    });

    const head = await runOnWorktree({
      worktree: headWorktree,
      ref: options.head,
      testFile: options.testFile,
      repeat,
      timeoutMs,
      changedFiles
    });

    const fixed = fixedWorktree
      ? await runOnWorktree({
          worktree: fixedWorktree,
          ref: options.fixed as string,
          testFile: options.testFile,
          repeat,
          timeoutMs,
          changedFiles
        })
      : undefined;

    const existing = await runExistingSuite({
      worktreeDir: headWorktree.dir,
      timeoutMs
    });

    let evidence = changedCodeEvidence({
      head,
      analysisReport: options.analysisReport,
      testFile: options.testFile
    });

    // An assertion failure stacks only the test frame, so fall back to
    // coverage: if the failing test executed the changed lines, the failure
    // is about the changed code.
    if (evidence === 'none' && options.analysisReport) {
      const hits = await findChangedLineHits({
        worktreeDir: headWorktree.dir,
        testFile: options.testFile,
        changedFiles: options.analysisReport.changedFiles.map((file) => ({
          path: file.path,
          changedLineRanges: file.changedLineRanges
        })),
        timeoutMs
      });
      if (hits.length > 0) evidence = 'coverage-of-changed-lines';
    }

    head.changedCodeEvidence = evidence;

    const classification = classify({
      base,
      head,
      fixed,
      repeat,
      headFailureInChangedCode: evidence !== 'none'
    });

    const isolation: Isolation = existing.isolation;

    return VerificationResultSchema.parse({
      testFile: options.testFile,
      scenarioId: options.scenarioId,
      scenarioTitle: options.scenarioTitle,
      verdict: classification.verdict,
      confidence: classification.confidence,
      reasons: classification.reasons,
      fixedCheck: classification.fixedCheck,
      revisions: { base, head, fixed },
      existingSuite: existing.suite,
      isolation,
      repeat,
      timeoutMs,
      durationMs: Date.now() - startedAt,
      generatedAt: new Date().toISOString()
    });
  } finally {
    await headWorktree.cleanup();
    await baseWorktree.cleanup();
    if (fixedWorktree) await fixedWorktree.cleanup();
  }
}
