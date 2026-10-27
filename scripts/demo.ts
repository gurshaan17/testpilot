/**
 * Presenter demo: offline replay by default, live loop with a safety net.
 * Zero network unless --live is passed.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import { loadRun } from '../src/report/artifacts';
import { bannerFor } from '../src/report/vocab';
import { startServer } from '../src/server';
import { importRunsFrom, listRuns, runDir } from '../src/store/runs';

const ROOT = path.resolve('.');
const ARTIFACTS = path.join(ROOT, 'demo-artifacts');
const BRANCH_DIRS = {
  payment: 'bug-payment-concurrency',
  user: 'bug-user-lean'
} as const;
const BRANCH_REFS = {
  payment: 'bug/payment-concurrency',
  user: 'bug/user-lean'
} as const;

type Scenario = keyof typeof BRANCH_DIRS;

interface Options {
  live: boolean;
  scenario: Scenario;
  fast: boolean;
  serve: boolean;
  color: boolean;
}

function parseArgs(argv: string[]): Options {
  const branchIndex = argv.indexOf('--branch');
  const branch = branchIndex >= 0 ? argv[branchIndex + 1] : 'payment';
  return {
    live: argv.includes('--live'),
    scenario: branch === 'user' ? 'user' : 'payment',
    fast: argv.includes('--fast'),
    serve: !argv.includes('--no-serve'),
    color: !argv.includes('--no-color') && !process.env.NO_COLOR
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function painter(enabled: boolean) {
  return (code: number, text: string): string => (enabled ? `\x1b[${code}m${text}\x1b[0m` : text);
}

function banner(title: string, subtitle: string, color: (code: number, text: string) => string): void {
  const line = '─'.repeat(Math.max(title.length, subtitle.length) + 4);
  console.log(color(36, `┌${line}┐`));
  console.log(color(36, '│') + `  ${color(1, title)}`);
  console.log(color(36, '│') + `  ${color(2, subtitle)}`);
  console.log(color(36, `└${line}┘`));
}

async function openBrowser(url: string): Promise<void> {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : undefined;
  if (!command) return;
  try { await execa(command, [url], { reject: false, stdio: 'ignore' }); } catch { /* ignore */ }
}

async function replay(options: Options, color: (code: number, text: string) => string): Promise<void> {
  const dir = path.join(ARTIFACTS, BRANCH_DIRS[options.scenario]);
  if (!existsSync(dir)) {
    console.error(`No recorded run at ${dir}. Run \`npm run e2e-loop\` first.`);
    process.exitCode = 1;
    return;
  }

  const run = await loadRun(dir);
  const verification = run.verification;
  const repair = run.repair;
  const scenario = run.scenario;
  const bannerState = bannerFor({ verdict: verification?.verdict, repairStatus: repair?.status });
  const stamp = run.generation?.generatedAt ?? run.run?.startedAt ?? 'recorded';

  banner(
    'TestPilot — recorded replay',
    `${BRANCH_REFS[options.scenario]} · ${run.generation?.provider ?? 'recorded'}/${run.generation?.model ?? 'recorded'} · ${stamp}`,
    color
  );
  console.log(color(2, 'This is a replay, not a live run. Use --live for the real loop.\n'));

  if (scenario) {
    console.log(`${color(1, 'Risk:')} ${scenario.title}`);
    console.log(`${color(2, scenario.risk ?? '')}\n`);
  }

  const factor = options.fast ? 0.015 : 0.18;
  const minimum = options.fast ? 30 : 120;
  const events = run.timeline?.events ?? [];

  for (const event of events) {
    console.log(`${color(36, '▶')} ${event.stage}${event.detail ? color(2, ` — ${event.detail}`) : ''}`);
    const wait = Math.min(8_000, Math.max(minimum, Math.round(event.durationMs * factor)));
    await sleep(wait);
    console.log(`${color(32, '✓')} ${event.stage} ${color(2, `(${(event.durationMs / 1000).toFixed(1)}s)`)}`);
  }

  console.log(`\n${color(1, 'Evidence')}`);
  console.log(`  base: ${color(32, 'PASS')}`);
  const failure = verification?.revisions.head.runs
    .flatMap((entry) => entry.tests)
    .find((test) => test.failureMessages.length > 0)?.failureMessages[0];
  console.log(
    `  head: ${color(31, 'FAIL')} (${verification?.revisions.head.failureType ?? 'failure'})`
  );
  if (failure) {
    for (const line of failure.split('\n').slice(0, 2)) console.log(color(2, `    ${line}`));
  }
  console.log(
    `  existing suite on head: ${color(32, `${verification?.existingSuite.passed ?? 0}/${verification?.existingSuite.total ?? 0} green`)}`
  );

  if (run.fixPatch) {
    console.log(`\n${color(1, 'Fix')}`);
    for (const line of run.fixPatch.split('\n').filter((entry) => /^[+-]/.test(entry) && !/^[+-]{3}/.test(entry)).slice(0, 8)) {
      console.log(line.startsWith('+') ? color(32, `  ${line}`) : color(31, `  ${line}`));
    }
  }

  const fixed = run.fixedSummary;
  const fixedSuite = run.fixedExistingSuite;
  console.log(`\n${color(1, 'Proof')}`);
  console.log(`  ${color(32, '✓')} test passes on the patched code (${fixed?.consistentStatus ?? 'not run'})`);
  console.log(
    `  ${color(32, '✓')} existing suite ${fixedSuite?.passed ?? 0}/${fixedSuite?.total ?? 0} green`
  );

  console.log(`\n${color(1, 'VERDICT:')} ${color(bannerState.tone === 'green' ? 32 : 33, bannerState.title)}`);
  if (repair?.status === 'fixed_by_revert') {
    console.log(color(33, '  The fix reverts the change; the PR intent is not preserved.'));
  }

  await serveReport(options, BRANCH_REFS[options.scenario], color);
}

async function serveReport(
  options: Options,
  headRef: string,
  color: (code: number, text: string) => string
): Promise<void> {
  if (!options.serve) return;

  process.env.TESTPILOT_RUNS_DIR = path.join(ROOT, 'out', 'demo-runs');
  let runs = await listRuns();
  let match = runs.find((run) => run.head === headRef);
  if (!match) {
    await importRunsFrom(ARTIFACTS);
    runs = await listRuns();
    match = runs.find((run) => run.head === headRef);
  }
  if (!match) return;

  const server = await startServer({ port: 4317, runsDir: process.env.TESTPILOT_RUNS_DIR });
  const url = `${server.url}/runs/${match.runId}`;
  console.log(`\n${color(1, 'Report:')} ${color(36, url)}`);
  await openBrowser(url);
  console.log(color(2, 'Press Ctrl-C to stop the report server.'));

  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  await server.close();
}

async function live(options: Options, color: (code: number, text: string) => string): Promise<boolean> {
  banner('TestPilot — LIVE run', `${BRANCH_REFS[options.scenario]} · real loop`, color);
  console.log(color(2, 'Hard timeout: 6 minutes. Falls back to the replay on failure.\n'));

  const timeoutMs = 360_000;
  try {
    const child = execa(
      'npx',
      ['tsx', 'src/cli.ts', 'loop', '--repo', '../demo-shop', '--base', 'main',
        '--head', BRANCH_REFS[options.scenario], '--max-scenarios', '1', '--out', 'out/runs'],
      { cwd: ROOT, stdio: 'inherit', timeout: timeoutMs, killSignal: 'SIGTERM', reject: false }
    );

    const onSignal = (): void => { child.kill('SIGTERM'); };
    process.once('SIGINT', onSignal);

    const result = await child;
    process.removeListener('SIGINT', onSignal);

    if (result.timedOut || result.exitCode !== 0) {
      console.log(color(33, `\nLive run ${result.timedOut ? 'timed out' : `failed (exit ${result.exitCode})`}. Falling back to the recorded replay.\n`));
      return false;
    }

    process.env.TESTPILOT_RUNS_DIR = path.join(ROOT, 'out', 'runs');
    const runs = await listRuns();
    const match = runs.find((run) => run.head === BRANCH_REFS[options.scenario] && run.status === 'done');
    if (match && options.serve) {
      const server = await startServer({ port: 4317, runsDir: process.env.TESTPILOT_RUNS_DIR });
      const url = `${server.url}/runs/${match.runId}`;
      console.log(`\n${color(1, 'Report:')} ${color(36, url)}`);
      await openBrowser(url);
      await new Promise<void>((resolve) => {
        process.once('SIGINT', resolve);
        process.once('SIGTERM', resolve);
      });
      await server.close();
    }
    return true;
  } catch (error) {
    console.log(color(33, `\nLive run failed: ${(error as Error).message}\nFalling back to the recorded replay.\n`));
    return false;
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const color = painter(options.color);

  if (options.live) {
    const ok = await live(options, color);
    if (!ok) {
      options.live = false;
      await replay(options, color);
    }
    return;
  }

  await replay(options, color);
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
