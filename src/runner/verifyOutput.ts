/**
 * CLI helpers for the verification runner: reading a generated directory,
 * writing verification.json, and rendering the readable summary.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AnalysisReport } from '../analysis/schema';
import { sanitizeRef } from '../generate/naming';
import { verifyTest } from './verify';
import { VerificationResultSchema, type VerificationResult } from './schema';

export interface GeneratedEntry {
  testFile: string;
  scenarioId?: string;
  scenarioTitle?: string;
}

export function parsePositiveInt(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return parsed;
}

/**
 * Reads a generated output directory. Test files are matched to their
 * scenario through generation.json when it is present.
 */
export async function readGeneratedDirectory(dir: string): Promise<GeneratedEntry[]> {
  const testpilotDir = path.join(dir, '__testpilot__');
  const entries: GeneratedEntry[] = [];

  let files: string[] = [];
  try {
    files = (await readdir(testpilotDir)).filter((file) => file.endsWith('.test.ts'));
  } catch {
    return entries;
  }

  let scenarios: Map<string, { id?: string; title?: string }> = new Map();
  try {
    const generation = JSON.parse(await readFile(path.join(dir, 'generation.json'), 'utf8')) as {
      scenarios?: { id?: string; title?: string; fileName?: string }[];
    };
    scenarios = new Map(
      (generation.scenarios ?? [])
        .filter((scenario) => scenario.fileName)
        .map((scenario) => [path.basename(scenario.fileName as string), scenario])
    );
  } catch {
    scenarios = new Map();
  }

  for (const file of files.sort()) {
    const scenario = scenarios.get(file);
    entries.push({
      testFile: path.join('__testpilot__', file),
      scenarioId: scenario?.id,
      scenarioTitle: scenario?.title
    });
  }

  return entries;
}

export async function writeVerification(
  outRoot: string,
  head: string,
  result: VerificationResult
): Promise<string> {
  const dir = path.resolve(outRoot, sanitizeRef(head));
  await mkdir(dir, { recursive: true });
  const absolute = path.join(dir, 'verification.json');
  await writeFile(absolute, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return absolute;
}

function revisionLine(label: string, revision: VerificationResult['revisions']['base']): string {
  const location = revision.failureLocation
    ? ` at ${revision.failureLocation.file}:${revision.failureLocation.line}`
    : '';
  const type = revision.failureType ? ` [${revision.failureType}]` : '';
  return `  ${label}: ${revision.consistentStatus}${type}${location} (evidence: ${revision.changedCodeEvidence})`;
}

export function printVerificationSummary(result: VerificationResult): void {
  console.log('');
  console.log(`Verification: ${result.testFile}`);
  if (result.scenarioTitle) console.log(`  scenario: ${result.scenarioTitle}`);
  console.log(`  verdict: ${result.verdict}`);
  console.log(`  confidence: ${result.confidence}`);
  console.log(`  fixed check: ${result.fixedCheck}`);

  console.log('  revisions:');
  console.log(revisionLine('base', result.revisions.base));
  console.log(revisionLine('head', result.revisions.head));
  if (result.revisions.fixed) {
    console.log(revisionLine('fixed', result.revisions.fixed));
  }

  const suite = result.existingSuite;
  console.log(
    suite.ran
      ? `  existing suite on head: ${suite.passed} passed, ${suite.failed} failed, ${suite.total} total`
      : `  existing suite on head: not available${suite.error ? ` (${suite.error.split('\n')[0]})` : ''}`
  );

  for (const reason of result.reasons) {
    console.log(`  reason: ${reason}`);
  }

  const headRun = result.revisions.head.runs[0];
  const message = headRun?.tests.find((test) => test.failureMessages.length > 0)?.failureMessages[0];
  if (message) {
    console.log('  head failure excerpt:');
    for (const line of message.split('\n').slice(0, 10)) {
      console.log(`    ${line}`);
    }
  }
}

export interface VerifyGeneratedOptions {
  repoPath: string;
  base: string;
  head: string;
  fixed?: string;
  report?: AnalysisReport;
  generation: { outDir: string; scenarios: { id?: string; title?: string; fileName?: string; status: string }[] };
  repeat: number;
  timeoutMs: number;
  outRoot: string;
}

/**
 * Verifies every valid test produced by a generation run.
 */
export async function verifyGeneratedRun(
  options: VerifyGeneratedOptions
): Promise<VerificationResult[]> {
  const results: VerificationResult[] = [];

  for (const scenario of options.generation.scenarios) {
    if (scenario.status !== 'valid' || !scenario.fileName) continue;

    const result = await verifyTest({
      repoPath: options.repoPath,
      base: options.base,
      head: options.head,
      fixed: options.fixed,
      testFile: path.join(options.generation.outDir, scenario.fileName),
      analysisReport: options.report,
      scenarioId: scenario.id,
      scenarioTitle: scenario.title,
      repeat: options.repeat,
      timeoutMs: options.timeoutMs
    });

    results.push(result);
    await writeVerification(options.outRoot, options.head, result);
  }

  return results;
}

export { VerificationResultSchema };
