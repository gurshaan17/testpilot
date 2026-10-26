/**
 * Unit tests for flakiness detection.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { runRepeated } from './stability';
import type { TestRunOutcome } from './runTest';

function outcome(status: 'passed' | 'failed' | 'error' | 'timeout'): TestRunOutcome {
  return {
    result: {
      status,
      tests: [],
      numPassed: status === 'passed' ? 1 : 0,
      numFailed: status === 'failed' ? 1 : 0,
      numTotal: 1,
      suiteFailedToRun: false,
      exitCode: status === 'passed' ? 0 : 1,
      outputTail: ''
    },
    isolation: 'process',
    durationMs: 5
  };
}

test('identical statuses are stable', async () => {
  const result = await runRepeated(async () => outcome('passed'), 3);
  assert.equal(result.stable, true);
  assert.equal(result.consistentStatus, 'passed');
  assert.equal(result.runs.length, 3);
});

test('differing statuses are flaky and mixed', async () => {
  let index = 0;
  const result = await runRepeated(async () => {
    index += 1;
    return outcome(index === 1 ? 'passed' : 'failed');
  }, 3);

  assert.equal(result.stable, false);
  assert.equal(result.consistentStatus, 'mixed');
});

test('a single run is trivially stable', async () => {
  const result = await runRepeated(async () => outcome('failed'), 1);
  assert.equal(result.stable, true);
  assert.equal(result.consistentStatus, 'failed');
});
