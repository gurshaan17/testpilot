/**
 * Builds the repair prompt context from the report, worktrees and failure.
 * Reuses the leak-guarded generation context so reference material can never
 * reach the repair prompt.
 */
import path from 'node:path';
import type { AnalysisReport } from '../analysis/schema';
import {
  buildContextPack,
  isForbiddenText,
  type ContextPack
} from '../generate/context';
import type { VerificationResult } from '../runner/schema';

export interface RepairContext {
  function: ContextPack['function'];
  changedFiles: { path: string; status: string; diff: string }[];
  directCallers: { qualifiedName: string; file: string; body: string }[];
  test: { file: string; source: string };
  failure: {
    output: string;
    location?: { file: string; line: number };
    verdict: string;
    reasons: string[];
  };
  guardFeedback?: string;
  previousAttempt?: { patch: string; failure: string };
}

export interface BuildRepairContextOptions {
  report: AnalysisReport;
  baseWorktreeDir: string;
  headWorktreeDir: string;
  testFile: string;
  testSource: string;
  verification: VerificationResult;
  guardFeedback?: string;
  previousAttempt?: { patch: string; failure: string };
}

function clip(value: string, limit = 3_000): string {
  const clean = isForbiddenText(value) ? '[omitted: forbidden content]' : value;
  return clean.length > limit ? `${clean.slice(0, limit)}\n// ... truncated` : clean;
}

export function buildRepairContext(
  options: BuildRepairContextOptions
): RepairContext {
  const changed = options.report.changedFunctions[0];
  if (!changed) throw new Error('The analysis report has no changed functions');

  const pack = buildContextPack(
    options.report,
    {
      repoPath: path.resolve(options.headWorktreeDir),
      baseWorktreeDir: options.baseWorktreeDir,
      headWorktreeDir: options.headWorktreeDir
    },
    { file: changed.file, qualifiedName: changed.qualifiedName, name: changed.name }
  );

  const failureRun = options.verification.revisions.head.runs[0];
  const failureOutput =
    failureRun?.tests.flatMap((test) => test.failureMessages).join('\n\n') ||
    failureRun?.outputTail ||
    options.verification.reasons.join('\n');

  return {
    function: pack.function,
    changedFiles: options.report.changedFiles
      .filter((file) => !isForbiddenText(file.diff))
      .map((file) => ({ path: file.path, status: file.status, diff: file.diff })),
    directCallers: pack.directCallers.map((caller) => ({
      qualifiedName: caller.qualifiedName,
      file: caller.file,
      body: caller.body
    })),
    test: {
      file: options.testFile,
      source: isForbiddenText(options.testSource)
        ? '[omitted: forbidden content]'
        : options.testSource
    },
    failure: {
      output: clip(failureOutput),
      location: options.verification.revisions.head.failureLocation,
      verdict: options.verification.verdict,
      reasons: options.verification.reasons
    },
    guardFeedback: options.guardFeedback,
    previousAttempt: options.previousAttempt
      ? {
          patch: options.previousAttempt.patch,
          failure: clip(options.previousAttempt.failure)
        }
      : undefined
  };
}