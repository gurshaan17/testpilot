/**
 * Unit tests for applying patches to detached worktrees.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execa } from 'execa';
import { createPatchedWorktree } from './patch';

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'testpilot-patch-repo-'));
  await execa('git', ['init', '-q', '-b', 'main', dir]);
  await execa('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
  await execa('git', ['-C', dir, 'config', 'user.name', 'Test']);
  await writeFile(path.join(dir, 'package.json'), '{ "name": "fixture" }\n');
  await execa('git', ['-C', dir, 'add', '.']);
  await execa('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  await execa('mkdir', ['-p', path.join(dir, 'src')]);
  await writeFile(
    path.join(dir, 'src/math.ts'),
    'export function add(a: number, b: number): number {\n  return a - b;\n}\n'
  );
  await execa('git', ['-C', dir, 'add', '.']);
  await execa('git', ['-C', dir, 'commit', '-q', '-m', 'add math']);
  return dir;
}

async function patchFor(repo: string): Promise<string> {
  const file = path.join(repo, 'src/math.ts');
  await writeFile(file, 'export function add(a: number, b: number): number {\n  return a + b;\n}\n');
  const { stdout } = await execa('git', ['-C', repo, 'diff']);
  await execa('git', ['-C', repo, 'checkout', '--', '.']);
  return stdout;
}

test('a clean patch applies to a detached worktree', async () => {
  const repo = await makeRepo();
  try {
    const patch = await patchFor(repo);
    const result = await createPatchedWorktree({ repoPath: repo, headRef: 'main', patchText: patch });
    assert.equal(result.ok, true);
    if (!result.ok) return;

    try {
      assert.equal(result.patchStats.filesChanged, 1);
      assert.equal(result.patchStats.insertions, 1);
      assert.equal(result.patchStats.deletions, 1);
      const content = await readFile(path.join(result.dir, 'src/math.ts'), 'utf8');
      assert.match(content, /return a \+ b;/);
    } finally {
      await result.cleanup();
    }
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('a conflicting patch is rejected without throwing', async () => {
  const repo = await makeRepo();
  try {
    const patch = (await patchFor(repo)).replace('return a - b;', 'return a * b;');
    const result = await createPatchedWorktree({ repoPath: repo, headRef: 'main', patchText: patch });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, 'patch_failed');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('a patch touching a nonexistent file is rejected', async () => {
  const repo = await makeRepo();
  try {
    const patch = `diff --git a/src/missing.ts b/src/missing.ts
--- a/src/missing.ts
+++ b/src/missing.ts
@@ -1 +1 @@
-export const value = 1;
+export const value = 2;
`;
    const result = await createPatchedWorktree({ repoPath: repo, headRef: 'main', patchText: patch });
    assert.equal(result.ok, false);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
