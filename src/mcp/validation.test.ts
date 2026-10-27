import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { validateRef, validateRepoPath, truncate } from './validation';

const repo = path.resolve('../demo-shop');

test('repo paths outside the allowlist are rejected', async () => {
  await assert.rejects(() => validateRepoPath('/etc', [repo]), /outside the allowlist/);
  await assert.rejects(() => validateRepoPath('/tmp', [repo]), /outside the allowlist/);
  assert.equal(await validateRepoPath(repo, [repo]), repo);
});

test('symlink escapes are rejected', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mcp-allow-'));
  try {
    const link = path.join(dir, 'escape');
    await symlink('/etc', link, 'dir');
    await assert.rejects(() => validateRepoPath(link, [repo]), /outside the allowlist/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('git option injection is rejected', () => {
  for (const bad of ['--upload-pack=x', '-c', '--exec=rm', 'a b', 'ref;rm', '', '-']) {
    assert.throws(() => validateRef(bad), /Invalid ref/, bad);
  }
  for (const good of ['main', 'bug/user-lean', 'v1.2.3', 'origin/main', 'abc123']) {
    assert.equal(validateRef(good), good);
  }
});

test('truncate caps output and adds a note', () => {
  assert.equal(truncate('hello', 100), 'hello');
  const long = truncate('x'.repeat(200), 50);
  assert.match(long, /truncated/);
  assert.ok(long.length < 200);
});
