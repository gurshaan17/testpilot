/**
 * Flakiness detection: runs a test repeatedly in fresh jest processes.
 * If the statuses disagree the revision is flaky and nothing else is trusted.
 */
import type { TestRunOutcome } from './runTest';

export interface StabilityResult {
  runs: TestRunOutcome[];
  stable: boolean;
  consistentStatus: 'passed' | 'failed' | 'error' | 'timeout' | 'mixed';
}

export type TestRunner = () => Promise<TestRunOutcome>;

export async function runRepeated(runTest: TestRunner, n: number): Promise<StabilityResult> {
  const total = Math.max(1, n);
  const runs: TestRunOutcome[] = [];

  for (let index = 0; index < total; index += 1) {
    runs.push(await runTest());
  }

  const statuses = runs.map((run) => run.result.status);
  const unique = new Set(statuses);
  const stable = unique.size === 1;
  const consistentStatus = stable ? (statuses[0] as StabilityResult['consistentStatus']) : 'mixed';

  return { runs, stable, consistentStatus };
}
