/**
 * The full loop: analyze -> generate -> verify -> repair -> re-verify.
 * Emits a timeline and a readable progress view; the fix is only ever written
 * to fix.patch, never to the analyzed repository's working tree.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { analyzeRepo } from './analysis/analyze';
import type { AnalysisReport } from './analysis/schema';
import { generateTests, type GenerationRun } from './generate/engine';
import { sanitizeRef } from './generate/naming';
import type { ProviderName } from './llm/client';
import { verifyTest } from './runner/verify';
import type { VerificationResult } from './runner/schema';
import { repairRegression } from './repair/loop';
import type { RepairResult } from './repair/schema';
import { applyFixToClone } from './repair/clone';
import { printLoopSummary } from './loopReport';
import { createRun, runDir, updateRun } from './store/runs';
import type { RunRecord } from './store/schema';

export interface TimelineEvent {
  stage: string;
  status: 'ok' | 'failed' | 'skipped';
  detail?: string;
  durationMs: number;
  at: string;
}

export interface LoopOptions {
  repoPath: string;
  base: string;
  head: string;
  provider?: ProviderName;
  model?: string;
  maxScenarios?: number;
  maxRepairAttempts?: number;
  repeat?: number;
  timeoutMs?: number;
  out?: string;
  applyToBranch?: string;
  noCache?: boolean;
  log?: (line: string) => void;
}

export interface LoopResult {
  run: RunRecord;
  outDir: string;
  analysis: AnalysisReport;
  generation: GenerationRun;
  verifications: VerificationResult[];
  repairs: RepairResult[];
  events: TimelineEvent[];
  exitCode: number;
  appliedTo?: { cloneDir: string; branch: string; commit: string };
}

export async function runLoop(options: LoopOptions): Promise<LoopResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const repoPath = path.resolve(options.repoPath);
  if (options.out) process.env.TESTPILOT_RUNS_DIR = path.resolve(options.out);
  const events: TimelineEvent[] = [];
  const startedAll = Date.now();

  const run = await createRun({
    repoPath,
    base: options.base,
    head: options.head,
    provider: options.provider,
    model: options.model
  });
  const outDir = runDir(run.runId);

  const stage = async <T>(
    name: string,
    fn: () => Promise<T>,
    describe?: (value: T) => string
  ): Promise<T> => {
    const startedAt = Date.now();
    log(`[${name}] started`);
    try {
      const value = await fn();
      const durationMs = Date.now() - startedAt;
      events.push({
        stage: name,
        status: 'ok',
        detail: describe?.(value),
        durationMs,
        at: new Date().toISOString()
      });
      log(`[${name}] finished in ${durationMs}ms${describe ? ` - ${describe(value)}` : ''}`);
      return value;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      events.push({
        stage: name,
        status: 'failed',
        detail: (error as Error).message,
        durationMs,
        at: new Date().toISOString()
      });
      log(`[${name}] failed in ${durationMs}ms - ${(error as Error).message}`);
      await updateRun(run.runId, {
        status: 'failed',
        stage: name,
        finishedAt: new Date().toISOString(),
        error: (error as Error).message
      });
      throw error;
    }
  };

  await updateRun(run.runId, { stage: 'analyze' });
  const analysis = await stage(
    'analyze',
    () =>
      analyzeRepo({
        repoPath,
        base: options.base,
        head: options.head,
        noCache: options.noCache
      }),
    (report) => `${report.changedFunctions.length} changed function(s)`
  );

  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'analysis.json'), `${JSON.stringify(analysis, null, 2)}\n`, 'utf8');
  await updateRun(run.runId, { stage: 'generate' });
  const generation = await stage(
    'generate',
    () =>
      generateTests({
        repoPath,
        base: options.base,
        head: options.head,
        report: analysis,
        provider: options.provider,
        model: options.model,
        maxScenarios: options.maxScenarios ?? 1,
        outDir
      }),
    (run) => `${run.scenarios.filter((scenario) => scenario.status === 'valid').length} valid test(s)`
  );

  const validScenarios = generation.scenarios.filter(
    (scenario) => scenario.status === 'valid' && scenario.fileName
  );

  await updateRun(run.runId, {
    stage: 'verify',
    provider: generation.provider,
    model: generation.model
  });

  const verifications: VerificationResult[] = [];
  for (const scenario of validScenarios) {
    const result = await stage(
      `verify:${scenario.id}`,
      () =>
        verifyTest({
          repoPath,
          base: options.base,
          head: options.head,
          testFile: path.join(outDir, scenario.fileName as string),
          analysisReport: analysis,
          scenarioId: scenario.id,
          scenarioTitle: scenario.title,
          repeat: options.repeat ?? 3,
          timeoutMs: options.timeoutMs
        }),
      (verification) => `${verification.verdict} (${verification.confidence})`
    );
    verifications.push(result);
    await mkdir(outDir, { recursive: true });
    await writeFile(
      path.join(outDir, 'verification.json'),
      `${JSON.stringify(result, null, 2)}\n`,
      'utf8'
    );
  }

  await updateRun(run.runId, { stage: 'repair' });

  const repairs: RepairResult[] = [];
  for (const verification of verifications) {
    const result = await stage(
      `repair:${verification.scenarioId ?? 'unknown'}`,
      () =>
        repairRegression({
          repoPath,
          base: options.base,
          head: options.head,
          verification,
          analysisReport: analysis,
          testFile: verification.testFile,
          provider: options.provider,
          model: options.model,
          maxAttempts: options.maxRepairAttempts ?? 3,
          repeat: options.repeat ?? 3,
          timeoutMs: options.timeoutMs,
          outDir
        }),
      (repair) => repair.status
    );
    repairs.push(result);
  }

  const fixed = repairs.some(
    (repair) => repair.status === 'fixed' || repair.status === 'fixed_by_revert'
  );
  const caught = verifications.some((verification) => verification.verdict === 'regression_caught');
  const exitCode = fixed ? 0 : caught ? 2 : 3;

  const result: LoopResult = {
    run,
    outDir,
    analysis,
    generation,
    verifications,
    repairs,
    events,
    exitCode
  };

  if (options.applyToBranch) {
    const patch = repairs.find((repair) => repair.patch)?.patch;
    if (patch) {
      result.appliedTo = await applyFixToClone({
        repoPath,
        head: options.head,
        branch: options.applyToBranch,
        patch
      });
    }
  }

  await mkdir(outDir, { recursive: true });
  await writeFile(
    path.join(outDir, 'timeline.json'),
    `${JSON.stringify(
      { head: options.head, base: options.base, totalMs: Date.now() - startedAll, events },
      null,
      2
    )}\n`,
    'utf8'
  );

  const finalVerdict = verifications[0]?.verdict;
  const finalRepair = repairs[0]?.status;
  await updateRun(run.runId, {
    status: 'done',
    stage: 'complete',
    finishedAt: new Date().toISOString(),
    verdict: finalVerdict,
    repairStatus: finalRepair,
    provider: generation.provider,
    model: generation.model
  });

  printLoopSummary({ result, log });
  return result;
}