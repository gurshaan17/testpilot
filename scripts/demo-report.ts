/**
 * Serve the best recorded run for a zero-live-call demo.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { importRunsFrom, listRuns, runsRoot } from '../src/store/runs';
import { startServer } from '../src/server';

const ROOT = path.resolve('.');
const ARTIFACTS = path.join(ROOT, 'demo-artifacts');

async function main(): Promise<void> {
  if (!existsSync(ARTIFACTS)) {
    console.error('demo-artifacts/ not found. Run `npm run e2e-loop` first.');
    process.exitCode = 1;
    return;
  }

  // Import into a demo-only store so repeated runs do not pile up elsewhere.
  process.env.TESTPILOT_RUNS_DIR = path.join(runsRoot(), '..', 'demo-runs');
  const runsBefore = await listRuns();
  if (runsBefore.length === 0) await importRunsFrom(ARTIFACTS);
  const runs = await listRuns();
  const best = runs.find((run) => run.repairStatus === 'fixed') ??
    runs.find((run) => run.repairStatus === 'fixed_by_revert') ?? runs[0];

  if (!best) {
    console.error('No runs available.');
    process.exitCode = 1;
    return;
  }

  const server = await startServer({ port: 4317, runsDir: process.env.TESTPILOT_RUNS_DIR });
  console.log(`TestPilot demo report: ${server.url}/runs/${best.runId}`);
  console.log('Press Ctrl-C to stop.');

  const shutdown = async (): Promise<void> => {
    await server.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
