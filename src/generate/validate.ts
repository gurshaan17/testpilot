/**
 * Generates and validates one scenario on BASE, retrying with exact errors.
 * The head run is an informational preview only, not a classifier.
 */
import type { LanguageModelUsage } from 'ai';
import type { ProviderName } from '../llm/client';
import type { ContextPack } from './context';
import type { Scenario } from './plan';
import { expectedFileName, generateTest } from './writeTest';
import { checkCandidateOnBase, clip, previewOnHead } from './validateCandidate';
import type { HeadPreview } from './validateCandidate';

export type { HeadPreview };

export type AttemptStep = 'generation' | 'lint' | 'typecheck' | 'jest' | null;

export interface AttemptUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ValidationAttempt {
  attempt: number;
  code: string;
  step: AttemptStep;
  error: string;
  provider: string;
  model: string;
  usage: AttemptUsage;
  durationMs: number;
}

export interface PromptRecord {
  attempt: number;
  system: string;
  prompt: string;
}

export interface ScenarioValidation {
  scenario: Scenario;
  status: 'valid' | 'invalid';
  attempts: ValidationAttempt[];
  prompts: PromptRecord[];
  fileName?: string;
  code?: string;
  assumptions: string[];
  testsWhat: string;
  finalError?: string;
  headPreview?: HeadPreview;
}

export interface ValidateOptions {
  scenario: Scenario;
  pack: ContextPack;
  baseWorktreeDir: string;
  headWorktreeDir?: string;
  provider?: ProviderName;
  model?: string;
  maxAttempts?: number;
  generate?: typeof generateTest;
}

function usageOf(usage: LanguageModelUsage): AttemptUsage {
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    totalTokens: usage.totalTokens ?? 0
  };
}

export async function validateScenario(options: ValidateOptions): Promise<ScenarioValidation> {
  const maxAttempts = options.maxAttempts ?? 3;
  const attempts: ValidationAttempt[] = [];
  const prompts: PromptRecord[] = [];
  let previous: { code: string; error: string } | undefined;
  let lastCode = '';
  let lastAssumptions: string[] = [];
  let lastTestsWhat = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const startedAt = Date.now();

    let generated;
    try {
      generated = await (options.generate ?? generateTest)({
        pack: options.pack,
        scenario: options.scenario,
        previous,
        provider: options.provider,
        model: options.model
      });
    } catch (error) {
      attempts.push({
        attempt,
        code: '',
        step: 'generation',
        error: clip((error as Error).message),
        provider: options.provider ?? 'unknown',
        model: options.model ?? 'unknown',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        durationMs: Date.now() - startedAt
      });
      break;
    }

    const { test } = generated;
    lastCode = test.code;
    lastAssumptions = test.assumptions;
    lastTestsWhat = test.testsWhat;
    prompts.push({ attempt, system: generated.system, prompt: generated.prompt });

    const record = (
      step: AttemptStep,
      error: string,
      durationMs: number
    ): ValidationAttempt => ({
      attempt,
      code: test.code,
      step,
      error: clip(error),
      provider: generated.provider,
      model: generated.model,
      usage: usageOf(generated.usage),
      durationMs
    });

    const check = await checkCandidateOnBase({
      fileName: test.fileName,
      expectedFileName: expectedFileName(options.scenario),
      code: test.code,
      baseWorktreeDir: options.baseWorktreeDir
    });
    if (check.step !== null) {
      attempts.push(record(check.step, check.error, Date.now() - startedAt));
      previous = { code: test.code, error: check.error };
      continue;
    }

    attempts.push(record(null, '', Date.now() - startedAt));

    const headPreview = options.headWorktreeDir
      ? await previewOnHead(options.headWorktreeDir, test.fileName, test.code)
      : undefined;

    return {
      scenario: options.scenario,
      status: 'valid',
      attempts,
      prompts,
      fileName: test.fileName,
      code: test.code,
      assumptions: lastAssumptions,
      testsWhat: lastTestsWhat,
      headPreview
    };
  }

  const finalError = attempts.at(-1)?.error || 'generation failed';
  return {
    scenario: options.scenario,
    status: 'invalid',
    attempts,
    prompts,
    fileName: undefined,
    code: lastCode || undefined,
    assumptions: lastAssumptions,
    testsWhat: lastTestsWhat,
    finalError
  };
}
