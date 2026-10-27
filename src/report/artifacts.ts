/**
 * Loads a run directory's artifacts into one plain object for rendering.
 * Reports are deterministic renderings; nothing here calls an LLM.
 */
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { AnalysisReportSchema, type AnalysisReport } from '../analysis/schema';
import { RepairResultSchema, type RepairAttempt, type RepairResult } from '../repair/schema';
import { VerificationResultSchema, type VerificationResult } from '../runner/schema';
import { RunRecordSchema, type RunRecord } from '../store/schema';
import {
  GenerationArtifactSchema,
  TimelineSchema,
  type GenerationArtifact,
  type TimelineArtifact
} from '../store/schema';
import type { GuardOutcome } from '../repair/schema';

export interface LoadedRun {
  dir: string;
  runId?: string;
  run?: RunRecord;
  generation?: GenerationArtifact;
  verification?: VerificationResult;
  repair?: RepairResult;
  timeline?: TimelineArtifact;
  analysis?: AnalysisReport;
  scenario?: NonNullable<GenerationArtifact['scenarios']>[number];
  testCode?: string;
  testFileName?: string;
  fixPatch?: string;
  repairAttempt?: RepairAttempt;
  guards: GuardOutcome[];
  fixedExistingSuite?: { ran: boolean; passed: number; failed: number; total: number };
  testFileIntact?: boolean;
  fixedSummary?: {
    consistentStatus: string;
    runs: number;
    failureType?: string;
    failureLocation?: { file: string; line: number };
  };
}

async function readJson<T>(
  file: string,
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T } }
): Promise<T | undefined> {
  try {
    const parsed = schema.safeParse(JSON.parse(await readFile(file, 'utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

async function findTestFile(dir: string, preferred?: string): Promise<{ name: string; code: string } | undefined> {
  const testpilotDir = path.join(dir, '__testpilot__');
  if (!existsSync(testpilotDir)) return undefined;

  const files = (await readdir(testpilotDir)).filter((file) => file.endsWith('.test.ts')).sort();
  if (preferred && files.includes(preferred)) {
    return { name: preferred, code: (await readText(path.join(testpilotDir, preferred))) ?? '' };
  }

  const first = files[0];
  if (!first) return undefined;
  return { name: first, code: (await readText(path.join(testpilotDir, first))) ?? '' };
}

export async function loadRun(dir: string): Promise<LoadedRun> {
  const absolute = path.resolve(dir);
  const run = await readJson<RunRecord>(path.join(absolute, 'run.json'), RunRecordSchema);
  const generation = await readJson<GenerationArtifact>(
    path.join(absolute, 'generation.json'),
    GenerationArtifactSchema
  );
  const verification = await readJson<VerificationResult>(
    path.join(absolute, 'verification.json'),
    VerificationResultSchema
  );
  const repair = await readJson<RepairResult>(
    path.join(absolute, 'repair.json'),
    RepairResultSchema
  );
  const timeline = await readJson<TimelineArtifact>(
    path.join(absolute, 'timeline.json'),
    TimelineSchema
  );
  const analysis = await readJson<AnalysisReport>(
    path.join(absolute, 'analysis.json'),
    AnalysisReportSchema
  );

  const scenario = generation?.scenarios?.[0];
  const preferred =
    (verification?.testFile ? path.basename(verification.testFile) : undefined) ??
    (scenario?.fileName ? path.basename(scenario.fileName) : undefined);
  const test = await findTestFile(absolute, preferred);

  const repairAttempt =
    repair?.attempts.find((attempt) => attempt.verification?.fixedCheck === 'passed') ??
    repair?.attempts.at(-1);

  const repaired = repairAttempt?.verification;
  const guards = repairAttempt?.guards ?? repair?.attempts.at(-1)?.guards ?? [];

  const fixedRevision = verification?.revisions.fixed;
  const fixedSummary = fixedRevision
    ? {
        consistentStatus: fixedRevision.consistentStatus,
        runs: fixedRevision.runs.length,
        failureType: fixedRevision.failureType,
        failureLocation: fixedRevision.failureLocation
      }
    : repaired?.fixedStatus
      ? {
          consistentStatus: repaired.fixedStatus,
          runs: verification?.repeat ?? 0,
          failureType: undefined,
          failureLocation: undefined
        }
      : undefined;

  return {
    dir: absolute,
    runId: run?.runId,
    run,
    generation,
    verification,
    repair,
    timeline,
    analysis,
    scenario,
    testCode: test?.code,
    testFileName: test?.name,
    fixPatch:
      repair?.patch ??
      (await readText(path.join(absolute, 'fix.patch'))) ??
      undefined,
    repairAttempt,
    guards,
    fixedExistingSuite: repaired?.fixedExistingSuite,
    testFileIntact: repaired?.testFileIntact,
    fixedSummary
  };
}