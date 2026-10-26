/**
 * Exercises base validation and head preview with deterministic candidates.
 * This does not call an LLM; it proves the validation loop wiring.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createWorktree } from '../runner/worktree';
import { checkCandidateOnBase } from './validateCandidate';
import { previewOnHead } from './validateCandidate';

const repoPath = path.resolve('../demo-shop');

const paymentTest = `
import { __reset, createOrder, getOrder } from '../src/orders/orderRepository';
import { processPayment } from '../src/payments/processPayment';

describe('declined payment state', () => {
  beforeEach(() => {
    __reset();
  });

  it('leaves the order pending when the gateway declines', async () => {
    const order = createOrder({ customerId: 'cus_1', total: 10, cardToken: 'tok_declined' });

    await expect(processPayment(order)).rejects.toThrow('Payment declined');
    expect(getOrder(order.id)?.status).toBe('pending');
  });
});
`;

const profileTest = `
import { reset, seed } from '../src/users/userRepository';
import { getPublicProfile } from '../src/users/userProfileService';

describe('public profile', () => {
  beforeEach(() => {
    reset();
    seed([
      {
        id: 'usr_1',
        email: 'ada@example.com',
        name: 'Ada Lovelace',
        passwordHash: 'correct-horse',
        active: true
      }
    ]);
  });

  it('returns the public display name', async () => {
    await expect(getPublicProfile('usr_1')).resolves.toEqual({
      id: 'usr_1',
      displayName: 'Ada Lovelace'
    });
  });
});
`;

test('candidate validation catches a broken base test', { timeout: 180_000 }, async () => {
  const base = await createWorktree(repoPath, 'main');
  try {
    const check = await checkCandidateOnBase({
      fileName: '__testpilot__/broken.testpilot.test.ts',
      code: paymentTest.replace("expect(getOrder(order.id)?.status).toBe('pending')", 'expect(true).toBe(true)'),
      baseWorktreeDir: base.dir
    });
    assert.equal(check.step, 'lint');
  } finally {
    await base.cleanup();
  }
});

test(
  'payment candidate passes base and fails head preview',
  { timeout: 180_000 },
  async () => {
    const base = await createWorktree(repoPath, 'main');
    const head = await createWorktree(repoPath, 'bug/payment-concurrency');
    const fileName = '__testpilot__/declined-charge.testpilot.test.ts';

    try {
      const check = await checkCandidateOnBase({
        fileName,
        code: paymentTest,
        baseWorktreeDir: base.dir
      });
      assert.equal(check.step, null, check.error);

      const preview = await previewOnHead(head.dir, fileName, paymentTest);
      assert.equal(preview.passed, false);
    } finally {
      await head.cleanup();
      await base.cleanup();
    }
  }
);

test(
  'lean candidate passes base and fails head preview',
  { timeout: 180_000 },
  async () => {
    const base = await createWorktree(repoPath, 'main');
    const head = await createWorktree(repoPath, 'bug/user-lean');
    const fileName = '__testpilot__/public-profile.testpilot.test.ts';

    try {
      const check = await checkCandidateOnBase({
        fileName,
        code: profileTest,
        baseWorktreeDir: base.dir
      });
      assert.equal(check.step, null, check.error);

      const preview = await previewOnHead(head.dir, fileName, profileTest);
      assert.equal(preview.passed, false);
    } finally {
      await head.cleanup();
      await base.cleanup();
    }
  }
);
