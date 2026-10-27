/**
 * Analyze -> generate -> verify, persisted as a store run so callers can poll.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { analyzeRepo } from './analysis/analyze';
import type { AnalysisReport } from './analysis/schema';
import { generateTests, type GenerationRun } from './generate/engine';
import type { ProviderName } from './llm/client';
import { verifyTest } from './runner/verify';
import type { VerificationResult } from './runner/schema';
import { createRun, runDir, updateRun } from './store/runs';
import type { RunRecord } from './store/schema';

export interface RunPipelineOptions {
  repoPath: string;
  base: string;
  head: string;
  provider?: ProviderName;
  model?: string;
  maxScenarios?: number;
  out?: string;
  noCache?: boolean;
  skipVerify?: boolean;
  repeat?: number;
  timeoutMs?: number;
  fixed?: string;
}

export interface RunPipelineResult {
  run: RunRecord;
  analysis: AnalysisReport;
  generation: GenerationRun;
  verifications: VerificationResult[];
}

export async function runPipeline(options: RunPipelineOptions): Promise<RunPipelineResult> {
  const repoPath = path.resolve(options.repoPath);
  if (options.out) process.env.TESTPILOT_RUNS_DIR = path.resolve(options.out);

  const run = await createRun({
    repoPath,
    base: options.base,
    head: options.head,
    provider: options.provider,
    model: options.model
  });
  const outDir = runDir(run.runId);

  try {
    await updateRun(run.runId, { stage: 'analyze' });
    const analysis = await analyzeRepo({
      repoPath,
      base: options.base,
      head: options.head,
      noCache: options.noCache
    });

    await mkdir(outDir, { recursive: true });
    await writeFile(
      path.join(outDir, 'analysis.json'),
      `${JSON.stringify(analysis, null, 2)}\n`,
      'utf8'
    );

    await updateRun(run.runId, { stage: 'generate' });
    const generation = await generateTests({
      repoPath,
      base: options.base,
      head: options.head,
      report: analysis,
      provider: options.provider,
      model: options.model,
      maxScenarios: options.maxScenarios ?? 1,
      outDir
    });

    const verifications: VerificationResult[] = [];
    if (!options.skipVerify) {
      await updateRun(run.runId, {
        stage: 'verify',
        provider: generation.provider,
        model: generation.model
      });

      for (const scenario of generation.scenarios) {
        if (scenario.status !== 'valid' || !scenario.fileName) continue;
        const verification = await verifyTest({
          repoPath,
          base: options.base,
          head: options.head,
          fixed: options.fixed,
          testFile: path.join(outDir, scenario.fileName),
          analysisReport: analysis,
          scenarioId: scenario.id,
          scenarioTitle: scenario.title,
          repeat: options.repeat ?? 3,
          timeoutMs: options.timeoutMs
        });
        verifications.push(verification);
        await writeFile(
          path.join(outDir, 'verification.json'),
          `${JSON.stringify(verification, null, 2)}\n`,
          'utf8'
        );
      }
    }

    const finalRun = await updateRun(run.runId, {
      status: 'done',
      stage: options.skipVerify ? 'generated' : 'complete',
      finishedAt: new Date().toISOString(),
      verdict: verifications[0]?.verdict,
      provider: generation.provider,
      model: generation.model
    });

    return { run: finalRun, analysis, generation, verifications };
  } catch (error) {
    await updateRun(run.runId, {
      status: 'failed',
      stage: 'failed',
      finishedAt: new Date().toISOString(),
      error: (error as Error).message
    });
    throw error;
  }
}