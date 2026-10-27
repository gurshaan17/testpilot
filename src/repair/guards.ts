/**
 * Safety guards for proposed source fixes.
 *
 * Every proposed fix passes through these before any test runs. A repair that
 * games the test (editing the test, special-casing the test environment, or
 * hardcoding the expected values into source) is rejected.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Project, SyntaxKind } from 'ts-morph';
import { runSandboxed } from '../runner/exec';

export interface GuardResult {
  ok: boolean;
  reason: string;
}

export interface PatchChange {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  addedLines: string[];
  removedLines: string[];
}

const SOURCE_TEST_PATTERNS = [/\.test\.ts$/, /\.spec\.ts$/];
const FORBIDDEN_PATH_PATTERNS = [
  /(^|\/)package(-lock)?\.json$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /jest\.config\./,
  /tsconfig/,
  /(^|\/)scripts\//,
  /^\.github\//
];

const TRIVIAL_LITERALS = new Set(['0', '1', 'true', 'false', "''", '""', '``', '[]', '{}']);

/**
 * Parses a unified diff into per-file changes.
 */
export function parsePatchChanges(patchText: string): PatchChange[] {
  const changes: PatchChange[] = [];
  let current: PatchChange | undefined;
  let inHunk = false;

  for (const line of patchText.split('\n')) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (header) {
      current = {
        path: header[2],
        status: 'modified',
        addedLines: [],
        removedLines: []
      };
      changes.push(current);
      inHunk = false;
      continue;
    }
    if (!current) continue;

    if (line.startsWith('new file mode')) current.status = 'added';
    else if (line.startsWith('deleted file mode')) current.status = 'deleted';
    else if (line.startsWith('rename from') || line.startsWith('rename to')) {
      current.status = 'renamed';
    } else if (line.startsWith('@@')) {
      inHunk = true;
    } else if (inHunk) {
      if (line.startsWith('+')) current.addedLines.push(line.slice(1));
      else if (line.startsWith('-')) current.removedLines.push(line.slice(1));
    }
  }

  return changes;
}

/**
 * The patch may only modify existing source files under src/.
 * It must not touch tests, configs, lockfiles, scripts or CI.
 */
export function onlySourceFiles(
  changes: PatchChange[],
  existingFiles: Set<string> = new Set()
): GuardResult {
  if (changes.length === 0) {
    return { ok: false, reason: 'The patch changes no files.' };
  }

  for (const change of changes) {
    const file = change.path.split(path.sep).join('/');

    if (change.status !== 'modified') {
      return {
        ok: false,
        reason: `${file} is ${change.status}; only modifications to existing source files are allowed.`
      };
    }
    if (!file.startsWith('src/')) {
      return { ok: false, reason: `${file} is outside src/.` };
    }
    if (SOURCE_TEST_PATTERNS.some((pattern) => pattern.test(file))) {
      return { ok: false, reason: `${file} is a test file; fixes may not change tests.` };
    }
    if (file.includes('__testpilot__/')) {
      return { ok: false, reason: `${file} lives in __testpilot__/; fixes may not change it.` };
    }
    if (FORBIDDEN_PATH_PATTERNS.some((pattern) => pattern.test(file))) {
      return { ok: false, reason: `${file} is a protected project file.` };
    }
    if (existingFiles.size > 0 && !existingFiles.has(file)) {
      return { ok: false, reason: `${file} does not exist on head.` };
    }
  }

  return { ok: true, reason: 'Only existing source files under src/ are modified.' };
}

const CHEAT_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /jest\.(mock|unmock|doMock|spyOn|setMock)\b/, label: 'jest mocking' },
  { pattern: /\.\s*(skip|only)\s*\(/, label: '.skip/.only' },
  { pattern: /process\.env\.NODE_ENV/, label: 'NODE_ENV checks' },
  { pattern: /process\.env\.JEST_WORKER_ID/, label: 'JEST_WORKER_ID checks' },
  { pattern: /process\.env\.(JEST_|TEST_|CI)\b/, label: 'test environment detection' }
];

/**
 * The fix may not change the test, and may not special-case the test
 * environment in source code.
 */
export function noTestTampering(
  changes: PatchChange[],
  testFile: string
): GuardResult {
  const testName = testFile.split('/').pop() ?? testFile;

  for (const change of changes) {
    const file = change.path.split(path.sep).join('/');
    if (file === testFile || file.endsWith(`/${testName}`) || file.endsWith(testName)) {
      return { ok: false, reason: `The patch edits the test file ${file}.` };
    }
    for (const added of change.addedLines) {
      if (added.trimStart().startsWith('//')) continue;
      for (const { pattern, label } of CHEAT_PATTERNS) {
        if (pattern.test(added)) {
          return {
            ok: false,
            reason: `The patch adds ${label} to ${file}; special-casing tests is not a fix.`
          };
        }
      }
    }
  }

  return { ok: true, reason: 'The test file is untouched and no test special-casing was added.' };
}

/**
 * Confirms the test file is byte-identical in the patched worktree.
 */
export async function testFileUnchanged(options: {
  originalPath: string;
  fixedWorktreeDir: string;
  testFile: string;
}): Promise<GuardResult> {
  const relative = options.testFile.split(path.sep).join('/').replace(/^__testpilot__\//, '');
  const patchedPath = path.join(options.fixedWorktreeDir, '__testpilot__', relative);

  try {
    const [original, patched] = await Promise.all([
      readFile(options.originalPath),
      readFile(patchedPath)
    ]);
    const originalHash = createHash('sha256').update(original).digest('hex');
    const patchedHash = createHash('sha256').update(patched).digest('hex');

    return originalHash === patchedHash
      ? { ok: true, reason: 'The test file is byte-identical after patching.' }
      : { ok: false, reason: 'The test file changed while the fix was applied.' };
  } catch (error) {
    return { ok: false, reason: `Could not compare the test file: ${(error as Error).message}` };
  }
}

/**
 * At most 3 files and 60 changed lines.
 */
export function sizeBudget(changes: PatchChange[]): GuardResult {
  const files = changes.length;
  const lines = changes.reduce(
    (sum, change) => sum + change.addedLines.length + change.removedLines.length,
    0
  );

  if (files > 3) {
    return { ok: false, reason: `The fix touches ${files} files; the budget is 3.` };
  }
  if (lines > 60) {
    return { ok: false, reason: `The fix changes ${lines} lines; the budget is 60.` };
  }

  return { ok: true, reason: `The fix changes ${files} file(s) and ${lines} line(s).` };
}

/**
 * Extracts the literal values a test asserts on, so a fix cannot simply
 * hardcode the expected value into the source.
 */
export function extractTestLiterals(testSource: string): string[] {
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile('/test.ts', testSource);
  const literals = new Set<string>();

  for (const node of sourceFile.getDescendants()) {
    if (node.getKind() === SyntaxKind.StringLiteral) {
      const value = (node as unknown as { getLiteralText?: () => string }).getLiteralText?.();
      if (value) literals.add(value);
    } else if (node.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral) {
      const value = (node as unknown as { getLiteralText?: () => string }).getLiteralText?.();
      if (value) literals.add(value);
    } else if (node.getKind() === SyntaxKind.NumericLiteral) {
      const value = (node as unknown as { getLiteralText?: () => string }).getLiteralText?.();
      if (value) literals.add(value);
    }
  }

  return [...literals].filter((literal) => !TRIVIAL_LITERALS.has(literal));
}

/**
 * Rejects a fix that copies the test's expected values into source code.
 *
 * A literal that the file already contained before the fix is not new
 * hardcoding, so only newly introduced literals are rejected.
 */
export function noHardcoding(
  changes: PatchChange[],
  testSource: string,
  originalContents: Record<string, string> = {}
): GuardResult {
  const literals = extractTestLiterals(testSource);
  if (literals.length === 0) {
    return { ok: true, reason: 'The test asserts no literal values.' };
  }

  for (const change of changes) {
    const original = originalContents[change.path] ?? '';
    const fresh = literals.filter((literal) => !original.includes(literal));

    for (const added of change.addedLines) {
      const code = added.trim();
      if (!code || code.startsWith('//') || code.startsWith('*')) continue;

      for (const literal of fresh) {
        const isString = /^[A-Za-z_][\w\s.,!?'-]*$/.test(literal);
        const quoted = isString
          ? code.includes(`'${literal}'`) || code.includes(`"${literal}"`)
          : false;
        const numeric = /^\d+(\.\d+)?$/.test(literal) && new RegExp(`\\b${literal}\\b`).test(code);

        if (quoted || numeric) {
          return {
            ok: false,
            reason: `The fix hardcodes the expected value ${literal} into ${change.path}.`
          };
        }
      }
    }
  }

  return { ok: true, reason: 'The fix does not hardcode the test expectations.' };
}

/**
 * The patched code must type-check.
 */
export async function compiles(options: {
  worktreeDir: string;
  timeoutMs?: number;
}): Promise<GuardResult> {
  const run = await runSandboxed({
    cwd: options.worktreeDir,
    command: 'npx',
    args: ['tsc', '--noEmit'],
    timeoutMs: options.timeoutMs ?? 120_000
  });

  if (run.exitCode === 0) {
    return { ok: true, reason: 'The patched code type-checks.' };
  }

  const output = `${run.stdout}\n${run.stderr}`.trim();
  return {
    ok: false,
    reason: `The patched code does not compile: ${output.split('\n').slice(0, 5).join(' ')}`
  };
}
