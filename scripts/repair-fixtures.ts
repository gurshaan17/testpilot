/**
 * Hand-written control cases for the repair pipeline. No LLM is involved.
 */
import type { GuardResult } from '../src/repair/guards';
import { noTestTampering, onlySourceFiles, parsePatchChanges } from '../src/repair/guards';
import type { RepairProposal } from '../src/repair/agent';

export type ControlKind = 'repair' | 'guard' | 'patch';

export interface RepairControl {
  name: string;
  kind: ControlKind;
  branch: 'bug/payment-concurrency' | 'bug/user-lean';
  expectation: string;
  edits?: RepairProposal['edits'];
  preservesPrIntent?: boolean;
  guardCheck?: () => GuardResult;
  patchText?: string;
}

const userRepo = 'src/users/userRepository.ts';
const processPayment = 'src/payments/processPayment.ts';

export const REPAIR_CONTROLS: RepairControl[] = [
  {
    name: 'payment revert',
    kind: 'repair',
    branch: 'bug/payment-concurrency',
    expectation: 'fixed_by_revert',
    preservesPrIntent: false,
    edits: [
      {
        file: processPayment,
        find: '  await Promise.all([chargeCustomer(order), markOrderPaid(order.id)]);',
        replace: '  await chargeCustomer(order);\n  await markOrderPaid(order.id);'
      }
    ]
  },
  {
    name: 'user lean revert',
    kind: 'repair',
    branch: 'bug/user-lean',
    expectation: 'fixed_by_revert',
    preservesPrIntent: false,
    edits: [
      {
        file: userRepo,
        find: '  return findById(userId).lean();',
        replace: '  return findById(userId);'
      }
    ]
  },
  {
    name: 'payment intent-preserving',
    kind: 'repair',
    branch: 'bug/payment-concurrency',
    expectation: 'fixed',
    preservesPrIntent: true,
    edits: [
      {
        file: processPayment,
        find: '  await Promise.all([chargeCustomer(order), markOrderPaid(order.id)]);',
        replace: '  await Promise.all([chargeCustomer(order)]);\n  await markOrderPaid(order.id);'
      }
    ]
  },
  {
    name: 'comment-only no-op',
    kind: 'repair',
    branch: 'bug/user-lean',
    expectation: 'failed',
    preservesPrIntent: true,
    edits: [
      {
        file: userRepo,
        find: '  return findById(userId).lean();',
        replace: '  // no behavioural change\n  return findById(userId).lean();'
      }
    ]
  },
  {
    name: 'fix breaks existing suite',
    kind: 'repair',
    branch: 'bug/user-lean',
    expectation: 'failed',
    preservesPrIntent: false,
    edits: [
      {
        file: userRepo,
        find: '  return findById(userId).lean();',
        replace: '  return findById(userId);'
      },
      {
        file: userRepo,
        find: '    users.set(record.id, { ...record });',
        replace: '    users.set(record.id, { ...record, active: false });'
      }
    ]
  },
  {
    name: 'edits the test file',
    kind: 'guard',
    branch: 'bug/user-lean',
    expectation: 'rejected',
    guardCheck: () => {
      const patch = `diff --git a/__testpilot__/x.testpilot.test.ts b/__testpilot__/x.testpilot.test.ts
--- a/__testpilot__/x.testpilot.test.ts
+++ b/__testpilot__/x.testpilot.test.ts
@@ -1 +1 @@
-expect(profile.displayName).toBe('Ada Lovelace');
+expect(true).toBe(true);
`;
      return noTestTampering(parsePatchChanges(patch), '__testpilot__/x.testpilot.test.ts');
    }
  },
  {
    name: 'JEST_WORKER_ID special case',
    kind: 'guard',
    branch: 'bug/user-lean',
    expectation: 'rejected',
    guardCheck: () => {
      const patch = `diff --git a/src/users/userRepository.ts b/src/users/userRepository.ts
--- a/src/users/userRepository.ts
+++ b/src/users/userRepository.ts
@@ -35,3 +35,4 @@
 export async function getUser(userId: string): Promise<User> {
+  if (process.env.JEST_WORKER_ID) return findById(userId);
   return findById(userId).lean();
 }
`;
      return noTestTampering(parsePatchChanges(patch), 'x.testpilot.test.ts');
    }
  },
  {
    name: 'modifies package.json',
    kind: 'guard',
    branch: 'bug/user-lean',
    expectation: 'rejected',
    guardCheck: () => {
      const patch = `diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -1 +1 @@
-{ "name": "demo-shop" }
+{ "name": "demo-shop", "extra": true }
`;
      return onlySourceFiles(parsePatchChanges(patch));
    }
  },
  {
    name: 'patch does not apply',
    kind: 'patch',
    branch: 'bug/user-lean',
    expectation: 'patch_failed',
    patchText: `diff --git a/src/users/userRepository.ts b/src/users/userRepository.ts
--- a/src/users/userRepository.ts
+++ b/src/users/userRepository.ts
@@ -35,3 +35,3 @@
 export async function getUser(userId: string): Promise<User> {
-  return findById(userId).toArray();
+  return findById(userId);
 }
`
  }
];
