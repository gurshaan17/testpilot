/**
 * Small pure helpers for the repair loop.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Project } from 'ts-morph';
import { collectCallables } from '../analysis/callables';
import type { VerificationResult } from '../runner/schema';
import type { GuardResult } from './guards';
import { RepairResultSchema, type GuardOutcome, type RepairResult } from './schema';

export function guard(name: string, result: GuardResult): GuardOutcome {
  return { name, ok: result.ok, reason: result.reason };
}

export function normalizeBody(body: string): string {
  return body.replace(/\s+/g, ' ').trim();
}

export function callableBody(
  worktreeDir: string,
  file: string,
  qualifiedName: string
): string | undefined {
  try {
    const project = new Project({
      skipAddingFilesFromTsConfig: true,
      skipFileDependencyResolution: true
    });
    const sourceFile = project.addSourceFileAtPath(path.join(worktreeDir, file));
    return collectCallables(sourceFile, file).find(
      (callable) => callable.qualifiedName === qualifiedName
    )?.bodyText;
  } catch {
    return undefined;
  }
}

export function fixedFailure(verification: VerificationResult): string {
  const fixed = verification.revisions.fixed;
  if (!fixed) return 'The patched revision was not executed.';

  const failure = fixed.runs
    .flatMap((run) => run.tests)
    .find((test) => test.failureMessages.length > 0)?.failureMessages[0];

  return [
    `Fixed revision status: ${fixed.consistentStatus}.`,
    failure ? failure.slice(0, 2_000) : ''
  ]
    .filter(Boolean)
    .join('\n');
}

export function skipped(reason: string): RepairResult {
  return RepairResultSchema.parse({
    status: 'skipped',
    reasons: [reason],
    attempts: [],
    filesTouched: [],
    restoresBase: false,
    preservesPrIntent: false,
    intentNote: '',
    provider: '',
    model: '',
    totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    durations: { totalMs: 0 },
    generatedAt: new Date().toISOString()
  });
}

export async function writeArtifacts(
  outDir: string,
  result: RepairResult
): Promise<{ repairPath: string; patchPath?: string }> {
  await mkdir(outDir, { recursive: true });
  const repairPath = path.join(outDir, 'repair.json');
  await writeFile(repairPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  if ((result.status === 'fixed' || result.status === 'fixed_by_revert') && result.patch) {
    const patchPath = path.join(outDir, 'fix.patch');
    await writeFile(patchPath, result.patch, 'utf8');
    return { repairPath, patchPath };
  }
  return { repairPath };
}
