/**
 * Acceptance checks for the deterministic analysis engine against demo-shop.
 * Run: npm run check-analysis
 */
import path from 'node:path';
import { analyzeRepo } from '../src/analysis/analyze';
import type { AnalysisReport } from '../src/analysis/schema';

interface Row {
  check: string;
  expected: string;
  actual: string;
  pass: boolean;
}

const rows: Row[] = [];

function check(name: string, expected: string, actual: string): void {
  rows.push({ check: name, expected, actual, pass: expected === actual });
}

function summary(values: string[]): string {
  return values.length > 0 ? values.join(', ') : 'none';
}

function callerNames(report: AnalysisReport, depth: number): string[] {
  return report.impactGraph.nodes
    .filter((node) => node.depth === depth)
    .map((node) => node.name)
    .sort();
}

function nodeFor(report: AnalysisReport, name: string) {
  return report.impactGraph.nodes.find((node) => node.name === name);
}

function testBaseline(report: AnalysisReport, label: string): void {
  check(
    `${label} / baseline failures`,
    '0',
    String(report.baseline.failures.length)
  );
}

function checkPayment(report: AnalysisReport): void {
  testBaseline(report, 'payment');

  const changed = report.changedFunctions.find((fn) => fn.name === 'processPayment');
  check('payment / changed function', 'processPayment', changed?.name ?? 'none');

  const direct = callerNames(report, 1);
  check(
    'payment / direct callers',
    'checkoutHandler, retryPayment',
    summary(direct)
  );

  const checkout = nodeFor(report, 'checkoutHandler');
  const retry = nodeFor(report, 'retryPayment');
  check(
    'payment / checkoutHandler coverage',
    'src/api/checkoutHandler.test.ts',
    summary(checkout?.coveringTests ?? [])
  );
  check(
    'payment / retryPayment coverage',
    'src/api/retryPayment.test.ts',
    summary(retry?.coveringTests ?? [])
  );

  const failurePathTests = (changed?.coveringTests ?? []).filter((file) =>
    /failure|declined|negative/i.test(file)
  );
  check(
    'payment / no failure-path test covers the change',
    'none',
    summary(failurePathTests)
  );

  const successTests = new Set([
    'src/api/checkoutHandler.test.ts',
    'src/api/retryPayment.test.ts',
    'src/payments/processPayment.test.ts'
  ]);
  const unexpected = (changed?.coveringTests ?? []).filter((file) => !successTests.has(file));
  check('payment / covering tests are success paths', 'none', summary(unexpected));
}

function checkLean(report: AnalysisReport): void {
  testBaseline(report, 'lean');

  const changed = report.changedFunctions.find((fn) => fn.name === 'getUser');
  check('lean / changed function', 'getUser', changed?.name ?? 'none');

  const direct = callerNames(report, 1);
  check(
    'lean / direct callers',
    'getPublicProfile, login',
    summary(direct)
  );

  const untestedNames = report.callersWithoutTests.map((node) => node.name).sort();
  check(
    'lean / caller without tests',
    'getPublicProfile',
    summary(untestedNames)
  );

  const login = nodeFor(report, 'login');
  const loginIsGap = report.callersWithoutTests.some((node) => node.name === 'login');
  check(
    'lean / login has tests',
    `yes (${summary(login?.coveringTests ?? [])})`,
    loginIsGap ? 'no' : `yes (${summary(login?.coveringTests ?? [])})`
  );
}

async function main(): Promise<void> {
  const repoPath = path.resolve('../demo-shop');

  console.log('Analyzing demo-shop branches...\n');
  const paymentReport = await analyzeRepo({
    repoPath,
    base: 'main',
    head: 'bug/payment-concurrency',
    noCache: true
  });
  const leanReport = await analyzeRepo({
    repoPath,
    base: 'main',
    head: 'bug/user-lean',
    noCache: true
  });

  checkPayment(paymentReport);
  checkLean(leanReport);

  const widths = {
    check: Math.max(6, ...rows.map((row) => row.check.length)),
    expected: Math.max(8, ...rows.map((row) => row.expected.length)),
    actual: Math.max(6, ...rows.map((row) => row.actual.length))
  };

  const header = [
    'Check'.padEnd(widths.check),
    'Expected'.padEnd(widths.expected),
    'Actual'.padEnd(widths.actual),
    'Result'
  ].join('  ');
  console.log(header);
  console.log('-'.repeat(header.length));

  for (const row of rows) {
    console.log(
      [
        row.check.padEnd(widths.check),
        row.expected.padEnd(widths.expected),
        row.actual.padEnd(widths.actual),
        row.pass ? 'PASS' : 'FAIL'
      ].join('  ')
    );
  }

  const failures = rows.filter((row) => !row.pass).length;
  console.log(
    `\n${rows.length - failures}/${rows.length} checks passed.`
  );
  if (failures > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});