/**
 * Base candidate checks and the informational head preview.
 */
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import { lintGeneratedTest, writeGeneratedTest } from './writeTest';

export interface CandidateCheckOptions {
  fileName: string;
  code: string;
  baseWorktreeDir: string;
  expectedFileName?: string;
}

export interface CandidateCheck {
  step: 'lint' | 'typecheck' | 'jest' | null;
  error: string;
  durationMs: number;
}

export interface HeadPreview {
  passed: boolean;
  error: string;
  durationMs: number;
}

export function clip(value: string, limit = 3_000): string {
  return value.length > limit ? `${value.slice(0, limit)}\n// ... truncated` : value;
}

async function run(
  cwd: string,
  command: string,
  args: string[],
  timeout = 60_000
): Promise<{ passed: boolean; output: string; durationMs: number }> {
  const startedAt = Date.now();
  try {
    const result = await execa(command, args, { cwd, reject: false, timeout });
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
    return {
      passed: result.exitCode === 0,
      output: clip(output),
      durationMs: Date.now() - startedAt
    };
  } catch (error) {
    return {
      passed: false,
      output: clip((error as Error).message),
      durationMs: Date.now() - startedAt
    };
  }
}

async function removeCandidate(worktreeDir: string, fileName: string): Promise<void> {
  try {
    await rm(path.join(worktreeDir, fileName), { force: true });
  } catch {
    // Best effort.
  }
}

export async function checkCandidateOnBase(
  options: CandidateCheckOptions
): Promise<CandidateCheck> {
  const startedAt = Date.now();

  const lint = lintGeneratedTest({
    fileName: options.fileName,
    expectedFileName: options.expectedFileName,
    code: options.code,
    worktreeDir: options.baseWorktreeDir
  });
  if (!lint.ok) {
    return {
      step: 'lint',
      error: lint.errors.join('\n'),
      durationMs: Date.now() - startedAt
    };
  }

  await writeGeneratedTest({
    repo: options.baseWorktreeDir,
    relativePath: options.fileName,
    source: options.code
  });

  const typecheck = await run(options.baseWorktreeDir, 'npx', ['tsc', '--noEmit']);
  if (!typecheck.passed) {
    await removeCandidate(options.baseWorktreeDir, options.fileName);
    return { step: 'typecheck', error: typecheck.output, durationMs: Date.now() - startedAt };
  }

  const jest = await run(options.baseWorktreeDir, 'npx', [
    'jest',
    '--runTestsByPath',
    options.fileName,
    '--ci',
    '--silent'
  ]);
  if (!jest.passed) {
    await removeCandidate(options.baseWorktreeDir, options.fileName);
    return { step: 'jest', error: jest.output, durationMs: Date.now() - startedAt };
  }

  return { step: null, error: '', durationMs: Date.now() - startedAt };
}

export async function previewOnHead(
  headWorktreeDir: string,
  fileName: string,
  code: string
): Promise<HeadPreview> {
  try {
    await writeGeneratedTest({ repo: headWorktreeDir, relativePath: fileName, source: code });
    const runResult = await run(
      headWorktreeDir,
      'npx',
      ['jest', '--runTestsByPath', fileName, '--ci', '--silent']
    );
    await removeCandidate(headWorktreeDir, fileName);
    return {
      passed: runResult.passed,
      error: runResult.passed ? '' : runResult.output,
      durationMs: runResult.durationMs
    };
  } catch (error) {
    return { passed: false, error: clip((error as Error).message), durationMs: 0 };
  }
}
