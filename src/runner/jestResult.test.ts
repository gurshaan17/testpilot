/**
 * Unit tests for Jest output parsing and failure classification.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyFailure,
  findFailureLocation,
  parseJestResult,
  type JestJsonShape
} from './jestResult';

const assertionMessage = `expect(received).toBe(expected) // deep equality

Expected: "pending"
Received: "paid"
    at Object.<anonymous> (/work/tree/__testpilot__/x.testpilot.test.ts:18:30)
    at processPayment (/work/tree/src/payments/processPayment.ts:14:20)`;

const runtimeErrorMessage = `TypeError: user.toPublicProfile is not a function
    at getPublicProfile (/work/tree/src/users/userProfileService.ts:6:34)
    at Object.<anonymous> (/work/tree/__testpilot__/y.testpilot.test.ts:20:18)`;

const compileErrorMessage = `● Test suite failed to run.

    src/users/userRepository.ts:35:18 - error TS2345: Argument of type 'number' is not assignable to parameter of type 'string'.
      35 |   const id: number = 1;
         |                  ~
    at Object.<anonymous> (/work/tree/src/users/userRepository.ts:35:18)`;

const timeoutMessage = `Exceeded timeout of 5000 ms for a test.
Add a timeout value to this test to increase the timeout, if this is a long-running test.`;

/** Builds a Jest JSON payload with one failing test. */
function jestJsonWithFailure(message: string, suiteFailed = false): JestJsonShape {
  return {
    numPassedTests: 0,
    numFailedTests: 1,
    numTotalTests: 1,
    testResults: [
      {
        name: '/work/tree/__testpilot__/x.testpilot.test.ts',
        status: 'failed',
        message: suiteFailed ? message : '',
        assertionResults: suiteFailed
          ? []
          : [
              {
                title: 'does something',
                fullName: 'describe does something',
                status: 'failed',
                failureMessages: [message],
                duration: 12
              }
            ]
      }
    ]
  };
}

test('classifyFailure separates assertion, runtime, compile and timeout', () => {
  assert.equal(classifyFailure(assertionMessage), 'assertion');
  assert.equal(classifyFailure(runtimeErrorMessage), 'runtime-error');
  assert.equal(classifyFailure(compileErrorMessage), 'compile-error');
  assert.equal(classifyFailure(timeoutMessage), 'timeout');
});

test('a compile error is not mistaken for a runtime error', () => {
  assert.notEqual(classifyFailure(compileErrorMessage), 'runtime-error');
  assert.notEqual(classifyFailure(assertionMessage), 'compile-error');
});

test('parseJestResult reports a failed assertion with its location', () => {
  const result = parseJestResult({
    stdout: '',
    stderr: '',
    exitCode: 1,
    timedOut: false,
    jestJson: jestJsonWithFailure(assertionMessage),
    changedFiles: ['src/payments/processPayment.ts']
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.numFailed, 1);
  assert.equal(result.tests[0].failureType, 'assertion');
  assert.equal(result.failureLocation?.file, 'src/payments/processPayment.ts');
  assert.equal(result.failureLocation?.line, 14);
});

test('parseJestResult reports a suite that failed to run as a compile error', () => {
  const result = parseJestResult({
    stdout: '',
    stderr: '',
    exitCode: 1,
    timedOut: false,
    jestJson: jestJsonWithFailure(compileErrorMessage, true),
    changedFiles: ['src/users/userRepository.ts']
  });

  assert.equal(result.suiteFailedToRun, true);
  assert.equal(result.tests[0].failureType, 'compile-error');
  assert.equal(result.failureLocation?.file, 'src/users/userRepository.ts');
});

test('parseJestResult reports a timeout', () => {
  const result = parseJestResult({
    stdout: '',
    stderr: '',
    exitCode: null,
    timedOut: true,
    jestJson: undefined
  });

  assert.equal(result.status, 'timeout');
});

test('parseJestResult reports a missing jest json as an error', () => {
  const result = parseJestResult({
    stdout: 'something exploded',
    stderr: '',
    exitCode: 1,
    timedOut: false,
    jestJson: undefined
  });

  assert.equal(result.status, 'error');
  assert.match(result.outputTail, /something exploded/);
});

test('parseJestResult reports a passing suite', () => {
  const result = parseJestResult({
    stdout: '',
    stderr: '',
    exitCode: 0,
    timedOut: false,
    jestJson: {
      numPassedTests: 2,
      numFailedTests: 0,
      numTotalTests: 2,
      testResults: [
        {
          name: '/work/tree/__testpilot__/x.testpilot.test.ts',
          status: 'passed',
          assertionResults: [
            { title: 'a', fullName: 'a', status: 'passed', failureMessages: [], duration: 3 },
            { title: 'b', fullName: 'b', status: 'passed', failureMessages: [], duration: 4 }
          ]
        }
      ]
    }
  });

  assert.equal(result.status, 'passed');
  assert.equal(result.numPassed, 2);
  assert.equal(result.numFailed, 0);
});

test('findFailureLocation ignores frames outside changed files', () => {
  const location = findFailureLocation(
    ['at helper (/work/tree/src/other/thing.ts:3:3)'],
    ['src/payments/processPayment.ts']
  );
  assert.equal(location, undefined);
});
