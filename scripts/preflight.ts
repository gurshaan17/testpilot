/**
 * Fast pre-demo checks. No LLM calls unless --online is passed.
 */
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { execa } from 'execa';
import { config } from 'dotenv';
config({ quiet: true });
import { AnalysisReportSchema } from '../src/analysis/schema';
import { RepairResultSchema } from '../src/repair/schema';
import { VerificationResultSchema } from '../src/runner/schema';
import { GenerationArtifactSchema, TimelineSchema } from '../src/store/schema';
import { listAvailableProviders, providerEnvKey, generateStructured } from '../src/llm/client';
import { z } from 'zod';

const ROOT = path.resolve('.');
const REPO = path.resolve('../demo-shop');
const ARTIFACTS = path.join(ROOT, 'demo-artifacts');
const BRANCHES = ['bug/payment-concurrency', 'bug/user-lean'];
const EXPECTED_BRANCHES = ['main', ...BRANCHES, 'reference/regression-tests'];
const FILES = ['generation.json', 'analysis.json', 'verification.json', 'repair.json', 'timeline.json', 'fix.patch', 'transcript.txt'];

type Status = 'PASS' | 'WARN' | 'FAIL';
interface Row { check: string; status: Status; detail: string }
const rows: Row[] = [];
const add = (check: string, status: Status, detail: string): void => { rows.push({ check, status, detail }); };

async function checkVersions(): Promise<void> {
  const node = process.versions.node.split('.').map(Number);
  add('node >= 20', node[0] >= 20 ? 'PASS' : 'FAIL', `v${process.versions.node}`);
  const git = await execa('git', ['--version'], { reject: false });
  add('git available', git.exitCode === 0 ? 'PASS' : 'FAIL', git.stdout || 'missing');
}

async function checkRepo(): Promise<void> {
  if (!existsSync(REPO)) {
    add('demo-shop exists', 'FAIL', 'missing ../demo-shop');
    return;
  }
  add('demo-shop exists', 'PASS', REPO);

  const branches = await execa('git', ['-C', REPO, 'branch', '--format=%(refname:short)'], { reject: false });
  const current = branches.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  const missing = EXPECTED_BRANCHES.filter((branch) => !current.includes(branch));
  add('expected branches', missing.length === 0 ? 'PASS' : 'FAIL', missing.length ? `missing: ${missing.join(', ')}` : current.length + ' branches');

  const status = await execa('git', ['-C', REPO, 'status', '--short'], { reject: false });
  add('demo-shop clean', status.stdout.trim() ? 'WARN' : 'PASS', status.stdout.trim() || 'clean');
}

async function checkWorktrees(fix: boolean): Promise<void> {
  const list = await execa('git', ['-C', REPO, 'worktree', 'list', '--porcelain'], { reject: false });
  const worktrees = list.stdout.split('\n').filter((line) => line.startsWith('worktree ')).map((line) => line.slice(9));
  const stale = worktrees.filter((dir) => dir !== REPO);
  if (stale.length === 0) {
    add('worktrees', 'PASS', 'only the main worktree');
    return;
  }
  if (fix) {
    for (const dir of stale) await execa('git', ['-C', REPO, 'worktree', 'remove', '--force', dir], { reject: false });
    await execa('git', ['-C', REPO, 'worktree', 'prune'], { reject: false });
    add('worktrees', 'PASS', `pruned ${stale.length} stale worktree(s)`);
  } else {
    add('worktrees', 'WARN', `${stale.length} stale worktree(s); rerun with --fix to prune`);
  }
}

async function checkProcesses(fix: boolean): Promise<void> {
  const ps = await execa('ps', ['-Ao', 'pid,command'], { reject: false });
  const leftovers = ps.stdout
    .split('\n')
    .filter((line) => /testpilot-wt-|testpilot-jest-|__testpilot__/.test(line))
    .filter((line) => !line.includes('ps -Ao') && !line.includes('scripts/preflight'));

  if (leftovers.length === 0) {
    add('leftover processes', 'PASS', 'none');
    return;
  }
  if (fix) {
    for (const line of leftovers) {
      const pid = Number(line.trim().split(/\s+/)[0]);
      if (Number.isInteger(pid) && pid !== process.pid) {
        try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
      }
    }
    add('leftover processes', 'PASS', `terminated ${leftovers.length}`);
  } else {
    add('leftover processes', 'WARN', `${leftovers.length} found; rerun with --fix to terminate`);
  }
}

async function checkArtifacts(): Promise<void> {
  if (!existsSync(ARTIFACTS)) {
    add('demo-artifacts', 'FAIL', 'missing demo-artifacts/');
    return;
  }

  for (const branch of BRANCHES) {
    const dir = path.join(ARTIFACTS, branch.replace('/', '-'));
    const missing = FILES.filter((file) => !existsSync(path.join(dir, file)));
    const tests = existsSync(path.join(dir, '__testpilot__')) ? await readdir(path.join(dir, '__testpilot__')) : [];
    if (missing.length > 0 || tests.filter((file) => file.endsWith('.test.ts')).length === 0) {
      add(`${branch} artifacts`, 'FAIL', missing.length ? `missing ${missing.join(', ')}` : 'no generated test');
      continue;
    }

    try {
      AnalysisReportSchema.parse(JSON.parse(await readFile(path.join(dir, 'analysis.json'), 'utf8')));
      VerificationResultSchema.parse(JSON.parse(await readFile(path.join(dir, 'verification.json'), 'utf8')));
      RepairResultSchema.parse(JSON.parse(await readFile(path.join(dir, 'repair.json'), 'utf8')));
      GenerationArtifactSchema.parse(JSON.parse(await readFile(path.join(dir, 'generation.json'), 'utf8')));
      TimelineSchema.parse(JSON.parse(await readFile(path.join(dir, 'timeline.json'), 'utf8')));

      const verification = JSON.parse(await readFile(path.join(dir, 'verification.json'), 'utf8'));
      const repair = JSON.parse(await readFile(path.join(dir, 'repair.json'), 'utf8'));
      const ok = verification.verdict === 'regression_caught';
      add(
        `${branch} story`,
        ok ? 'PASS' : 'FAIL',
        `verdict=${verification.verdict}, repair=${repair.status}`
      );
    } catch (error) {
      add(`${branch} JSON schemas`, 'FAIL', (error as Error).message.slice(0, 120));
    }
  }
}

async function checkProviders(online: boolean): Promise<void> {
  const available = listAvailableProviders();
  const names = ['anthropic', 'openai', 'google'] as const;
  add(
    'provider keys',
    available.length > 0 ? 'PASS' : 'WARN',
    names.map((name) => `${name}:${available.includes(name) ? 'set' : 'unset'}`).join(' ')
  );

  if (!online) {
    add('llm-check', 'WARN', 'not called; rerun with --online for one tiny call per provider');
    return;
  }

  for (const provider of available) {
    try {
      const result = await generateStructured({
        provider,
        prompt: 'Reply with the word ok',
        schema: z.object({ answer: z.string() }),
        temperature: 0
      });
      add(`llm-check ${provider}`, 'PASS', `${result.model}`);
    } catch (error) {
      add(`llm-check ${provider}`, 'FAIL', (error as Error).message.slice(0, 120));
    }
  }
  if (available.length === 0) add('llm-check', 'WARN', 'no provider keys');
}

async function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function checkPort(): Promise<void> {
  const free = await portFree(4317);
  if (free) {
    add('port 4317', 'PASS', 'free');
    return;
  }
  const lsof = await execa('lsof', ['-nP', '-iTCP:4317', '-sTCP:LISTEN'], { reject: false });
  add('port 4317', 'WARN', (lsof.stdout || 'in use').split('\n').slice(0, 2).join(' '));
}

async function main(): Promise<void> {
  const fix = process.argv.includes('--fix');
  const online = process.argv.includes('--online');

  await checkVersions();
  await checkRepo();
  await checkWorktrees(fix);
  await checkProcesses(fix);
  await checkArtifacts();
  await checkProviders(online);
  await checkPort();

  const widths = { check: Math.max(6, ...rows.map((row) => row.check.length)), detail: Math.max(6, ...rows.map((row) => row.detail.length)) };
  console.log(`\n${['Check'.padEnd(widths.check), 'Status'.padEnd(6), 'Detail'.padEnd(widths.detail)].join('  ')}`);
  console.log('-'.repeat(widths.check + widths.detail + 12));
  for (const row of rows) {
    console.log([row.check.padEnd(widths.check), row.status.padEnd(6), row.detail.padEnd(widths.detail)].join('  '));
  }

  const failed = rows.filter((row) => row.status === 'FAIL');
  const warned = rows.filter((row) => row.status === 'WARN');
  console.log(`\n${rows.length - failed.length - warned.length} pass, ${warned.length} warn, ${failed.length} fail`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
