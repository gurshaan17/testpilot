/**
 * One structured LLM call per changed function to plan regression scenarios.
 * Evidence is validated against real worktree files before scenarios survive.
 */
import path from 'node:path';
import { z } from 'zod';
import type { LanguageModelUsage } from 'ai';
import { generateStructured, type ProviderName } from '../llm/client';
import { buildScenarioPrompt, PROMPT_VERSION } from '../llm/prompts';
import { readSafe } from './contextFiles';
import type { ContextPack } from './context';

export const ScenarioSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  title: z.string().min(1),
  risk: z.string().min(1),
  kind: z.enum(['behavior-change', 'failure-path', 'contract']),
  expectedBehaviorOnBase: z.string().min(1),
  howChangeMayViolateIt: z.string().min(1),
  evidence: z.array(
    z.object({
      file: z.string(),
      line: z.number().int(),
      note: z.string()
    })
  ),
  severity: z.enum(['high', 'medium', 'low']),
  testable: z.boolean()
});

export const ScenarioPlanSchema = z.object({
  scenarios: z.array(ScenarioSchema).max(3)
});

export type Scenario = z.infer<typeof ScenarioSchema>;
export type ScenarioPlan = z.infer<typeof ScenarioPlanSchema>;

export interface DroppedEvidence {
  scenarioId: string;
  file: string;
  line: number;
  reason: string;
}

export interface PlanningResult {
  scenarios: Scenario[];
  selected: Scenario[];
  droppedEvidence: DroppedEvidence[];
  provider: ProviderName;
  model: string;
  usage: LanguageModelUsage;
  prompt: string;
  system: string;
}

export interface PlanOptions {
  pack: ContextPack;
  baseWorktreeDir: string;
  headWorktreeDir: string;
  provider?: ProviderName;
  model?: string;
  maxScenarios?: number;
}

function evidenceLineCount(
  baseWorktreeDir: string,
  headWorktreeDir: string,
  file: string,
  line: number
): { valid: boolean; reason?: string } {
  const safePath = file.split(path.sep).join('/');
  if (safePath.startsWith('/') || safePath.includes('..')) {
    return { valid: false, reason: 'evidence path is absolute or traverses directories' };
  }

  const head = readSafe(headWorktreeDir, safePath);
  const base = head ? null : readSafe(baseWorktreeDir, safePath);
  const content = head?.content ?? base?.content;

  if (!content) {
    return { valid: false, reason: 'file does not exist in base or head (or is forbidden)' };
  }

  const lines = content.split('\n').length;
  if (line < 1 || line > lines) {
    return { valid: false, reason: `line ${line} is outside 1..${lines}` };
  }

  return { valid: true };
}

function rank(scenarios: Scenario[]): Scenario[] {
  const severity = { high: 0, medium: 1, low: 2 };
  return scenarios
    .map((scenario, index) => ({ scenario, index }))
    .sort((a, b) => {
      if (a.scenario.testable !== b.scenario.testable) return a.scenario.testable ? -1 : 1;
      const bySeverity = severity[a.scenario.severity] - severity[b.scenario.severity];
      return bySeverity !== 0 ? bySeverity : a.index - b.index;
    })
    .map((entry) => entry.scenario);
}

export async function planScenarios(options: PlanOptions): Promise<PlanningResult> {
  const promptPair = buildScenarioPrompt(options.pack);
  const result = await generateStructured({
    provider: options.provider,
    model: options.model,
    system: promptPair.system,
    prompt: promptPair.prompt,
    schema: ScenarioPlanSchema,
    temperature: 0.1
  });

  const droppedEvidence: DroppedEvidence[] = [];
  const seenIds = new Set<string>();
  const scenarios: Scenario[] = [];

  for (const scenario of result.data.scenarios) {
    if (seenIds.has(scenario.id)) continue;
    seenIds.add(scenario.id);

    const evidence = scenario.evidence.filter((entry) => {
      const check = evidenceLineCount(
        options.baseWorktreeDir,
        options.headWorktreeDir,
        entry.file,
        entry.line
      );
      if (!check.valid) {
        droppedEvidence.push({
          scenarioId: scenario.id,
          file: entry.file,
          line: entry.line,
          reason: check.reason ?? 'invalid evidence'
        });
      }
      return check.valid;
    });

    if (evidence.length === 0) continue;
    scenarios.push({ ...scenario, evidence });
  }

  const ranked = rank(scenarios);
  const maxScenarios = Math.max(1, Math.min(options.maxScenarios ?? 1, 3));
  const selected = ranked.filter((scenario) => scenario.testable).slice(0, maxScenarios);

  return {
    scenarios: ranked,
    selected,
    droppedEvidence,
    provider: result.provider,
    model: result.model,
    usage: result.usage,
    prompt: promptPair.prompt,
    system: promptPair.system
  };
}

export { PROMPT_VERSION };