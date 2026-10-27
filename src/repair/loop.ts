/**
 * Guarded repair loop. The LLM proposes edits; the verification runner decides
 * whether the fix worked. A patch is only accepted when the same test passes,
 * the existing suite stays green, the guards pass and the test file is intact.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Project } from 'ts-morph';
import { collectCallables } from '../analysis/callables';
import type { AnalysisReport } from '../analysis/schema';
import type { ProviderName } from '../llm/client';
import { listSourceFiles } from '../generate/contextFiles';
import { createWorktree } from '../runner/worktree';
import { verifyTest } from '../runner/verify';
import type { VerificationResult } from '../runner/schema';
import { buildRepairContext, type RepairContext } from './context';
import {
  applyEditsToWorktree,
  proposeRepair,
  type ProposeRepairOptions,
  type RepairProposalResult
} from './agent';
import {
  compiles,
  noHardcoding,
  noTestTampering,
  onlySourceFiles,
  parsePatchChanges,
  sizeBudget
} from './guards';
import {
  callableBody,
  fixedFailure,
  guard,
  normalizeBody,
  skipped,
  writeArtifacts
} from './loopSupport';
import { RepairResultSchema, type RepairAttempt, type RepairResult } from './schema';

export interface RepairOptions {
  repoPath: string;
  base: string;
  head: string;
  verification: VerificationResult;
  analysisReport: AnalysisReport;
  testFile?: string;
  provider?: ProviderName;
  model?: string;
  maxAttempts?: number;
  repeat?: number;
  timeoutMs?: number;
  outDir?: string;
  /** Injectable for deterministic tests; defaults to the real LLM agent. */
  propose?: (options: ProposeRepairOptions) => Promise<RepairProposalResult>;
}

export async function repairRegression(options: RepairOptions): Promise<RepairResult> {
  if (options.verification.verdict !== 'regression_caught') {
    return skipped(
      `Repair is skipped for verdict ${options.verification.verdict}; only regression_caught is repaired.`
    );
  }

  const startedAt = Date.now();
  const repoPath = path.resolve(options.repoPath);
  const testFile = options.testFile ?? options.verification.testFile;
  const testSource = await readFile(path.resolve(testFile), 'utf8');
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const changed = options.analysisReport.changedFunctions[0];
  const baseWorktree = await createWorktree(repoPath, options.base);

  const attempts: RepairAttempt[] = [];
  const totalUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let provider = '';
  let model = '';
  let guardFeedback: string | undefined;
  let previousAttempt: { patch: string; failure: string } | undefined;
  let succeeded = false;
  let succeededRestoresBase = false;

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const attemptStart = Date.now();
      const headWorktree = await createWorktree(repoPath, options.head);
      let record: RepairAttempt = {
        attempt,
        editsApplied: false,
        guards: [],
        provider: '',
        model: '',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        durationMs: 0
      };
      let success = false;
      let restoresBase = false;

      try {
        const context: RepairContext = buildRepairContext({
          report: options.analysisReport,
          baseWorktreeDir: baseWorktree.dir,
          headWorktreeDir: headWorktree.dir,
          testFile,
          testSource,
          verification: options.verification,
          guardFeedback,
          previousAttempt
        });

        const proposed = await (options.propose ?? proposeRepair)({
          context,
          provider: options.provider,
          model: options.model
        });

        provider = proposed.provider;
        model = proposed.model;
        totalUsage.inputTokens += proposed.usage.inputTokens ?? 0;
        totalUsage.outputTokens += proposed.usage.outputTokens ?? 0;
        totalUsage.totalTokens += proposed.usage.totalTokens ?? 0;
        record.provider = proposed.provider;
        record.model = proposed.model;
        record.proposal = proposed.proposal;
        record.usage = {
          inputTokens: proposed.usage.inputTokens ?? 0,
          outputTokens: proposed.usage.outputTokens ?? 0,
          totalTokens: proposed.usage.totalTokens ?? 0
        };

        const applied = await applyEditsToWorktree({
          worktreeDir: headWorktree.dir,
          edits: proposed.proposal.edits
        });

        if (!applied.ok) {
          record.failure = applied.error;
          guardFeedback = applied.error;
        } else {
          record.editsApplied = true;
          record.patch = applied.patch;
          const changes = parsePatchChanges(applied.patch);
          record.guards = [
            guard('onlySourceFiles', onlySourceFiles(changes, new Set(listSourceFiles(headWorktree.dir)))),
            guard('noTestTampering', noTestTampering(changes, testFile)),
            guard('sizeBudget', sizeBudget(changes)),
            guard('noHardcoding', noHardcoding(changes, testSource, applied.originals)),
            guard('compiles', await compiles({ worktreeDir: headWorktree.dir }))
          ];

          const rejected = record.guards.filter((entry) => !entry.ok);
          if (rejected.length > 0) {
            record.failure = rejected.map((entry) => `${entry.name}: ${entry.reason}`).join('\n');
            guardFeedback = record.failure;
          } else {
            const verification = await verifyTest({
              repoPath,
              base: options.base,
              head: options.head,
              fixedPatch: applied.patch,
              testFile,
              analysisReport: options.analysisReport,
              repeat: options.repeat ?? 3,
              timeoutMs: options.timeoutMs
            });

            record.verification = {
              verdict: verification.verdict,
              confidence: verification.confidence,
              fixedCheck: verification.fixedCheck,
              fixedStatus: verification.revisions.fixed?.consistentStatus,
              fixedExistingSuite: verification.fixedExistingSuite,
              testFileIntact: verification.testFileIntact,
              reasons: verification.reasons
            };
            record.patchStats = verification.fixedPatchStats;
            record.patch = applied.patch;

            const fixedPassed =
              verification.revisions.fixed?.stable === true &&
              verification.revisions.fixed.consistentStatus === 'passed';
            const suiteGreen =
              verification.fixedExistingSuite?.ran === true &&
              verification.fixedExistingSuite.failed === 0 &&
              verification.fixedExistingSuite.total === verification.existingSuite.total;
            const intact = verification.testFileIntact === true;

            if (!fixedPassed) {
              record.failure = fixedFailure(verification);
            } else if (!suiteGreen) {
              const fixed = verification.fixedExistingSuite;
              record.failure = `The existing suite is not green on the patched code: ${fixed?.passed ?? 0}/${fixed?.total ?? 0} passed, ${fixed?.failed ?? 0} failed.`;
            } else if (!intact) {
              record.failure = 'The generated test file changed in the patched worktree.';
            } else {
              success = true;
              const baseBody = callableBody(baseWorktree.dir, changed.file, changed.qualifiedName);
              const patchedBody = callableBody(headWorktree.dir, changed.file, changed.qualifiedName);
              restoresBase = Boolean(
                baseBody && patchedBody && normalizeBody(baseBody) === normalizeBody(patchedBody)
              );
            }
          }
        }
      } catch (error) {
        record.failure = (error as Error).message;
      } finally {
        record.durationMs = Date.now() - attemptStart;
        await headWorktree.cleanup();
        attempts.push(record);
        if (!success && record.patch && record.failure) {
          previousAttempt = { patch: record.patch, failure: record.failure };
        }
      }

      if (success) {
        succeeded = true;
        succeededRestoresBase = restoresBase;
        break;
      }
    }
  } finally {
    await baseWorktree.cleanup();
  }

  const successful = succeeded ? attempts.at(-1) : undefined;
  const last = attempts.at(-1);
  const status: RepairResult['status'] = succeeded
    ? succeededRestoresBase
      ? 'fixed_by_revert'
      : 'fixed'
    : 'failed';

  const patch = succeeded ? successful?.patch : undefined;
  const result = RepairResultSchema.parse({
    status,
    reasons: succeeded
      ? [
          'The generated test passes on the patched code.',
          'The existing suite is green on the patched code.',
          'The test file is byte-identical after patching.'
        ]
      : [last?.failure ?? 'No repair attempt succeeded.'],
    attempts,
    patch,
    patchStats: successful?.patchStats,
    filesTouched: successful?.patchStats?.files ?? [],
    restoresBase: succeeded && succeededRestoresBase,
    preservesPrIntent: successful?.proposal?.preservesPrIntent ?? false,
    intentNote: successful?.proposal?.intentNote ?? '',
    provider,
    model,
    totalUsage,
    durations: { totalMs: Date.now() - startedAt },
    generatedAt: new Date().toISOString()
  });

  if (options.outDir) await writeArtifacts(options.outDir, result);
  return result;
}
