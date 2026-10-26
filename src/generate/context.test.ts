/**
 * Leak guard: a context pack may never carry reference-branch material.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { analyzeRepo } from '../analysis/analyze';
import { createWorktree } from '../runner/worktree';
import {
  buildContextPack,
  isForbiddenPath,
  isForbiddenText,
  MAX_CONTEXT_CHARS
} from './context';

const repoPath = path.resolve('../demo-shop');
const branches = ['bug/payment-concurrency', 'bug/user-lean'];

test('forbidden markers cover the reference answer key', () => {
  assert.equal(isForbiddenPath('__testpilot__/payment-failure.reference.test.ts'), true);
  assert.equal(isForbiddenPath('reference/regression-tests'), true);
  assert.equal(isForbiddenText('copied from reference/regression-tests'), true);
  assert.equal(isForbiddenPath('src/payments/processPayment.ts'), false);
});

for (const branch of branches) {
  test(`context pack for ${branch} leaks no answer key`, { timeout: 180_000 }, async () => {
    const report = await analyzeRepo({ repoPath, base: 'main', head: branch });
    assert.equal(report.changedFunctions.length, 1);

    const changed = report.changedFunctions[0];
    const base = await createWorktree(repoPath, 'main');
    const head = await createWorktree(repoPath, branch);

    try {
      const pack = buildContextPack(
        report,
        {
          repoPath,
          baseWorktreeDir: base.dir,
          headWorktreeDir: head.dir
        },
        {
          file: changed.file,
          qualifiedName: changed.qualifiedName,
          name: changed.name
        }
      );

      const serialized = JSON.stringify(pack);
      assert.doesNotMatch(serialized, /__testpilot__/i);
      assert.doesNotMatch(serialized, /reference/i);
      assert.doesNotMatch(serialized, /regression-tests/i);
      assert.ok(pack.characterCount <= MAX_CONTEXT_CHARS);
      assert.ok(pack.characterCount > 0);
      assert.ok(pack.function.baseBody);
      assert.ok(pack.function.headBody);
      assert.notEqual(pack.function.baseBody, pack.function.headBody);
      assert.ok(pack.styleExample);
      assert.ok(pack.exports.length > 0);
      assert.ok(pack.helpers.length > 0);
    } finally {
      await head.cleanup();
      await base.cleanup();
    }
  });
}