/**
 * Parses Jest's JSON output into a typed result and classifies failures.
 * Verdicts are derived only from the runner's output, never from an LLM.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export type TestStatus = 'passed' | 'failed' | 'error' | 'timeout';
export type FailureType = 'assertion' | 'runtime-error' | 'compile-error' | 'timeout';

export interface TestCaseResult {
  title: string;
  fullName: string;
  status: 'passed' | 'failed';
  failureMessages: string[];
  failureType?: FailureType;
  durationMs: number;
}

export interface JestRunResult {
  status: TestStatus;
  tests: TestCaseResult[];
  numPassed: number;
  numFailed: number;
  numTotal: number;
  suiteFailedToRun: boolean;
  exitCode: number | null;
  outputTail: string;
  failureLocation?: FailureLocation;
  error?: string;
}

export interface FailureLocation {
  file: string;
  line: number;
  column?: number;
  snippet?: string;
}

export interface JestJsonShape {
  numPassedTests?: number;
  numFailedTests?: number;
  numTotalTests?: number;
  testResults?: {
    name?: string;
    status?: string;
    message?: string;
    assertionResults?: {
      title?: string;
      fullName?: string;
      status?: string;
      failureMessages?: string[];
      duration?: number;
    }[];
  }[];
}

const ASSERTION_PATTERNS = [
  /expect\(/,
  /toBe\(/,
  /toEqual\(/,
  /toStrictEqual\(/,
  /toMatch\(/,
  /toContain\(/,
  /toThrow\(/,
  /toBeDefined\(/,
  /toBeTruthy\(/,
  /toBeFalsy\(/,
  /toHaveLength\(/,
  /toHaveProperty\(/,
  /Received:.*\n\s*Expected:/s,
  /Expected:.*\n\s*Received:/s
];

const RUNTIME_ERROR_PATTERNS = [
  /TypeError/,
  /ReferenceError/,
  /RangeError/,
  /SyntaxError/,
  /Error:/,
  /is not a function/,
  /Cannot read propert(?:y|ies)/,
  /Cannot call a class as a function/,
  /undefined is not/
];

const TIMEOUT_PATTERNS = [
  /Exceeded timeout of \d+ ?ms/i,
  /Timeout - Async callback was not invoked within/,
  /thrown: "Exceeded timeout/,
  /test timed out/i
];

const COMPILE_ERROR_PATTERNS = [
  /TS\d{4}/,
  /ts-jest/,
  /Cannot find name/,
  /Cannot find module/,
  /has no exported member/,
  /Type .* is not assignable/,
  /error TS\d+/,
  /Unable to compile/,
  /ts-jest\[config\]/
];

/**
 * Single place that decides why a test failed.
 * Order matters: timeouts are checked first, then compile errors (a compile
 * error also mentions "Error"), then assertions, then runtime errors.
 */
export function classifyFailure(message: string): FailureType {
  const text = message ?? '';

  if (TIMEOUT_PATTERNS.some((pattern) => pattern.test(text))) return 'timeout';
  if (COMPILE_ERROR_PATTERNS.some((pattern) => pattern.test(text))) return 'compile-error';
  if (ASSERTION_PATTERNS.some((pattern) => pattern.test(text))) return 'assertion';
  if (RUNTIME_ERROR_PATTERNS.some((pattern) => pattern.test(text))) return 'runtime-error';
  return 'runtime-error';
}

const STACK_FRAME = /at\s+(?:[^\s(]+\s+)?\(?([^\s():]+\.[tj]sx?):(\d+):(\d+)\)?/g;

interface StackFrame {
  file: string;
  line: number;
  column: number;
}

/**
 * Extracts stack frames from a failure message, skipping node internals and
 * the test file itself.
 */
export function extractStackFrames(messages: string[]): StackFrame[] {
  const frames: StackFrame[] = [];

  for (const message of messages) {
    STACK_FRAME.lastIndex = 0;
    let match = STACK_FRAME.exec(message);
    while (match) {
      const file = match[1];
      const line = Number(match[2]);
      const column = Number(match[3]);
      if (!file.includes('node_modules') && !file.startsWith('node:')) {
        frames.push({ file, line, column });
      }
      match = STACK_FRAME.exec(message);
    }
  }

  return frames;
}

function normalizeFile(file: string): string {
  return file.split(path.sep).join('/');
}

/**
 * Finds the first stack frame that lands inside a changed source file.
 * This is the evidence that a failure happened in the code under review.
 */
export function findFailureLocation(
  messages: string[],
  changedFiles: string[]
): FailureLocation | undefined {
  const changed = new Set(changedFiles.map(normalizeFile));

  for (const frame of extractStackFrames(messages)) {
    const file = normalizeFile(frame.file);
    const relative = file.includes('/src/') ? file.slice(file.indexOf('/src/') + 1) : file;
    if (changed.has(relative) || changed.has(file)) {
      return { file: relative, line: frame.line, column: frame.column };
    }
  }

  return undefined;
}

function outputTail(stdout: string, stderr: string, limit = 3_000): string {
  const combined = `${stdout}\n${stderr}`.trim();
  return combined.length > limit ? combined.slice(-limit) : combined;
}

export async function readJestJson(resultPath: string): Promise<JestJsonShape | undefined> {
  try {
    return JSON.parse(await readFile(resultPath, 'utf8')) as JestJsonShape;
  } catch {
    return undefined;
  }
}

export interface ParseJestOptions {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  jestJson?: JestJsonShape;
  changedFiles?: string[];
}

export function parseJestResult(options: ParseJestOptions): JestRunResult {
  const changedFiles = options.changedFiles ?? [];
  const tail = outputTail(options.stdout, options.stderr);

  if (options.timedOut) {
    return {
      status: 'timeout',
      tests: [],
      numPassed: 0,
      numFailed: 0,
      numTotal: 0,
      suiteFailedToRun: false,
      exitCode: options.exitCode,
      outputTail: tail
    };
  }

  const json = options.jestJson;

  if (!json) {
    return {
      status: 'error',
      tests: [],
      numPassed: 0,
      numFailed: 0,
      numTotal: 0,
      suiteFailedToRun: true,
      exitCode: options.exitCode,
      outputTail: tail,
      error: tail.split('\n').slice(0, 5).join('\n') || 'no jest output'
    };
  }

  const tests: TestCaseResult[] = [];
  let suiteFailedToRun = false;

  for (const suite of json.testResults ?? []) {
    const suiteFailed = suite.status === 'failed' && (suite.assertionResults ?? []).length === 0;
    if (suiteFailed) suiteFailedToRun = true;

    for (const assertion of suite.assertionResults ?? []) {
      const failureMessages = assertion.failureMessages ?? [];
      const status = assertion.status === 'passed' ? 'passed' : 'failed';
      const test: TestCaseResult = {
        title: assertion.title ?? '',
        fullName: assertion.fullName ?? assertion.title ?? '',
        status,
        failureMessages,
        durationMs: assertion.duration ?? 0
      };
      if (status === 'failed') {
        test.failureType = classifyFailure(failureMessages.join('\n'));
      }
      tests.push(test);
    }

    if (suiteFailed && suite.message) {
      const failureType = classifyFailure(suite.message);
      const location = findFailureLocation([suite.message], changedFiles);
      const test: TestCaseResult = {
        title: (suite.name ?? 'suite').split('/').pop() ?? 'suite',
        fullName: suite.name ?? 'suite',
        status: 'failed',
        failureMessages: [suite.message],
        failureType,
        durationMs: 0
      };
      tests.push(test);
      if (location) {
        return {
          status: 'failed',
          tests,
          numPassed: json.numPassedTests ?? 0,
          numFailed: json.numFailedTests ?? tests.length,
          numTotal: json.numTotalTests ?? tests.length,
          suiteFailedToRun: true,
          exitCode: options.exitCode,
          outputTail: tail,
          failureLocation: location
        };
      }
    }
  }

  const numPassed = json.numPassedTests ?? tests.filter((test) => test.status === 'passed').length;
  const numFailed = json.numFailedTests ?? tests.filter((test) => test.status === 'failed').length;

  const failedTest = tests.find((test) => test.status === 'failed');
  const location = failedTest
    ? findFailureLocation(failedTest.failureMessages, changedFiles)
    : undefined;

  const status: TestStatus =
    numFailed > 0 ? 'failed' : suiteFailedToRun ? 'error' : numPassed > 0 ? 'passed' : 'error';

  return {
    status,
    tests,
    numPassed,
    numFailed,
    numTotal: json.numTotalTests ?? numPassed + numFailed,
    suiteFailedToRun,
    exitCode: options.exitCode,
    outputTail: tail,
    ...(location ? { failureLocation: location } : {})
  };
}
