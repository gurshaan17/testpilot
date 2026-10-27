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
import { buildRepairContext } from '../repair/context';
import type { VerificationResult } from '../runner/schema';

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

/**
 * The repair prompt must obey the same answer-key rule as generation. This is
 * the repair half of the existing leak guard.
 */
test('repair context leaks no answer key', { timeout: 180_000 }, async () => {
  const report = await analyzeRepo({ repoPath, base: 'main', head: 'bug/user-lean' });
  const changed = report.changedFunctions[0];
  const base = await createWorktree(repoPath, 'main');
  const head = await createWorktree(repoPath, 'bug/user-lean');

  const verification = {
    verdict: 'regression_caught',
    reasons: ['failed on head'],
    revisions: {
      head: {
        runs: [
          {
            tests: [
              {
                title: 'x',
                fullName: 'x',
                status: 'failed',
                failureMessages: ['TypeError: user.toPublicProfile is not a function'],
                failureType: 'runtime-error',
                durationMs: 1
              }
            ],
            outputTail: ''
          }
        ],
        failureLocation: { file: 'src/users/userProfileService.ts', line: 7 }
      }
    }
  } as unknown as VerificationResult;

  try {
    const context = buildRepairContext({
      report,
      baseWorktreeDir: base.dir,
      headWorktreeDir: head.dir,
      testFile: '__testpilot__/profile.testpilot.test.ts',
      testSource: "expect(profile).toEqual({ id: 'usr_1' });",
      verification
    });

    const serialized = JSON.stringify(context);
    assert.doesNotMatch(serialized, /__testpilot__\/[\w.-]*reference/i);
    assert.doesNotMatch(serialized, /regression-tests/i);
    assert.doesNotMatch(serialized, /\breference\b/i);
    assert.ok(context.function.baseBody);
    assert.ok(context.function.headBody);
    assert.equal(changed.file, context.function.file);
  } finally {
    await head.cleanup();
    await base.cleanup();
  }
});
