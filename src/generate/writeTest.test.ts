import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { lintGeneratedTest, writeGeneratedTest } from './writeTest';

const worktreeDir = path.resolve('../demo-shop');
const fileName = '__testpilot__/order-creation.testpilot.test.ts';
const goodCode = `
import { __reset, createOrder, getOrder } from '../src/orders/orderRepository';

describe('order creation', () => {
  beforeEach(() => {
    __reset();
  });

  it('creates a pending order', () => {
    const order = createOrder({ customerId: 'cus_1', total: 10, cardToken: 'tok_ok' });
    expect(getOrder(order.id)?.status).toBe('pending');
  });
});
`;

test('accepts a valid generated test', () => {
  const result = lintGeneratedTest({ fileName, code: goodCode, worktreeDir });
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test('rejects skip/only, expect(true), missing expect and bad imports', () => {
  const bad = [
    goodCode.replace("it('creates", "it.skip('creates"),
    goodCode.replace('expect(getOrder(order.id)?.status).toBe', 'expect(true).toBe'),
    goodCode.replace('expect(getOrder(order.id)?.status).toBe', 'void (getOrder(order.id)?.status); //'),
    goodCode.replace('../src/orders/orderRepository', '../src/orders/missing')
  ];

  for (const code of bad) {
    const result = lintGeneratedTest({ fileName, code, worktreeDir });
    assert.equal(result.ok, false, code);
    assert.ok(result.errors.length > 0);
  }
});

test('rejects an unexpected filename and answer-key references', () => {
  assert.equal(
    lintGeneratedTest({ fileName: 'src/x.test.ts', code: goodCode, worktreeDir }).ok,
    false
  );
  const withWrongName = lintGeneratedTest({
    fileName,
    expectedFileName: '__testpilot__/different.testpilot.test.ts',
    code: goodCode,
    worktreeDir
  });
  assert.equal(withWrongName.ok, false);
  assert.equal(
    lintGeneratedTest({
      fileName,
      code: `${goodCode}\n// see reference/regression-tests`,
      worktreeDir
    }).ok,
    false
  );
});

test('writer refuses paths outside __testpilot__/', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'testpilot-write-'));
  try {
    await assert.rejects(
      writeGeneratedTest({ repo: dir, relativePath: 'src/leak.ts', source: 'x' }),
      /Refusing to write/
    );
    await writeGeneratedTest({ repo: dir, relativePath: fileName, source: goodCode });
    assert.equal(await readFile(path.join(dir, fileName), 'utf8'), goodCode);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
