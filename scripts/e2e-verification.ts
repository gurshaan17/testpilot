/**
 * End-to-end verification of LLM-generated tests.
 * Runs `testpilot run` (analyze + generate + verify) twice per bug branch for
 * each provider that has a key, then writes docs/e2e-verification-results.md.
 */
import { config } from 'dotenv';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import { listAvailableProviders, providerEnvKey, type ProviderName } from '../src/llm/client';
import { sanitizeRef } from '../src/generate/naming';

config({ quiet: true });

const ROOT = path.resolve('.');
const REPO = path.resolve('../demo-shop');
const RUNS = 2;
const BRANCHES = ['bug/payment-concurrency', 'bug/user-lean'];

interface RunRecord {
  branch: string;
  provider: ProviderName;
  run: number;
  scenario?: { id: string; title: string };
  status: 'valid' | 'invalid' | 'error';
  verdict?: string;
  confidence?: string;
  fixedCheck?: string;
  baseStatus?: string;
  headStatus?: string;
  headType?: string;
  evidence?: string;
  existing?: { passed: number; failed: number; total: number };
  reasons?: string[];
  testCode?: string;
  error?: string;
}

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

async function runOnce(
  branch: string,
  provider: ProviderName,
  run: number
): Promise<RunRecord> {
  const outRoot = path.join(ROOT, 'out', 'e2e', provider, sanitizeRef(branch), `run-${run}`);
  await rm(outRoot, { recursive: true, force: true });

  const result = await execa(
    'npx',
    [
      'tsx',
      'src/cli.ts',
      'run',
      '--repo',
      REPO,
      '--base',
      'main',
      '--head',
      branch,
      '--provider',
      provider,
      '--max-scenarios',
      '1',
      '--repeat',
      '3',
      '--out',
      outRoot
    ],
    { cwd: ROOT, reject: false, timeout: 900_000 }
  );

  if (result.exitCode !== 0) {
    return {
      branch,
      provider,
      run,
      status: 'error',
      error: (result.stderr || result.stdout).split('\n').slice(-4).join('\n')
    };
  }

  const dir = path.join(outRoot, sanitizeRef(branch));
  const generation = await readJson(path.join(dir, 'generation.json'));
  const verification = await readJson(path.join(dir, 'verification.json'));
  const scenario = (generation?.scenarios as Record<string, unknown>[] | undefined)?.[0];

  if (!scenario) {
    return { branch, provider, run, status: 'invalid', error: 'no scenario generated' };
  }

  if (scenario.status !== 'valid' || !verification) {
    return {
      branch,
      provider,
      run,
      status: 'invalid',
      scenario: { id: String(scenario.id), title: String(scenario.title) },
      error: String(scenario.finalError ?? 'no verification result')
    };
  }

  const revisions = verification.revisions as Record<string, Record<string, unknown>>;
  const base = revisions.base;
  const head = revisions.head;
  const fileName = String(scenario.fileName);

  let testCode: string | undefined;
  try {
    testCode = await readFile(path.join(dir, fileName), 'utf8');
  } catch {
    testCode = undefined;
  }

  return {
    branch,
    provider,
    run,
    scenario: { id: String(scenario.id), title: String(scenario.title) },
    status: 'valid',
    verdict: String(verification.verdict),
    confidence: String(verification.confidence),
    fixedCheck: String(verification.fixedCheck),
    baseStatus: String(base.consistentStatus),
    headStatus: String(head.consistentStatus),
    headType: head.failureType ? String(head.failureType) : undefined,
    evidence: String(head.changedCodeEvidence),
    existing: verification.existingSuite as RunRecord['existing'],
    reasons: (verification.reasons as string[]) ?? [],
    testCode
  };
}

function table(records: RunRecord[]): string {
  const header = [
    'Branch'.padEnd(25),
    'Run'.padEnd(4),
    'Verdict'.padEnd(30),
    'Confidence'.padEnd(10),
    'Base'.padEnd(8),
    'Head'.padEnd(8),
    'Head type'.padEnd(14),
    'Existing suite'
  ].join('  ');
  const lines = [header, '-'.repeat(header.length)];
  for (const record of records) {
    lines.push(
      [
        record.branch.padEnd(25),
        String(record.run).padEnd(4),
        (record.verdict ?? record.status).padEnd(30),
        (record.confidence ?? '-').padEnd(10),
        (record.baseStatus ?? '-').padEnd(8),
        (record.headStatus ?? '-').padEnd(8),
        (record.headType ?? '-').padEnd(14),
        record.existing
          ? `${record.existing.passed}/${record.existing.total} passed`
          : '-'
      ].join('  ')
    );
  }
  return lines.join('\n');
}

function example(record: RunRecord): string {
  const parts = [
    `### ${record.branch} (${record.provider}, run ${record.run})`,
    '',
    `**Scenario:** ${record.scenario?.title ?? 'n/a'}`,
    '',
    `**Verdict:** \`${record.verdict}\` (confidence: \`${record.confidence}\`, fixed check: \`${record.fixedCheck}\`)`,
    '',
    '**Revisions:**',
    '',
    `- base: ${record.baseStatus}`,
    `- head: ${record.headStatus} [${record.headType ?? 'n/a'}]`,
    `- changed-code evidence: ${record.evidence}`,
    `- existing suite on head: ${record.existing?.passed ?? 0}/${record.existing?.total ?? 0} passed`,
    '',
    '**Reasons:**',
    '',
    ...(record.reasons ?? []).map((reason) => `- ${reason}`),
    '',
    '**Generated test:**',
    '',
    '```ts',
    (record.testCode ?? '// unavailable').trim(),
    '```'
  ];
  return parts.join('\n');
}

async function main(): Promise<void> {
  const available = listAvailableProviders();
  const skipped = (['anthropic', 'openai', 'google'] as ProviderName[]).filter(
    (provider) => !available.includes(provider)
  );

  console.log(`Providers: ${available.join(', ') || 'none'}`);
  console.log(`Skipped: ${skipped.map((p) => `${p} (${providerEnvKey(p)})`).join(', ') || 'none'}`);

  const records: RunRecord[] = [];

  for (const branch of BRANCHES) {
    for (const provider of available) {
      for (let run = 1; run <= RUNS; run += 1) {
        console.log(`Running ${branch} / ${provider} / ${run}...`);
        records.push(await runOnce(branch, provider, run));
      }
    }
  }

  console.log(`\n${table(records)}`);

  const caught = records.filter((record) => record.verdict === 'regression_caught').length;
  const valid = records.filter((record) => record.status === 'valid').length;
  console.log(`\nregression_caught: ${caught}/${records.length} runs (${valid} valid tests)`);

  await mkdir(path.join(ROOT, 'out'), { recursive: true });
  await writeFile(
    path.join(ROOT, 'out', 'e2e-verification.json'),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), available, skipped, records }, null, 2)}\n`,
    'utf8'
  );

  const examples = BRANCHES.map((branch) => {
    const candidates = records.filter(
      (record) => record.branch === branch && record.status === 'valid'
    );
    return (
      candidates.find((record) => record.verdict === 'regression_caught') ?? candidates[0]
    );
  });

  const docs = [
    '# End-to-end verification results',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    `Providers run: ${available.join(', ') || 'none'}. Skipped: ${skipped.map((p) => providerEnvKey(p)).join(', ') || 'none'}.`,
    '',
    'Each run is `testpilot run` (analyze → generate → verify) with `--max-scenarios 1` and three repeats per revision.',
    '',
    '## Runs',
    '',
    '```text',
    table(records),
    '```',
    '',
    `\`regression_caught\`: ${caught}/${records.length} runs (${valid} valid generated tests).`,
    '',
    '## Worked examples',
    '',
    ...examples.map((record) => (record ? example(record) : 'No valid example produced.'))
  ].join('\n');

  await writeFile(path.join(ROOT, 'docs', 'e2e-verification-results.md'), `${docs}\n`, 'utf8');
  console.log('Saved out/e2e-verification.json and docs/e2e-verification-results.md');
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
