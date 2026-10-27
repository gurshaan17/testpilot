/**
 * Proves the repair pipeline with hand-written patches and no LLM.
 */
import { config } from 'dotenv';
config({ quiet: true });
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { analyzeRepo } from '../src/analysis/analyze';
import type { AnalysisReport } from '../src/analysis/schema';
import { verifyTest } from '../src/runner/verify';
import type { VerificationResult } from '../src/runner/schema';
import { repairRegression } from '../src/repair/loop';
import type { RepairProposalResult } from '../src/repair/agent';
import { REPAIR_CONTROLS, type RepairControl } from './repair-fixtures';

const ROOT = path.resolve('.');
const REPO = path.resolve('../demo-shop');
const DOCS = path.join(ROOT, 'docs', 'repair-controls.md');
const TEST_FILES: Record<string, string> = {
  'bug/payment-concurrency': 'fixtures/controls/payment-regression.control.test.ts',
  'bug/user-lean': 'fixtures/controls/profile-lean.control.test.ts'
};

interface Row {
  control: string;
  expected: string;
  actual: string;
  pass: boolean;
}

function stubProposer(control: RepairControl) {
  return async (): Promise<RepairProposalResult> => ({
    proposal: {
      diagnosis: `stub: ${control.name}`,
      rootCause: { file: control.edits?.[0]?.file ?? 'src/users/userRepository.ts', function: 'getUser', line: 36 },
      strategy: 'stub',
      edits: control.edits ?? [],
      preservesPrIntent: control.preservesPrIntent ?? false,
      intentNote: 'stub control'
    },
    prompt: 'stub',
    system: 'stub',
    provider: 'google',
    model: 'stub',
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } as RepairProposalResult['usage']
  });
}

async function runRepairControl(
  control: RepairControl,
  verification: VerificationResult,
  report: AnalysisReport
): Promise<string> {
  const result = await repairRegression({
    repoPath: REPO,
    base: 'main',
    head: control.branch,
    verification,
    analysisReport: report,
    testFile: TEST_FILES[control.branch],
    maxAttempts: 2,
    repeat: 1,
    propose: stubProposer(control)
  });
  return result.status;
}

async function runGuardControl(control: RepairControl): Promise<string> {
  const result = control.guardCheck?.();
  return result && !result.ok ? `rejected` : 'accepted';
}

async function main(): Promise<void> {
  console.log('Analyzing demo-shop...');
  const reports: Record<string, AnalysisReport> = {
    'bug/payment-concurrency': await analyzeRepo({ repoPath: REPO, base: 'main', head: 'bug/payment-concurrency' }),
    'bug/user-lean': await analyzeRepo({ repoPath: REPO, base: 'main', head: 'bug/user-lean' })
  };

  console.log('Verifying control tests...');
  const verifications: Record<string, VerificationResult> = {};
  for (const [branch, testFile] of Object.entries(TEST_FILES)) {
    verifications[branch] = await verifyTest({
      repoPath: REPO,
      base: 'main',
      head: branch,
      testFile,
      analysisReport: reports[branch],
      repeat: 1
    });
    console.log(`  ${branch}: ${verifications[branch].verdict}`);
  }

  const rows: Row[] = [];

  for (const control of REPAIR_CONTROLS) {
    console.log(`Control: ${control.name}`);
    let actual: string;

    if (control.kind === 'repair') {
      actual = await runRepairControl(control, verifications[control.branch], reports[control.branch]);
    } else if (control.kind === 'guard') {
      actual = await runGuardControl(control);
    } else {
      const result = await verifyTest({
        repoPath: REPO,
        base: 'main',
        head: control.branch,
        fixedPatch: control.patchText,
        testFile: TEST_FILES[control.branch],
        analysisReport: reports[control.branch],
        repeat: 1
      });
      actual = result.fixedCheck;
    }

    rows.push({
      control: control.name,
      expected: control.expectation,
      actual,
      pass: actual === control.expectation
    });
  }

  const widths = {
    control: Math.max(7, ...rows.map((row) => row.control.length)),
    expected: Math.max(8, ...rows.map((row) => row.expected.length)),
    actual: Math.max(6, ...rows.map((row) => row.actual.length))
  };
  const header = [
    'Control'.padEnd(widths.control),
    'Expected'.padEnd(widths.expected),
    'Actual'.padEnd(widths.actual),
    'Result'
  ].join('  ');
  console.log(`\n${header}`);
  console.log('-'.repeat(header.length));
  for (const row of rows) {
    console.log(
      [row.control.padEnd(widths.control), row.expected.padEnd(widths.expected), row.actual.padEnd(widths.actual), row.pass ? 'PASS' : 'FAIL'].join('  ')
    );
  }

  const failed = rows.filter((row) => !row.pass);
  console.log(`\n${rows.length - failed.length}/${rows.length} repair controls passed.`);

  await mkdir(path.dirname(DOCS), { recursive: true });
  const docs = [
    '# Repair controls',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    'Hand-written patches; no LLM involved. `fixed_by_revert` means the fix restores the base function body.',
    '',
    '| Control | Expected | Actual | Result |',
    '| --- | --- | --- | --- |',
    ...rows.map((row) => `| ${row.control} | ${row.expected} | ${row.actual} | ${row.pass ? 'PASS' : 'FAIL'} |`),
    '',
    `${rows.length - failed.length}/${rows.length} repair controls passed.`
  ].join('\n');
  await writeFile(DOCS, `${docs}\n`, 'utf8');
  console.log(`Saved ${DOCS}`);

  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
