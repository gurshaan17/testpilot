/**
 * MCP tool handlers. Every tool validates its inputs, returns short text plus
 * structured data, and never logs to stdout.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { analyzeRepo } from '../analysis/analyze';
import { AnalysisReportSchema, type AnalysisReport } from '../analysis/schema';
import { generateTests, type GenerationRun } from '../generate/engine';
import type { ProviderName } from '../llm/client';
import { verifyTest } from '../runner/verify';
import type { VerificationResult } from '../runner/schema';
import { repairRegression } from '../repair/loop';
import { runLoop } from '../loop';
import { renderMarkdownReport } from '../report/markdown';
import { loadRun } from '../report/artifacts';
import { createRun, getRun, runDir, updateRun } from '../store/runs';
import type { RunRecord } from '../store/schema';
import {
  fail,
  ok,
  timeoutMs,
  validateRepoPath,
  verifyRef,
  withTimeout,
  type McpTextResult
} from './validation';

const active = new Map<string, string>();

function acquire(repoPath: string, runId: string): string | undefined {
  const key = path.resolve(repoPath);
  const current = active.get(key);
  if (current && current !== runId) return current;
  active.set(key, runId);
  return undefined;
}

function release(repoPath: string, runId: string): void {
  const key = path.resolve(repoPath);
  if (active.get(key) === runId) active.delete(key);
}

async function guard<T>(name: string, fn: () => Promise<T>): Promise<T | McpTextResult> {
  try {
    return await withTimeout(fn(), timeoutMs(), name);
  } catch (error) {
    return fail((error as Error).message);
  }
}

async function resolveRefs(repoPath: string, base: string, head: string): Promise<void> {
  await verifyRef(repoPath, base);
  await verifyRef(repoPath, head);
}

async function saveAnalysis(dir: string, report: AnalysisReport): Promise<void> {
  await writeFile(path.join(dir, 'analysis.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

async function readJson<T>(dir: string, name: string): Promise<T> {
  return JSON.parse(await readFile(path.join(dir, name), 'utf8')) as T;
}

function analysisSummary(runId: string, report: AnalysisReport) {
  return {
    runId,
    changedFunctions: report.changedFunctions.map((fn) => ({
      name: fn.name,
      qualifiedName: fn.qualifiedName,
      file: fn.file,
      startLine: fn.startLine,
      endLine: fn.endLine
    })),
    callers: report.impactGraph.nodes
      .filter((node) => node.depth > 0)
      .map((node) => ({ qualifiedName: node.qualifiedName, depth: node.depth })),
    callersWithoutTests: report.callersWithoutTests.map((node) => node.qualifiedName),
    baseline: {
      testFiles: report.baseline.testFiles.length,
      failures: report.baseline.failures.map((failure) => failure.file)
    }
  };
}

async function ensureAnalysis(input: {
  runId?: string;
  repoPath?: string;
  base?: string;
  head?: string;
}): Promise<{ run: RunRecord; analysis: AnalysisReport; dir: string }> {
  if (input.runId) {
    const run = await getRun(input.runId);
    const dir = runDir(run.runId);
    const analysis = AnalysisReportSchema.parse(await readJson(dir, 'analysis.json'));
    return { run, analysis, dir };
  }

  if (!input.repoPath || !input.base || !input.head) {
    throw new Error('Provide runId, or repoPath with base and head.');
  }

  const repoPath = await validateRepoPath(input.repoPath);
  await resolveRefs(repoPath, input.base, input.head);
  const run = await createRun({ repoPath, base: input.base, head: input.head });
  const dir = runDir(run.runId);

  await updateRun(run.runId, { stage: 'analyze' });
  const analysis = await analyzeRepo({ repoPath, base: input.base, head: input.head });
  await saveAnalysis(dir, analysis);
  await updateRun(run.runId, {
    status: 'done',
    stage: 'analyzed',
    finishedAt: new Date().toISOString()
  });

  return { run, analysis, dir };
}

export async function analyzePullRequest(input: {
  repoPath: string;
  base: string;
  head: string;
}): Promise<McpTextResult> {
  return guard('analyze_pull_request', async () => {
    const repoPath = await validateRepoPath(input.repoPath);
    await resolveRefs(repoPath, input.base, input.head);

    const run = await createRun({ repoPath, base: input.base, head: input.head });
    const dir = runDir(run.runId);
    await updateRun(run.runId, { stage: 'analyze' });

    const report = await analyzeRepo({ repoPath, base: input.base, head: input.head });
    await saveAnalysis(dir, report);
    await updateRun(run.runId, {
      status: 'done',
      stage: 'analyzed',
      finishedAt: new Date().toISOString()
    });

    const summary = analysisSummary(run.runId, report);
    const text =
      `Analyzed ${summary.changedFunctions.length} changed function(s); ` +
      `${summary.callersWithoutTests.length} caller(s) without tests. Run ${run.runId}.`;
    return ok(text, summary);
  });
}

export async function generateRegressionTests(input: {
  runId?: string;
  repoPath?: string;
  base?: string;
  head?: string;
  provider?: string;
  maxScenarios?: number;
}): Promise<McpTextResult> {
  return guard('generate_regression_tests', async () => {
    const { run, analysis, dir } = await ensureAnalysis(input);
    const busy = acquire(run.repoPath, run.runId);
    if (busy) return fail(`Repository is busy with run ${busy}. Poll that run or retry later.`);

    try {
      await updateRun(run.runId, { stage: 'generate' });
      const generation = await generateTests({
        repoPath: run.repoPath,
        base: run.base,
        head: run.head,
        report: analysis,
        provider: input.provider as ProviderName | undefined,
        maxScenarios: input.maxScenarios ?? 1,
        outDir: dir
      });

      const valid = generation.scenarios.filter((scenario) => scenario.status === 'valid');
      await updateRun(run.runId, {
        status: 'done',
        stage: 'generated',
        finishedAt: new Date().toISOString(),
        provider: generation.provider,
        model: generation.model
      });

      const structured = {
        runId: run.runId,
        provider: generation.provider,
        model: generation.model,
        scenarios: generation.scenarios.map((scenario) => ({
          id: scenario.id,
          title: scenario.title,
          status: scenario.status,
          attempts: scenario.attempts.length,
          testFile: scenario.fileName ? path.join(dir, scenario.fileName) : undefined
        })),
        validCount: valid.length
      };

      return ok(
        `Generated ${valid.length} valid test(s) for run ${run.runId}.`,
        structured
      );
    } finally {
      release(run.repoPath, run.runId);
    }
  });
}

export async function runRegressionTests(input: {
  runId: string;
  repeat?: number;
}): Promise<McpTextResult> {
  return guard('run_regression_tests', async () => {
    const run = await getRun(input.runId);
    const dir = runDir(run.runId);
    const analysis = AnalysisReportSchema.parse(await readJson(dir, 'analysis.json'));
    const generation = await readJson<GenerationRun>(dir, 'generation.json');

    const busy = acquire(run.repoPath, run.runId);
    if (busy) return fail(`Repository is busy with run ${busy}. Poll that run or retry later.`);

    try {
      await updateRun(run.runId, { stage: 'verify' });
      const verifications: VerificationResult[] = [];

      for (const scenario of generation.scenarios) {
        if (scenario.status !== 'valid' || !scenario.fileName) continue;
        const verification = await verifyTest({
          repoPath: run.repoPath,
          base: run.base,
          head: run.head,
          testFile: path.join(dir, scenario.fileName),
          analysisReport: analysis,
          scenarioId: scenario.id,
          scenarioTitle: scenario.title,
          repeat: input.repeat ?? 3
        });
        verifications.push(verification);
        await writeFile(
          path.join(dir, 'verification.json'),
          `${JSON.stringify(verification, null, 2)}\n`,
          'utf8'
        );
      }

      if (verifications.length === 0) return fail('No valid generated tests to verify.');

      const first = verifications[0];
      await updateRun(run.runId, {
        status: 'done',
        stage: 'verified',
        finishedAt: new Date().toISOString(),
        verdict: first.verdict
      });

      return ok(`Verdict: ${first.verdict} (${first.confidence}).`, {
        runId: run.runId,
        verdict: first.verdict,
        confidence: first.confidence,
        reasons: first.reasons,
        revisions: {
          base: first.revisions.base.consistentStatus,
          head: first.revisions.head.consistentStatus
        }
      });
    } finally {
      release(run.repoPath, run.runId);
    }
  });
}

export async function repairRegressionTool(input: {
  runId: string;
  maxAttempts?: number;
}): Promise<McpTextResult> {
  return guard('repair_regression', async () => {
    const run = await getRun(input.runId);
    const dir = runDir(run.runId);
    const analysis = AnalysisReportSchema.parse(await readJson(dir, 'analysis.json'));
    const verification = await readJson<VerificationResult>(dir, 'verification.json');

    if (verification.verdict !== 'regression_caught') {
      return fail(
        `Repair only applies to regression_caught; this run is ${verification.verdict}.`
      );
    }

    const busy = acquire(run.repoPath, run.runId);
    if (busy) return fail(`Repository is busy with run ${busy}. Poll that run or retry later.`);

    try {
      await updateRun(run.runId, { stage: 'repair' });
      const repair = await repairRegression({
        repoPath: run.repoPath,
        base: run.base,
        head: run.head,
        verification,
        analysisReport: analysis,
        testFile: verification.testFile,
        maxAttempts: input.maxAttempts ?? 3,
        outDir: dir
      });

      await updateRun(run.runId, {
        status: 'done',
        stage: 'repaired',
        finishedAt: new Date().toISOString(),
        repairStatus: repair.status
      });

      return ok(`Repair status: ${repair.status}.`, {
        runId: run.runId,
        status: repair.status,
        patchStats: repair.patchStats,
        restoresBase: repair.restoresBase,
        preservesPrIntent: repair.preservesPrIntent,
        guards: repair.attempts.at(-1)?.guards ?? []
      });
    } finally {
      release(run.repoPath, run.runId);
    }
  });
}

async function reportUrl(runId: string): Promise<string | undefined> {
  const port = Number.parseInt(process.env.TESTPILOT_REPORT_PORT ?? '4317', 10);
  const url = `http://127.0.0.1:${port}/runs/${runId}`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(300) });
    return response.ok ? url : undefined;
  } catch {
    return undefined;
  }
}

export async function getVerificationReport(input: {
  runId: string;
  format?: 'summary' | 'markdown';
}): Promise<McpTextResult> {
  return guard('get_verification_report', async () => {
    const run = await getRun(input.runId);
    const dir = runDir(run.runId);

    if (input.format === 'markdown') {
      const markdown = await renderMarkdownReport(dir);
      return ok(markdown, { runId: run.runId, format: 'markdown' });
    }

    const loaded = await loadRun(dir);
    const url = await reportUrl(run.runId);
    return ok(
      `Verdict: ${loaded.verification?.verdict ?? 'unknown'}; repair: ${loaded.repair?.status ?? 'not run'}.`,
      {
        runId: run.runId,
        verdict: loaded.verification?.verdict,
        confidence: loaded.verification?.confidence,
        reasons: loaded.verification?.reasons ?? [],
        repairStatus: loaded.repair?.status,
        existingSuite: loaded.verification?.existingSuite,
        fixedExistingSuite: loaded.fixedExistingSuite,
        testFile: loaded.testFileName,
        reportUrl: url
      }
    );
  });
}

export async function runTestpilotLoop(input: {
  repoPath: string;
  base: string;
  head: string;
  provider?: string;
  maxScenarios?: number;
}): Promise<McpTextResult> {
  try {
    const repoPath = await validateRepoPath(input.repoPath);
    await resolveRefs(repoPath, input.base, input.head);

    const run = await createRun({ repoPath, base: input.base, head: input.head });
    const busy = acquire(repoPath, run.runId);
    if (busy) return fail(`Repository is busy with run ${busy}. Poll that run or retry later.`);

    void runLoop({
      repoPath,
      base: input.base,
      head: input.head,
      provider: input.provider as ProviderName | undefined,
      maxScenarios: input.maxScenarios ?? 1,
      runId: run.runId,
      log: (line) => console.error(line)
    })
      .catch(async (error: unknown) => {
        await updateRun(run.runId, {
          status: 'failed',
          stage: 'failed',
          finishedAt: new Date().toISOString(),
          error: (error as Error).message
        }).catch(() => undefined);
      })
      .finally(() => release(repoPath, run.runId));

    return ok(`Started run ${run.runId}. Poll get_run_status until status is done.`, {
      runId: run.runId,
      status: 'running'
    });
  } catch (error) {
    return fail((error as Error).message);
  }
}

export async function getRunStatus(input: { runId: string }): Promise<McpTextResult> {
  return guard('get_run_status', async () => {
    const run = await getRun(input.runId);
    const elapsedMs = Date.now() - new Date(run.startedAt).getTime();
    return ok(`Run ${run.runId}: ${run.status} at stage ${run.stage}.`, {
      runId: run.runId,
      status: run.status,
      stage: run.stage,
      elapsedMs,
      verdict: run.verdict,
      repairStatus: run.repairStatus,
      error: run.error
    });
  });
}