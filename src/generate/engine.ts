/**
 * Orchestrates context building, planning, validation, and output artifacts.
 * Never writes into the analyzed repository's working tree.
 */
import path from 'node:path';
import type { AnalysisReport } from '../analysis/schema';
import { createWorktree } from '../runner/worktree';
import type { ProviderName } from '../llm/client';
import { PROMPT_VERSION } from '../llm/prompts';
import { buildContextPack, type ContextPack } from './context';
import { planScenarios, type DroppedEvidence, type Scenario } from './plan';
import { sanitizeRef } from './naming';
import {
  writeGenerationJson,
  writePrompt,
  type PromptFile
} from './output';
import {
  validateScenario,
  type HeadPreview,
  type ValidationAttempt
} from './validate';
import { writeGeneratedTest } from './writeTest';
import type { GeneratedTestResult, GenerateTestOptions } from './writeTest';

export interface GenerateDeps {
  planScenarios?: typeof planScenarios;
  generateTest?: (options: GenerateTestOptions) => Promise<GeneratedTestResult>;
}

export interface GenerateOptions {
  repoPath: string;
  base: string;
  head: string;
  report: AnalysisReport;
  provider?: ProviderName;
  model?: string;
  maxScenarios?: number;
  outRoot?: string;
  /** Exact output directory, overriding outRoot/<sanitized-head>. */
  outDir?: string;
  deps?: GenerateDeps;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface GenerationScenario extends Scenario {
  status: 'valid' | 'invalid';
  attempts: ValidationAttempt[];
  fileName?: string;
  code?: string;
  assumptions: string[];
  testsWhat: string;
  finalError?: string;
  headPreview?: HeadPreview;
}

export interface GenerationRun {
  outDir: string;
  generationPath: string;
  provider: string;
  model: string;
  promptVersion: string;
  scenarios: GenerationScenario[];
  droppedEvidence: DroppedEvidence[];
  prompts: PromptFile[];
  totalUsage: UsageTotals;
}

interface ScenarioJob {
  scenario: Scenario;
  pack: ContextPack;
}

function addUsage(total: UsageTotals, usage: {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}): void {
  total.inputTokens += usage.inputTokens ?? 0;
  total.outputTokens += usage.outputTokens ?? 0;
  total.totalTokens += usage.totalTokens ?? 0;
}

function severityRank(severity: Scenario['severity']): number {
  return severity === 'high' ? 0 : severity === 'medium' ? 1 : 2;
}

function uniqueScenarioId(id: string, used: Set<string>): string {
  let candidate = id;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${id}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

export async function generateTests(options: GenerateOptions): Promise<GenerationRun> {
  if (options.report.changedFunctions.length === 0) {
    throw new Error('Analysis report contains no changed functions to generate for');
  }

  const repoPath = path.resolve(options.repoPath);
  const base = await createWorktree(repoPath, options.base);
  const head = await createWorktree(repoPath, options.head);

  try {
    const runDir = options.outDir
      ? path.resolve(options.outDir)
      : path.resolve(options.outRoot ?? './out/generated', sanitizeRef(options.head));
    const promptFiles: PromptFile[] = [];
    const droppedEvidence: DroppedEvidence[] = [];
    const usage: UsageTotals = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const jobs: ScenarioJob[] = [];
    let provider = options.provider ?? '';
    let model = options.model ?? '';

    for (const changed of options.report.changedFunctions) {
      const pack = buildContextPack(
        options.report,
        {
          repoPath,
          baseWorktreeDir: base.dir,
          headWorktreeDir: head.dir
        },
        { file: changed.file, qualifiedName: changed.qualifiedName, name: changed.name }
      );

      const plan = await (options.deps?.planScenarios ?? planScenarios)({
        pack,
        baseWorktreeDir: base.dir,
        headWorktreeDir: head.dir,
        provider: options.provider,
        model: options.model,
        maxScenarios: 3
      });
      provider = plan.provider;
      model = plan.model;
      addUsage(usage, plan.usage);
      droppedEvidence.push(...plan.droppedEvidence);

      const planFile = await writePrompt(
        runDir,
        `plan-${changed.qualifiedName}`,
        plan.system,
        plan.prompt
      );
      promptFiles.push({
        kind: 'plan',
        scenarioId: null,
        function: changed.qualifiedName,
        file: planFile
      });

      for (const scenario of plan.scenarios.filter((entry) => entry.testable)) {
        jobs.push({ scenario, pack });
      }
    }

    jobs.sort(
      (a, b) => severityRank(a.scenario.severity) - severityRank(b.scenario.severity)
    );
    const maxScenarios = Math.max(1, Math.min(options.maxScenarios ?? 1, 3));
    const selected = jobs.slice(0, maxScenarios);
    const usedIds = new Set<string>();
    const scenarios: GenerationScenario[] = [];

    for (const job of selected) {
      const uniqueId = uniqueScenarioId(job.scenario.id, usedIds);
      const scenario =
        uniqueId === job.scenario.id ? job.scenario : { ...job.scenario, id: uniqueId };

      const validation = await validateScenario({
        scenario,
        pack: job.pack,
        baseWorktreeDir: base.dir,
        headWorktreeDir: head.dir,
        provider: options.provider,
        model: options.model,
        generate: options.deps?.generateTest
      });

      for (const prompt of validation.prompts) {
        const promptFile = await writePrompt(
          runDir,
          `generate-${scenario.id}-attempt-${prompt.attempt}`,
          prompt.system,
          prompt.prompt
        );
        promptFiles.push({
          kind: 'generate',
          scenarioId: scenario.id,
          function: job.pack.function.qualifiedName,
          file: promptFile
        });
      }

      for (const attempt of validation.attempts) addUsage(usage, attempt.usage);

      if (validation.status === 'valid' && validation.fileName && validation.code) {
        await writeGeneratedTest({
          repo: runDir,
          relativePath: validation.fileName,
          source: validation.code
        });
      }

      scenarios.push({
        ...scenario,
        status: validation.status,
        attempts: validation.attempts,
        fileName: validation.fileName,
        code: validation.code,
        assumptions: validation.assumptions,
        testsWhat: validation.testsWhat,
        finalError: validation.finalError,
        headPreview: validation.headPreview
      });
    }

    const resolveProvider =
      scenarios
        .flatMap((scenario) => scenario.attempts)
        .find((attempt) => attempt.provider !== 'unknown')?.provider ?? provider;
    const resolveModel =
      scenarios
        .flatMap((scenario) => scenario.attempts)
        .find((attempt) => attempt.model !== 'unknown')?.model ?? model;

    const generationPath = await writeGenerationJson(runDir, {
      repo: repoPath,
      base: { ref: options.base, sha: base.sha },
      head: { ref: options.head, sha: head.sha },
      generatedAt: new Date().toISOString(),
      provider: resolveProvider,
      model: resolveModel,
      promptVersion: PROMPT_VERSION,
      scenarios,
      droppedEvidence,
      prompts: promptFiles,
      totalUsage: usage
    });

    return {
      outDir: runDir,
      generationPath,
      provider: resolveProvider,
      model: resolveModel,
      promptVersion: PROMPT_VERSION,
      scenarios,
      droppedEvidence,
      prompts: promptFiles,
      totalUsage: usage
    };
  } finally {
    await head.cleanup();
    await base.cleanup();
  }
}