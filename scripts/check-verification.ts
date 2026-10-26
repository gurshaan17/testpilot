/**
 * Proves the verification runner against hand-written controls.
 * Reference tests are read only as runner controls; they never reach an LLM.
 */
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { analyzeRepo } from '../src/analysis/analyze';
import { verifyTest } from '../src/runner/verify';
import type { AnalysisReport } from '../src/analysis/schema';
import {
  CONTROLS,
  REPO,
  makeFixedClone,
  printTable,
  referenceFile,
  toRow,
  type Row
} from './verification-fixtures';

const DOCS = path.resolve('docs', 'verification-controls.md');

async function checkControl(
  control: (typeof CONTROLS)[number],
  report: AnalysisReport
): Promise<Row> {
  const result = await verifyTest({
    repoPath: REPO,
    base: 'main',
    head: control.branch,
    testFile: control.testFile,
    analysisReport: report,
    repeat: control.repeat,
    timeoutMs: control.timeoutMs
  });
  return toRow(control, result);
}

async function main(): Promise<void> {
  console.log('Analyzing demo-shop...');
  const reports: Record<string, AnalysisReport> = {
    'bug/payment-concurrency': await analyzeRepo({
      repoPath: REPO,
      base: 'main',
      head: 'bug/payment-concurrency'
    }),
    'bug/user-lean': await analyzeRepo({
      repoPath: REPO,
      base: 'main',
      head: 'bug/user-lean'
    })
  };

  const rows: Row[] = [];

  for (const control of CONTROLS) {
    console.log(`Running control: ${control.name}`);
    rows.push(await checkControl(control, reports[control.branch]));
  }

  // Reference tests are controls for the runner only.
  const references: [string, string, string][] = [
    ['reference payment', 'bug/payment-concurrency', 'payment-failure.reference.test.ts'],
    ['reference lean', 'bug/user-lean', 'profile-lean.reference.test.ts']
  ];

  for (const [name, branch, file] of references) {
    console.log(`Running control: ${name}`);
    const result = await verifyTest({
      repoPath: REPO,
      base: 'main',
      head: branch,
      testFile: await referenceFile(file),
      analysisReport: reports[branch],
      repeat: 2,
      timeoutMs: 60_000
    });
    rows.push(
      toRow(
        {
          name,
          branch,
          testFile: file,
          repeat: 2,
          timeoutMs: 60_000,
          expected: ['regression_caught']
        },
        result
      )
    );
  }

  // Three-way fixed check in a throwaway clone (demo-shop is never touched).
  console.log('Preparing a temporary clone for fixed-revision controls...');
  const clone = await makeFixedClone();

  try {
    const fixedControls: [string, string, string, string, AnalysisReport][] = [
      [
        'fixed payment',
        'bug/payment-concurrency',
        clone.payment,
        'fixtures/controls/payment-regression.control.test.ts',
        reports['bug/payment-concurrency']
      ],
      [
        'fixed lean',
        'bug/user-lean',
        clone.lean,
        'fixtures/controls/profile-lean.control.test.ts',
        reports['bug/user-lean']
      ]
    ];

    for (const [name, branch, fixRef, testFile, report] of fixedControls) {
      console.log(`Running control: ${name}`);
      const result = await verifyTest({
        repoPath: clone.dir,
        base: 'main',
        head: branch,
        fixed: fixRef,
        testFile,
        analysisReport: report,
        repeat: 1,
        timeoutMs: 60_000
      });
      rows.push({
        control: name,
        expected: 'regression_caught + fixedCheck=passed',
        actual: `${result.verdict} + fixedCheck=${result.fixedCheck}`,
        confidence: result.confidence,
        evidence: result.revisions.head.changedCodeEvidence,
        pass: result.verdict === 'regression_caught' && result.fixedCheck === 'passed'
      });
    }
  } finally {
    await rm(clone.dir, { recursive: true, force: true });
  }

  printTable(rows);

  const failures = rows.filter((entry) => !entry.pass);
  console.log(`\n${rows.length - failures.length}/${rows.length} controls passed.`);

  await mkdir(path.dirname(DOCS), { recursive: true });
  const documented = [
    '# Verification controls',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    'These controls prove the verdict classifier independently of any LLM. Reference tests were read only as runner controls.',
    '',
    '| Control | Expected | Actual | Confidence | Evidence | Result |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows.map(
      (entry) =>
        `| ${entry.control} | ${entry.expected} | ${entry.actual} | ${entry.confidence} | ${entry.evidence} | ${entry.pass ? 'PASS' : 'FAIL'} |`
    ),
    '',
    `${rows.length - failures.length}/${rows.length} controls passed.`
  ].join('\n');
  await writeFile(DOCS, `${documented}\n`, 'utf8');
  console.log(`Saved ${DOCS}`);

  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
