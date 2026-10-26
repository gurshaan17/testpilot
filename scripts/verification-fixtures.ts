/**
 * Control fixtures and helpers for the verification acceptance harness.
 */
import { execa } from 'execa';
import { mkdtemp, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { VerificationResult } from '../src/runner/schema';

export const REPO = path.resolve('../demo-shop');

export interface Control {
  name: string;
  branch: string;
  testFile: string;
  repeat: number;
  timeoutMs: number;
  expected: string[];
  requireTimeout?: boolean;
}

export interface Row {
  control: string;
  expected: string;
  actual: string;
  confidence: string;
  evidence: string;
  pass: boolean;
}

export const CONTROLS: Control[] = [
  {
    name: 'payment regression',
    branch: 'bug/payment-concurrency',
    testFile: 'fixtures/controls/payment-regression.control.test.ts',
    repeat: 2,
    timeoutMs: 60_000,
    expected: ['regression_caught']
  },
  {
    name: 'lean regression',
    branch: 'bug/user-lean',
    testFile: 'fixtures/controls/profile-lean.control.test.ts',
    repeat: 2,
    timeoutMs: 60_000,
    expected: ['regression_caught']
  },
  {
    name: 'always pass',
    branch: 'bug/payment-concurrency',
    testFile: 'fixtures/controls/always-pass.control.test.ts',
    repeat: 1,
    timeoutMs: 60_000,
    expected: ['not_demonstrated_passes_both']
  },
  {
    name: 'always fail',
    branch: 'bug/payment-concurrency',
    testFile: 'fixtures/controls/always-fail.control.test.ts',
    repeat: 1,
    timeoutMs: 60_000,
    expected: ['invalid_fails_on_base']
  },
  {
    name: 'flaky random',
    branch: 'bug/payment-concurrency',
    testFile: 'fixtures/controls/flaky.control.test.ts',
    repeat: 5,
    timeoutMs: 60_000,
    expected: ['flaky']
  },
  {
    name: 'compile error',
    branch: 'bug/payment-concurrency',
    testFile: 'fixtures/controls/compile-error.control.test.ts',
    repeat: 1,
    timeoutMs: 60_000,
    expected: ['invalid_fails_on_base']
  },
  {
    name: 'infinite loop',
    branch: 'bug/payment-concurrency',
    testFile: 'fixtures/controls/timeout.control.test.ts',
    repeat: 1,
    timeoutMs: 5_000,
    expected: ['invalid_fails_on_base', 'inconclusive'],
    requireTimeout: true
  }
];

/** Reads a reference test from demo-shop for use as a runner control only. */
export async function referenceFile(name: string): Promise<string> {
  const source = `reference/regression-tests:__testpilot__/${name}`;
  const { stdout } = await execa('git', ['-C', REPO, 'show', source]);
  const dir = await mkdtemp(path.join(tmpdir(), 'testpilot-ref-'));
  const target = path.join(dir, name);
  await writeFile(target, stdout, 'utf8');
  return target;
}

/**
 * Creates a throwaway clone of demo-shop with branches that revert each bug.
 * demo-shop itself is never modified.
 */
export async function makeFixedClone(): Promise<{ dir: string; payment: string; lean: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'testpilot-fixed-'));
  await execa('git', ['clone', '--quiet', REPO, dir]);
  await symlink(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'), 'dir');

  // The clone only has remote-tracking branches; make local refs.
  await execa('git', ['-C', dir, 'branch', 'bug/payment-concurrency', 'origin/bug/payment-concurrency']);
  await execa('git', ['-C', dir, 'branch', 'bug/user-lean', 'origin/bug/user-lean']);

  for (const [name, branch, file] of [
    ['fix/payment', 'origin/bug/payment-concurrency', 'src/payments/processPayment.ts'],
    ['fix/lean', 'origin/bug/user-lean', 'src/users/userRepository.ts']
  ] as const) {
    await execa('git', ['-C', dir, 'checkout', '-q', '-B', name, branch]);
    const { stdout } = await execa('git', ['-C', dir, 'show', `main:${file}`]);
    await writeFile(path.join(dir, file), stdout, 'utf8');
    await execa('git', ['-C', dir, 'add', file]);
    await execa('git', ['-C', dir, 'commit', '-q', '-m', `fix: revert regression on ${name}`]);
  }

  return { dir, payment: 'fix/payment', lean: 'fix/lean' };
}

export function isPass(control: Control, result: VerificationResult): boolean {
  if (!control.expected.includes(result.verdict)) return false;
  if (!control.requireTimeout) return true;
  return (
    result.revisions.base.runs.some((run) => run.status === 'timeout') ||
    result.revisions.head.runs.some((run) => run.status === 'timeout')
  );
}

export function toRow(control: Control, result: VerificationResult): Row {
  return {
    control: control.name,
    expected: control.expected.join(' | '),
    actual: result.verdict,
    confidence: result.confidence,
    evidence: result.revisions.head.changedCodeEvidence,
    pass: isPass(control, result)
  };
}

export function printTable(rows: Row[]): void {
  const widths = {
    control: Math.max(8, ...rows.map((row) => row.control.length)),
    expected: Math.max(8, ...rows.map((row) => row.expected.length)),
    actual: Math.max(6, ...rows.map((row) => row.actual.length))
  };
  const header = [
    'Control'.padEnd(widths.control),
    'Expected'.padEnd(widths.expected),
    'Actual'.padEnd(widths.actual),
    'Confidence'.padEnd(10),
    'Evidence'.padEnd(26),
    'Result'
  ].join('  ');

  console.log(`\n${header}`);
  console.log('-'.repeat(header.length));
  for (const entry of rows) {
    console.log(
      [
        entry.control.padEnd(widths.control),
        entry.expected.padEnd(widths.expected),
        entry.actual.padEnd(widths.actual),
        entry.confidence.padEnd(10),
        entry.evidence.padEnd(26),
        entry.pass ? 'PASS' : 'FAIL'
      ].join('  ')
    );
  }
}
