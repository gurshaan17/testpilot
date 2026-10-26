/**
 * Unit tests for verdict classification.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { classify } from './classify';
import type { RevisionResult } from './schema';

function revision(overrides: Partial<RevisionResult> = {}): RevisionResult {
  const status = overrides.consistentStatus ?? 'passed';
  return {
    ref: 'main',
    sha: 'abc123',
    runs: [],
    consistentStatus: status,
    stable: true,
    changedCodeEvidence: 'none',
    durationMs: 10,
    ...overrides
  };
}

function base(): ClassificationInput {
  return {
    base: revision({ consistentStatus: 'passed' }),
    head: revision({ ref: 'head', consistentStatus: 'failed', failureType: 'assertion' }),
    repeat: 3,
    headFailureInChangedCode: true
  };
}

type ClassificationInput = Parameters<typeof classify>[0];

test('stable pass on base and behavioural fail on head is regression_caught', () => {
  const result = classify({
    ...base(),
    head: revision({
      ref: 'head',
      consistentStatus: 'failed',
      failureType: 'assertion',
      failureLocation: { file: 'src/payments/processPayment.ts', line: 14 }
    })
  });

  assert.equal(result.verdict, 'regression_caught');
  assert.equal(result.confidence, 'high');
  assert.equal(result.fixedCheck, 'not_run');
});

test('a compile failure on head is a suspect result', () => {
  const result = classify({
    ...base(),
    head: revision({ ref: 'head', consistentStatus: 'failed', failureType: 'compile-error' })
  });

  assert.equal(result.verdict, 'regression_caught_suspect');
  assert.equal(result.confidence, 'low');
});

test('a failure outside changed code is a suspect result', () => {
  const result = classify({ ...base(), headFailureInChangedCode: false });
  assert.equal(result.verdict, 'regression_caught_suspect');
  assert.equal(result.confidence, 'low');
});

test('passing on both revisions means the change was not demonstrated', () => {
  const result = classify({
    ...base(),
    head: revision({ ref: 'head', consistentStatus: 'passed' })
  });

  assert.equal(result.verdict, 'not_demonstrated_passes_both');
  assert.equal(result.confidence, 'high');
});

test('failing on base means the test is invalid', () => {
  const result = classify({
    ...base(),
    base: revision({ consistentStatus: 'failed', failureType: 'assertion' })
  });

  assert.equal(result.verdict, 'invalid_fails_on_base');
  assert.equal(result.confidence, 'high');
});

test('unstable results are flaky', () => {
  const result = classify({
    ...base(),
    head: revision({ ref: 'head', consistentStatus: 'mixed', stable: false })
  });

  assert.equal(result.verdict, 'flaky');
});

test('a compile error on base is an invalid test, not infrastructure', () => {
  const result = classify({
    ...base(),
    base: revision({
      consistentStatus: 'error',
      failureType: 'compile-error',
      runs: []
    })
  });

  assert.equal(result.verdict, 'invalid_fails_on_base');
});

test('a timeout on base is inconclusive', () => {
  const result = classify({
    ...base(),
    base: revision({ consistentStatus: 'timeout' })
  });

  assert.equal(result.verdict, 'inconclusive');
});

test('a fixed revision that passes confirms the regression', () => {
  const result = classify({
    ...base(),
    fixed: revision({ ref: 'fixed', consistentStatus: 'passed' }),
    head: revision({
      ref: 'head',
      consistentStatus: 'failed',
      failureType: 'assertion',
      failureLocation: { file: 'src/payments/processPayment.ts', line: 14 }
    })
  });

  assert.equal(result.verdict, 'regression_caught');
  assert.equal(result.fixedCheck, 'passed');
});

test('a fixed revision that still fails downgrades the verdict', () => {
  const result = classify({
    ...base(),
    fixed: revision({ ref: 'fixed', consistentStatus: 'failed', failureType: 'assertion' })
  });

  assert.equal(result.verdict, 'regression_caught_suspect');
  assert.equal(result.fixedCheck, 'still_failing');
});

test('confidence is never high for a suspect result', () => {
  const result = classify({
    ...base(),
    head: revision({ ref: 'head', consistentStatus: 'failed', failureType: 'timeout' })
  });
  assert.notEqual(result.confidence, 'high');
});
