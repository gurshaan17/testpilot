# End-to-end verification results

Generated: 2026-10-26T17:49:18.830Z

Providers run: google. Skipped: ANTHROPIC_API_KEY, OPENAI_API_KEY.

Each run is `testpilot run` (analyze → generate → verify) with `--max-scenarios 1` and three repeats per revision.

## Runs

```text
Branch                     Run   Verdict                         Confidence  Base      Head      Head type       Existing suite
-------------------------------------------------------------------------------------------------------------------------------
bug/payment-concurrency    1     regression_caught               medium      passed    failed    assertion       15/15 passed
bug/payment-concurrency    2     regression_caught               medium      passed    failed    assertion       15/15 passed
bug/user-lean              1     regression_caught               medium      passed    failed    runtime-error   15/15 passed
bug/user-lean              2     regression_caught               medium      passed    failed    runtime-error   15/15 passed
```

`regression_caught`: 4/4 runs (4 valid generated tests).

## Worked examples

### bug/payment-concurrency (google, run 1)

**Scenario:** Failed charge prevents order from being marked as paid in repository

**Verdict:** `regression_caught` (confidence: `medium`, fixed check: `not_run`)

**Revisions:**

- base: passed
- head: failed [assertion]
- changed-code evidence: coverage-of-changed-lines
- existing suite on head: 15/15 passed

**Reasons:**

- The test passed on base and failed on head with a behavioural failure.
- Head failure type: assertion.
- The failing test exercises the changed function.

**Generated test:**

```ts
import { processPayment } from '../src/payments/processPayment';
import { chargeCustomer } from '../src/payments/gateway';
import { createOrder, getOrder, __reset } from '../src/orders/orderRepository';

jest.mock('../src/payments/gateway');

const mockedChargeCustomer = jest.mocked(chargeCustomer);

describe('failed-charge-does-not-mark-order-paid', () => {
  beforeEach(() => {
    __reset();
    mockedChargeCustomer.mockReset();
  });

  it('does not mark order as paid when customer charge fails', async () => {
    const order = createOrder({
      customerId: 'cus_1',
      total: 50,
      cardToken: 'tok_fail'
    });

    mockedChargeCustomer.mockRejectedValue(new Error('Card declined'));

    await expect(processPayment(order)).rejects.toThrow('Card declined');

    const storedOrder = getOrder(order.id);
    expect(storedOrder).toBeDefined();
    expect(storedOrder?.status).toBe('pending');
  });
});
```
### bug/user-lean (google, run 1)

**Scenario:** getPublicProfile invokes toPublicProfile on the retrieved User model

**Verdict:** `regression_caught` (confidence: `medium`, fixed check: `not_run`)

**Revisions:**

- base: passed
- head: failed [runtime-error]
- changed-code evidence: coverage-of-changed-lines
- existing suite on head: 15/15 passed

**Reasons:**

- The test passed on base and failed on head with a behavioural failure.
- Head failure type: runtime-error.
- The failing test exercises the changed function.

**Generated test:**

```ts
import { getPublicProfile } from '../src/users/userProfileService';
import { reset, seed } from '../src/users/userRepository';

describe('getPublicProfile', () => {
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

  it('retrieves the public profile using the model method', async () => {
    const profile = await getPublicProfile('usr_1');
    expect(profile).toEqual({
      id: 'usr_1',
      displayName: 'Ada Lovelace'
    });
  });
});
```
