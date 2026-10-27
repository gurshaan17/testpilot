# Loop results

Generated: 2026-10-27T04:26:11.735Z

Providers run: google. Skipped: ANTHROPIC_API_KEY, OPENAI_API_KEY.

Each run is `testpilot loop` with `--max-scenarios 1`, two repair attempts and two repeats.

```text
Branch                     Run   Verdict               Repair             Attempts   Tokens    Total ms
-------------------------------------------------------------------------------------------------------
bug/payment-concurrency    1     regression_caught     fixed_by_revert    1          15684     76952
bug/payment-concurrency    2     regression_caught     fixed_by_revert    1          22249     134177
bug/user-lean              1     regression_caught     fixed_by_revert    1          13737     100179
bug/user-lean              2     regression_caught     fixed_by_revert    1          13015     91009
```

caught 4/4, fixed 0, fixed_by_revert 4, avg attempts 1.0, tokens 64685.

## Worked examples

### bug/payment-concurrency (google, run 1)

**Scenario:** Failed customer charge leaves order unpaid

**Risk:** Orders will be marked as paid in the store even when the payment gateway fails or rejects the transaction, leading to order fulfillment without payment.

**Generated test:**

```ts
import { processPayment } from '../src/payments/processPayment';
import { chargeCustomer } from '../src/payments/gateway';
import { createOrder, getOrder, __reset } from '../src/orders/orderRepository';

jest.mock('../src/payments/gateway');

const mockedChargeCustomer = jest.mocked(chargeCustomer);

describe('processPayment - declined charge', () => {
  beforeEach(() => {
    __reset();
    mockedChargeCustomer.mockReset();
  });

  it('does not mark order as paid when customer charge fails', async () => {
    mockedChargeCustomer.mockRejectedValue(new Error('Card declined'));

    const order = createOrder({
      customerId: 'cus_1',
      total: 50,
      cardToken: 'tok_declined'
    });

    await expect(processPayment(order)).rejects.toThrow('Card declined');

    const storedOrder = getOrder(order.id);
    expect(storedOrder).toBeDefined();
    expect(storedOrder?.status).toBe('pending');
    expect(storedOrder?.status).not.toBe('paid');
  });
});
```

**Head failure excerpt:**

```text
Error: expect(received).toBe(expected) // Object.is equality

Expected: "pending"
Received: "paid"
    at Object.<anonymous> (/private/var/folders/pd/jcpcswfj3q14p97hv27t7kbm0000gn/T/testpilot-wt-DSEwYt/__testpilot__/declined-charge-does-not-mark-order-paid.testpilot.test.ts:28:33)
    at processTicksAndRejections (node:internal/process/task_queues:104:5)
```

**Proposed fix:**

```diff
diff --git a/src/payments/processPayment.ts b/src/payments/processPayment.ts
index 4e93ef6..d5e1a48 100644
--- a/src/payments/processPayment.ts
+++ b/src/payments/processPayment.ts
@@ -10,7 +10,8 @@ export interface PaymentResult {
  * Charges the customer first and only then records the order as paid.
  */
 export async function processPayment(order: Order): Promise<PaymentResult> {
-  await Promise.all([chargeCustomer(order), markOrderPaid(order.id)]);
+  await chargeCustomer(order);
+  await markOrderPaid(order.id);
 
   return { orderId: order.id, status: 'paid' };
 }
```

**Final verification:**

- verdict: `regression_caught` (medium)
- repair: `fixed_by_revert` (restoresBase=true, preservesPrIntent=false)
- test passes on the patched code; existing suite 15/15 green

### bug/user-lean (google, run 1)

**Scenario:** getPublicProfile retrieves public profile via user model method

**Risk:** Calling lean() returns a plain JavaScript object without model instance methods, causing callers relying on prototype methods to throw runtime errors.

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

  it('retrieves the public profile via the user model instance method', async () => {
    const profile = await getPublicProfile('usr_1');
    expect(profile).toEqual({
      id: 'usr_1',
      displayName: 'Ada Lovelace'
    });
  });
});
```

**Head failure excerpt:**

```text
TypeError: user.toPublicProfile is not a function
    at getPublicProfile (/private/var/folders/pd/jcpcswfj3q14p97hv27t7kbm0000gn/T/testpilot-wt-Kwnr4x/src/users/userProfileService.ts:7:15)
    at processTicksAndRejections (node:internal/process/task_queues:104:5)
    at Object.<anonymous> (/private/var/folders/pd/jcpcswfj3q14p97hv27t7kbm0000gn/T/testpilot-wt-Kwnr4x/__testpilot__/get-public-profile-calls-model-method.testpilot.test.ts:19:21)
```

**Proposed fix:**

```diff
diff --git a/src/users/userRepository.ts b/src/users/userRepository.ts
index 2420089..9767e19 100644
--- a/src/users/userRepository.ts
+++ b/src/users/userRepository.ts
@@ -33,7 +33,7 @@ function findById(id: string): Query<User> {
 }
 
 export async function getUser(userId: string): Promise<User> {
-  return findById(userId).lean();
+  return findById(userId);
 }
 
 export function seed(records: UserRecord[]): void {
```

**Final verification:**

- verdict: `regression_caught` (medium)
- repair: `fixed_by_revert` (restoresBase=true, preservesPrIntent=false)
- test passes on the patched code; existing suite 15/15 green

## Improvement rounds

Round 1: initial repair prompt. See the table above for current numbers; no prompt changes were needed to reach the caught rate.
