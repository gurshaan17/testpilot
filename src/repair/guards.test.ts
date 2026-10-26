/**
 * Unit tests for patch safety guards.
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  compiles,
  extractTestLiterals,
  noHardcoding,
  noTestTampering,
  onlySourceFiles,
  parsePatchChanges,
  sizeBudget,
  testFileUnchanged
} from './guards';

const sourcePatch = `diff --git a/src/users/userRepository.ts b/src/users/userRepository.ts
--- a/src/users/userRepository.ts
+++ b/src/users/userRepository.ts
@@ -35,3 +35,3 @@
 export async function getUser(userId: string): Promise<User> {
-  return findById(userId).lean();
+  return findById(userId);
 }
`;

const testPatch = `diff --git a/__testpilot__/x.testpilot.test.ts b/__testpilot__/x.testpilot.test.ts
--- a/__testpilot__/x.testpilot.test.ts
+++ b/__testpilot__/x.testpilot.test.ts
@@ -1 +1 @@
-expect(order.status).toBe('pending');
+expect(true).toBe(true);
`;

const packagePatch = `diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -1 +1 @@
-{ "name": "demo-shop" }
+{ "name": "demo-shop", "x": 1 }
`;

const jestWorkerPatch = `diff --git a/src/users/userRepository.ts b/src/users/userRepository.ts
--- a/src/users/userRepository.ts
+++ b/src/users/userRepository.ts
@@ -35,3 +35,3 @@
 export async function getUser(userId: string): Promise<User> {
-  return findById(userId).lean();
+  if (process.env.JEST_WORKER_ID) return findById(userId);
+  return findById(userId).lean();
 }
`;

test('onlySourceFiles accepts a source-only patch', () => {
  const result = onlySourceFiles(parsePatchChanges(sourcePatch), new Set(['src/users/userRepository.ts']));
  assert.equal(result.ok, true, result.reason);
});

test('onlySourceFiles rejects test, package and missing files', () => {
  assert.equal(onlySourceFiles(parsePatchChanges(testPatch)).ok, false);
  assert.equal(onlySourceFiles(parsePatchChanges(packagePatch)).ok, false);
  assert.equal(
    onlySourceFiles(parsePatchChanges(sourcePatch), new Set(['src/other.ts'])).ok,
    false
  );
});

test('onlySourceFiles rejects added and deleted files', () => {
  const added = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1 @@
+export const x = 1;
`;
  assert.equal(onlySourceFiles(parsePatchChanges(added)).ok, false);
});

test('sizeBudget enforces 3 files and 60 lines', () => {
  assert.equal(sizeBudget(parsePatchChanges(sourcePatch)).ok, true);

  const huge = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1,70 @@
${Array.from({ length: 70 }, (_, index) => `+line${index}`).join('\n')}
`;
  assert.equal(sizeBudget(parsePatchChanges(huge)).ok, false);
});

test('noTestTampering rejects editing the test file or special-casing jest', () => {
  assert.equal(
    noTestTampering(parsePatchChanges(testPatch), '__testpilot__/x.testpilot.test.ts').ok,
    false
  );
  assert.equal(noTestTampering(parsePatchChanges(jestWorkerPatch), 'x.testpilot.test.ts').ok, false);
  assert.equal(noTestTampering(parsePatchChanges(sourcePatch), 'x.testpilot.test.ts').ok, true);
});

test('noHardcoding rejects values copied from the test', () => {
  const testSource = `
    it('returns the display name', () => {
      expect(profile).toEqual({ id: 'usr_1', displayName: 'Ada Lovelace' });
    });
  `;
  const literals = extractTestLiterals(testSource);
  assert.ok(literals.includes("Ada Lovelace"));

  const hardcoded = `diff --git a/src/users/userProfileService.ts b/src/users/userProfileService.ts
--- a/src/users/userProfileService.ts
+++ b/src/users/userProfileService.ts
@@ -1 +1,2 @@
 export async function getPublicProfile(userId: string) {
+  return { id: 'usr_1', displayName: 'Ada Lovelace' };
 }
`;
  assert.equal(noHardcoding(parsePatchChanges(hardcoded), testSource).ok, false);
  assert.equal(noHardcoding(parsePatchChanges(sourcePatch), testSource).ok, true);
});

test('testFileUnchanged compares hashes', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'guard-hash-'));
  try {
    const original = path.join(dir, 'original.test.ts');
    await writeFile(original, 'expect(1).toBe(1);\n');
    await mkdir(path.join(dir, 'fixed', '__testpilot__'), { recursive: true });
    await writeFile(path.join(dir, 'fixed/__testpilot__/x.testpilot.test.ts'), 'expect(1).toBe(1);\n');

    const same = await testFileUnchanged({
      originalPath: original,
      fixedWorktreeDir: path.join(dir, 'fixed'),
      testFile: '__testpilot__/x.testpilot.test.ts'
    });
    assert.equal(same.ok, true);

    await writeFile(path.join(dir, 'fixed/__testpilot__/x.testpilot.test.ts'), 'expect(1).toBe(2);\n');
    const changed = await testFileUnchanged({
      originalPath: original,
      fixedWorktreeDir: path.join(dir, 'fixed'),
      testFile: '__testpilot__/x.testpilot.test.ts'
    });
    assert.equal(changed.ok, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('compiles accepts valid source and rejects a type error', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'guard-tsc-'));
  try {
    await writeFile(path.join(dir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { target: 'ES2020', module: 'CommonJS', strict: true, noEmit: true },
      include: ['src/**/*.ts']
    }));
    await mkdir(path.join(dir, 'src'), { recursive: true });
    // A real tsc is required for the guard to mean anything.
    await symlink(path.resolve('node_modules'), path.join(dir, 'node_modules'), 'dir');
    await writeFile(path.join(dir, 'src/ok.ts'), 'export const value: number = 1;\n');

    const good = await compiles({ worktreeDir: dir });
    assert.equal(good.ok, true, good.reason);

    await writeFile(path.join(dir, 'src/bad.ts'), 'export const value: number = "text";\n');
    const bad = await compiles({ worktreeDir: dir });
    assert.equal(bad.ok, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
