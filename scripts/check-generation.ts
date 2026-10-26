/**
 * Acceptance harness for LLM test generation.
 * Reference tests are read only for a manual behavior comparison; they are
 * never included in prompts or sent to any provider.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import { listAvailableProviders, providerEnvKey, type ProviderName } from '../src/llm/client';
import { sanitizeRef } from '../src/generate/naming';
import {
  printTable,
  referenceNote,
  renderDocs,
  type ProviderResult,
  type ReferenceNote,
  type RunRecord
} from './generation-report';

const ROOT = path.resolve('.');
const REPO = path.resolve('../demo-shop');
const BRANCHES = ['bug/payment-concurrency', 'bug/user-lean'];
const PROVIDERS: ProviderName[] = ['anthropic', 'openai', 'google'];
const REFERENCE_FILES: Record<string, string> = {
  'bug/payment-concurrency': '__testpilot__/payment-failure.reference.test.ts',
  'bug/user-lean': '__testpilot__/profile-lean.reference.test.ts'
};

function runsFromArgv(): number {
  const index = process.argv.indexOf('--runs');
  const raw = index >= 0 ? process.argv[index + 1] : '3';
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 3;
}

async function showReference(branch: string): Promise<string | null> {
  const file = REFERENCE_FILES[branch];
  const result = await execa(
    'git',
    ['-C', REPO, 'show', `reference/regression-tests:${file}`],
    { reject: false }
  );
  return result.exitCode === 0 ? result.stdout : null;
}

function targetsReference(branch: string, code: string): RunRecord['targetsReference'] {
  if (branch === 'bug/payment-concurrency') {
    return /processPayment/.test(code) &&
      /tok_declined|Payment declined/.test(code) &&
      /pending/.test(code)
      ? 'same-behavior'
      : 'different-behavior';
  }
  return /getPublicProfile/.test(code) && /displayName|toPublicProfile/.test(code)
    ? 'same-behavior'
    : 'different-behavior';
}

async function runCombination(
  branch: string,
  provider: ProviderName,
  runs: number,
  runRoot: string
): Promise<ProviderResult> {
  const records: RunRecord[] = [];

  for (let run = 1; run <= runs; run += 1) {
    const outRoot = path.join(runRoot, provider, sanitizeRef(branch), `run-${run}`);
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
        '--out',
        outRoot
      ],
      { cwd: ROOT, reject: false, timeout: 300_000 }
    );

    if (result.exitCode !== 0) {
      records.push({
        run,
        status: 'error',
        attempts: 0,
        headPreview: 'none',
        targetsReference: 'n/a',
        title: '',
        fileName: '',
        error: (result.stderr || result.stdout).split('\n').slice(-3).join('\n')
      });
      continue;
    }

    const generationPath = path.join(outRoot, sanitizeRef(branch), 'generation.json');
    try {
      const generation = JSON.parse(await readFile(generationPath, 'utf8'));
      const scenario = generation.scenarios?.[0];
      if (!scenario) {
        records.push({
          run,
          status: 'error',
          attempts: 0,
          headPreview: 'none',
          targetsReference: 'n/a',
          title: '',
          fileName: '',
          error: 'no scenario generated'
        });
        continue;
      }

      let targets: RunRecord['targetsReference'] = 'n/a';
      if (scenario.status === 'valid' && scenario.fileName) {
        try {
          const code = await readFile(
            path.join(outRoot, sanitizeRef(branch), scenario.fileName),
            'utf8'
          );
          targets = targetsReference(branch, code);
        } catch {
          targets = 'n/a';
        }
      }

      records.push({
        run,
        status: scenario.status,
        attempts: scenario.attempts?.length ?? 0,
        headPreview: scenario.headPreview
          ? scenario.headPreview.passed
            ? 'pass'
            : 'fail'
          : 'none',
        targetsReference: targets,
        title: scenario.title,
        fileName: scenario.fileName ?? '',
        error: scenario.finalError ?? ''
      });
    } catch (error) {
      records.push({
        run,
        status: 'error',
        attempts: 0,
        headPreview: 'none',
        targetsReference: 'n/a',
        title: '',
        fileName: '',
        error: (error as Error).message
      });
    }
  }

  const valid = records.filter((record) => record.status === 'valid');
  const caught = valid.filter((record) => record.headPreview === 'fail');
  const attemptsTotal = records.reduce((sum, record) => sum + record.attempts, 0);

  return {
    branch,
    provider,
    runs: records,
    validRate: records.length === 0 ? 0 : valid.length / records.length,
    avgAttempts: records.length === 0 ? 0 : attemptsTotal / records.length,
    caughtOnHead: caught.length,
    caughtOnHeadRate: valid.length === 0 ? 0 : caught.length / valid.length,
    validCount: valid.length,
    targetMet: valid.length >= Math.ceil(records.length * (2 / 3)) && caught.length >= 1
  };
}

async function main(): Promise<void> {
  const runs = runsFromArgv();
  const available = listAvailableProviders();
  const skipped = PROVIDERS.filter((provider) => !available.includes(provider));
  const runRoot = path.join(ROOT, 'out', 'check-generation-runs');
  const jsonPath = path.join(ROOT, 'out', 'check-generation.json');
  const docsPath = path.join(ROOT, 'docs', 'generation-results.md');

  await rm(runRoot, { recursive: true, force: true });
  await mkdir(path.dirname(jsonPath), { recursive: true });
  await mkdir(path.dirname(docsPath), { recursive: true });

  const results: ProviderResult[] = [];

  for (const branch of BRANCHES) {
    for (const provider of available) {
      console.log(`Running ${branch} with ${provider} (${runs} run(s))...`);
      results.push(await runCombination(branch, provider, runs, runRoot));
    }

    for (const provider of skipped) {
      results.push({
        branch,
        provider,
        runs: [],
        validRate: 0,
        avgAttempts: 0,
        caughtOnHeadRate: 0,
        caughtOnHead: 0,
        validCount: 0,
        targetMet: false,
        skippedReason: `${providerEnvKey(provider)} not set`
      });
    }
  }

  const branchTargets = BRANCHES.map((branch) => ({
    branch,
    met: results.some((result) => result.branch === branch && result.targetMet)
  }));
  const liveTargetsMet = available.length > 0 && branchTargets.every((entry) => entry.met);
  const references: ReferenceNote[] = [];

  for (const branch of BRANCHES) {
    const reference = await showReference(branch);
    references.push(
      referenceNote(
        branch,
        REFERENCE_FILES[branch],
        reference,
        results
          .filter((result) => result.branch === branch)
          .flatMap((result) => result.runs)
      )
    );
  }

  await writeFile(
    jsonPath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        runsPerCombination: runs,
        providersAvailable: available,
        providersSkipped: skipped,
        results,
        branchTargets,
        liveTargetsMet,
        referenceComparison: references
      },
      null,
      2
    )}\n`,
    'utf8'
  );

  printTable(results);
  await writeFile(
    docsPath,
    renderDocs({ available, skipped, results, references, liveTargetsMet }),
    'utf8'
  );
  console.log(`\nSaved ${jsonPath}`);
  console.log(`Saved ${docsPath}`);

  if (available.length > 0 && !liveTargetsMet) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
