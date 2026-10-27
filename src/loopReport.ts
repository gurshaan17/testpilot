/**
 * Terminal presentation for the loop command.
 */
import path from 'node:path';
import type { LoopResult } from './loop';
import type { VerificationResult } from './runner/schema';

function firstFailureExcerpt(verification: VerificationResult): string | undefined {
  return verification.revisions.head.runs
    .flatMap((run) => run.tests)
    .find((test) => test.failureMessages.length > 0)
    ?.failureMessages[0]
    .split('\n')
    .slice(0, 10)
    .join('\n');
}

function shortPatch(patch: string, limit = 20): string {
  const lines = patch.split('\n').filter((line) => line.startsWith('+') || line.startsWith('-') || line.startsWith('@@'));
  return lines.slice(0, limit).join('\n');
}

export function printLoopSummary(options: {
  result: LoopResult;
  log: (line: string) => void;
}): void {
  const { result, log } = options;
  const verification = result.verifications[0];
  const repair = result.repairs[0];
  const scenario = result.generation.scenarios.find((entry) => entry.status === 'valid');

  log('');
  log('='.repeat(70));
  log('TestPilot loop summary');

  if (scenario) log(`  risk:      ${scenario.title}`);
  if (verification) {
    log(
      `  evidence:  base=${verification.revisions.base.consistentStatus} ` +
        `head=${verification.revisions.head.consistentStatus} ` +
        `[${verification.revisions.head.failureType ?? 'n/a'}] -> ${verification.verdict}`
    );
    const excerpt = firstFailureExcerpt(verification);
    if (excerpt) for (const line of excerpt.split('\n')) log(`             ${line}`);
  }

  if (repair?.patch) {
    log('  fix:');
    for (const line of shortPatch(repair.patch).split('\n')) log(`             ${line}`);
  }

  if (repair) {
    const fixed = repair.attempts.find((attempt) => attempt.verification?.fixedCheck === 'passed');
    const suite = fixed?.verification?.fixedExistingSuite;
    log(`  repair:    ${repair.status} (attempts: ${repair.attempts.length})`);
    if (fixed) {
      log(
        `  proof:     test passes on the patched code; ` +
          `existing suite ${suite?.passed ?? 0}/${suite?.total ?? 0} green`
      );
    }
    if (repair.status === 'fixed_by_revert') {
      log('  flags:     fixed_by_revert (the fix reverts the change)');
    }
    if (repair.preservesPrIntent) log('  flags:     PR intent preserved');
  }

  if (result.appliedTo) {
    log(`  applied:   ${result.appliedTo.branch} in ${result.appliedTo.cloneDir} (${result.appliedTo.commit.slice(0, 8)})`);
  }

  log(`  timeline:  ${path.join(result.outDir, 'timeline.json')}`);
  log('='.repeat(70));
}
