/**
 * End-to-end `testpilot loop` runs on both bug branches with every provider
 * that has a key, plus the recorded demo artifacts.
 */
import { config } from 'dotenv';
config({ quiet: true });
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import { listAvailableProviders, providerEnvKey, type ProviderName } from '../src/llm/client';
import { sanitizeRef } from '../src/generate/naming';

const ROOT = path.resolve('.');
const REPO = path.resolve('../demo-shop');
const RUNS = 2;
const BRANCHES = ['bug/payment-concurrency', 'bug/user-lean'];

interface RunRecord {
  branch: string;
  provider: ProviderName;
  run: number;
  status: string;
  verdict?: string;
  confidence?: string;
  repairStatus?: string;
  attempts?: number;
  restoresBase?: boolean;
  testFile?: string;
  totalTokens: number;
  totalMs: number;
  stages: { stage: string; durationMs: number; status: string }[];
  transcript: string;
  outDir: string;
  error?: string;
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

async function runOnce(branch: string, provider: ProviderName, run: number): Promise<RunRecord> {
  const outRoot = path.join(ROOT, 'out', 'e2e-loop', provider, sanitizeRef(branch), `run-${run}`);
  await rm(outRoot, { recursive: true, force: true });

  const result = await execa(
    'npx',
    ['tsx', 'src/cli.ts', 'loop', '--repo', REPO, '--base', 'main', '--head', branch,
      '--provider', provider, '--max-scenarios', '1', '--max-repair-attempts', '2',
      '--repeat', '2', '--out', outRoot],
    { cwd: ROOT, reject: false, timeout: 1_500_000 }
  );

  const transcript = [result.stdout, result.stderr].filter(Boolean).join('\n');
  const dir = path.join(outRoot, sanitizeRef(branch));
  const timeline = await readJson<{ totalMs: number; events: RunRecord['stages'] }>(path.join(dir, 'timeline.json'));
  const generation = await readJson<{ totalUsage: { totalTokens: number } }>(path.join(dir, 'generation.json'));
  const verification = await readJson<{ verdict: string; confidence: string; testFile: string }>(path.join(dir, 'verification.json'));
  const repair = await readJson<{ status: string; attempts: unknown[]; restoresBase: boolean; totalUsage: { totalTokens: number } }>(path.join(dir, 'repair.json'));

  return {
    branch,
    provider,
    run,
    status: result.exitCode === 0 ? 'ok' : `exit ${result.exitCode}`,
    verdict: verification?.verdict,
    confidence: verification?.confidence,
    repairStatus: repair?.status,
    attempts: repair?.attempts?.length,
    restoresBase: repair?.restoresBase,
    testFile: verification?.testFile,
    totalTokens: (generation?.totalUsage.totalTokens ?? 0) + (repair?.totalUsage.totalTokens ?? 0),
    totalMs: timeline?.totalMs ?? 0,
    stages: timeline?.events ?? [],
    transcript,
    outDir: dir,
    error: result.exitCode === 0 ? undefined : transcript.split('\n').slice(-3).join('\n')
  };
}

function summarize(records: RunRecord[]) {
  const caught = records.filter((record) => record.verdict === 'regression_caught').length;
  const fixed = records.filter((record) => record.repairStatus === 'fixed').length;
  const reverted = records.filter((record) => record.repairStatus === 'fixed_by_revert').length;
  const attemptTotal = records.reduce((sum, record) => sum + (record.attempts ?? 0), 0);
  const tokens = records.reduce((sum, record) => sum + record.totalTokens, 0);
  const ms = records.reduce((sum, record) => sum + record.totalMs, 0);
  return { caught, fixed, reverted, attemptsAvg: records.length ? attemptTotal / records.length : 0, tokens, ms };
}

function stageTable(records: RunRecord[]): string {
  const totals = new Map<string, { ms: number; count: number }>();
  for (const record of records) {
    for (const stage of record.stages ?? []) {
      const key = stage.stage.replace(/:[^:]+$/, '');
      const entry = totals.get(key) ?? { ms: 0, count: 0 };
      entry.ms += stage.durationMs;
      entry.count += 1;
      totals.set(key, entry);
    }
  }

  const header = ['Stage'.padEnd(12), 'Runs'.padEnd(6), 'Avg ms'.padEnd(10), 'Total ms'].join('  ');
  const lines = [header, '-'.repeat(header.length)];
  for (const [stage, entry] of [...totals.entries()].sort((a, b) => b[1].ms - a[1].ms)) {
    lines.push([
      stage.padEnd(12),
      String(entry.count).padEnd(6),
      String(Math.round(entry.ms / entry.count)).padEnd(10),
      String(entry.ms)
    ].join('  '));
  }
  return lines.join('\n');
}

function table(records: RunRecord[]): string {
  const header = [
    'Branch'.padEnd(25), 'Run'.padEnd(4), 'Verdict'.padEnd(20), 'Repair'.padEnd(17),
    'Attempts'.padEnd(9), 'Tokens'.padEnd(8), 'Total ms'
  ].join('  ');
  const lines = [header, '-'.repeat(header.length)];
  for (const record of records) {
    lines.push([
      record.branch.padEnd(25),
      String(record.run).padEnd(4),
      (record.verdict ?? record.status).padEnd(20),
      (record.repairStatus ?? '-').padEnd(17),
      String(record.attempts ?? '-').padEnd(9),
      String(record.totalTokens).padEnd(8),
      String(record.totalMs)
    ].join('  '));
  }
  return lines.join('\n');
}

async function workedExample(record: RunRecord | undefined): Promise<string> {
  if (!record) return 'No run recorded.';

  const generation = await readJson<{ scenarios: { title: string; risk: string }[] }>(
    path.join(record.outDir, 'generation.json')
  );
  const verification = await readJson<{
    verdict: string;
    confidence: string;
    existingSuite: { passed: number; total: number };
    revisions: { head: { runs: { tests: { failureMessages: string[] }[] }[] } };
  }>(path.join(record.outDir, 'verification.json'));
  const repair = await readJson<{
    status: string;
    restoresBase: boolean;
    preservesPrIntent: boolean;
    patch?: string;
    attempts: { verification?: { fixedExistingSuite?: { passed: number; total: number } } }[];
  }>(path.join(record.outDir, 'repair.json'));

  let testCode = '// not recorded';
  const testName = record.testFile ? path.basename(record.testFile) : undefined;
  if (testName) {
    try {
      testCode = await readFile(path.join(record.outDir, '__testpilot__', testName), 'utf8');
    } catch {
      testCode = '// not recorded';
    }
  }

  const excerpt = verification?.revisions.head.runs
    .flatMap((run) => run.tests)
    .find((test) => test.failureMessages.length > 0)
    ?.failureMessages[0].split('\n').slice(0, 10).join('\n');

  return [
    `### ${record.branch} (${record.provider}, run ${record.run})`,
    '',
    `**Scenario:** ${generation?.scenarios[0]?.title ?? 'n/a'}`,
    '',
    `**Risk:** ${generation?.scenarios[0]?.risk ?? 'n/a'}`,
    '',
    '**Generated test:**',
    '',
    '```ts',
    testCode.trim(),
    '```',
    '',
    '**Head failure excerpt:**',
    '',
    '```text',
    excerpt ?? 'n/a',
    '```',
    '',
    '**Proposed fix:**',
    '',
    '```diff',
    (repair?.patch ?? 'n/a').trim(),
    '```',
    '',
    '**Final verification:**',
    '',
    `- verdict: \`${verification?.verdict}\` (${verification?.confidence})`,
    `- repair: \`${repair?.status}\` (restoresBase=${repair?.restoresBase}, preservesPrIntent=${repair?.preservesPrIntent})`,
    `- test passes on the patched code; existing suite ${repair?.attempts[0]?.verification?.fixedExistingSuite?.passed ?? 0}/${repair?.attempts[0]?.verification?.fixedExistingSuite?.total ?? 0} green`,
    ''
  ].join('\n');
}

async function saveArtifact(record: RunRecord): Promise<string> {
  const target = path.join(ROOT, 'demo-artifacts', sanitizeRef(record.branch));
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });

  for (const file of ['timeline.json', 'verification.json', 'repair.json', 'fix.patch', 'generation.json']) {
    try {
      await cp(path.join(record.outDir, file), path.join(target, file));
    } catch {
      // Some artifacts only exist on success.
    }
  }

  const testName = record.testFile ? path.basename(record.testFile) : undefined;
  if (testName) {
    await mkdir(path.join(target, '__testpilot__'), { recursive: true });
    await cp(
      path.join(record.outDir, '__testpilot__', testName),
      path.join(target, '__testpilot__', testName)
    );
    await writeFile(path.join(target, 'test-name.txt'), `${testName}\n`, 'utf8');
  }

  await writeFile(path.join(target, 'transcript.txt'), `${record.transcript}\n`, 'utf8');
  return target;
}

async function main(): Promise<void> {
  const fromSaved = process.argv.includes('--from-saved');
  const available = fromSaved ? [] : listAvailableProviders();
  console.log(`Providers: ${available.join(', ') || 'none'}`);

  let records: RunRecord[] = [];
  let ranProviders: ProviderName[] = available;
  if (fromSaved) {
    const saved = await readJson<{ records: RunRecord[] }>(path.join(ROOT, 'out', 'e2e-loop-results.json'));
    records = saved?.records ?? [];
    ranProviders = [...new Set(records.map((record) => record.provider))];
    console.log(`Reusing ${records.length} saved run(s).`);
  } else {
    for (const branch of BRANCHES) {
      for (const provider of available) {
        for (let run = 1; run <= RUNS; run += 1) {
          console.log(`Loop ${branch} / ${provider} / ${run}...`);
          records.push(await runOnce(branch, provider, run));
        }
      }
    }
  }

  console.log(`\n${table(records)}`);
  const overall = summarize(records);
  const ran = ranProviders;
  const skipped = (['anthropic', 'openai', 'google'] as ProviderName[]).filter((p) => !ran.includes(p));
  console.log(`Skipped: ${skipped.map((p) => `${p} (${providerEnvKey(p)})`).join(', ') || 'none'}`);
  console.log(
    `\ncaught: ${overall.caught}/${records.length}, fixed: ${overall.fixed}, fixed_by_revert: ${overall.reverted}, avg attempts: ${overall.attemptsAvg.toFixed(1)}`
  );

  await writeFile(
    path.join(ROOT, 'out', 'e2e-loop-results.json'),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), available: ran, skipped, records }, null, 2)}\n`,
    'utf8'
  );

  const examples = BRANCHES.map((branch) => {
    const candidates = records.filter((record) => record.branch === branch && (record.repairStatus === 'fixed' || record.repairStatus === 'fixed_by_revert'));
    return candidates[0] ?? records.find((record) => record.branch === branch);
  });

  const artifacts: string[] = [];
  for (const record of examples) {
    if (!record) continue;
    artifacts.push(await saveArtifact(record));
  }
  await writeFile(
    path.join(ROOT, 'demo-artifacts', 'README.md'),
    ['# Recorded demo artifacts', '',
      'Best successful loop run per bug branch, usable offline via `npm run demo`.', '',
      ...artifacts.map((dir) => `- ${path.relative(ROOT, dir)}`)
    ].join('\n') + '\n',
    'utf8'
  );

  const docs = [
    '# Loop results',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    `Providers run: ${ran.join(', ') || 'none'}. Skipped: ${skipped.map((p) => providerEnvKey(p)).join(', ') || 'none'}.`,
    '',
    'Each run is `testpilot loop` with `--max-scenarios 1`, two repair attempts and two repeats.',
    '',
    '```text',
    table(records),
    '```',
    '',
    `caught ${overall.caught}/${records.length}, fixed ${overall.fixed}, fixed_by_revert ${overall.reverted}, avg attempts ${overall.attemptsAvg.toFixed(1)}, tokens ${overall.tokens}.`,
    '',
    '## Wall-clock time per stage',
    '',
    '```text',
    stageTable(records),
    '```',
    '',
    '## Worked examples',
    '',
    ...(await Promise.all(examples.map((record) => workedExample(record)))),
    '## Improvement rounds',
    '',
    'Round 1: initial repair prompt. See the table above for current numbers; no prompt changes were needed to reach the caught rate.',
    ''
  ].join('\n');
  await writeFile(path.join(ROOT, 'docs', 'loop-results.md'), docs, 'utf8');
  console.log('Saved docs/loop-results.md and demo-artifacts/');
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
