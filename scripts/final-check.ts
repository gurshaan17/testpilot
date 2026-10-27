/**
 * Final QA and security sweep. Run before tagging the submission.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execa } from 'execa';

const ROOT = path.resolve('.');
const REPO = path.resolve('../demo-shop');
const DOCS = path.join(ROOT, 'docs', 'final-check.md');

type Status = 'PASS' | 'FAIL' | 'WARN';
interface Row { check: string; status: Status; detail: string }
const rows: Row[] = [];
const add = (check: string, status: Status, detail: string): void => { rows.push({ check, status, detail }); };

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{20,}/,
  /AIza[0-9A-Za-z_-]{30,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /(?:api_key|apikey)\s*[=:]\s*['"][A-Za-z0-9_-]{16,}['"]/i,
  /(?:ANTHROPIC|OPENAI|GOOGLE_GENERATIVE_AI)_API_KEY\s*=\s*[A-Za-z0-9_-]{16,}/
];

async function run(check: string, cmd: string, args: string[], cwd = ROOT, timeout = 1_800_000): Promise<boolean> {
  try {
    const result = await execa(cmd, args, { cwd, reject: false, timeout, all: true });
    const ok = result.exitCode === 0;
    add(check, ok ? 'PASS' : 'FAIL', ok ? 'ok' : (result.all ?? '').split('\n').slice(-3).join(' ').slice(0, 200));
    return ok;
  } catch (error) {
    add(check, 'FAIL', (error as Error).message.slice(0, 200));
    return false;
  }
}

async function scanSecrets(): Promise<void> {
  const tree = await execa('git', ['grep', '-nE', SECRET_PATTERNS.map((re) => re.source).join('|'), '--', '.', ':!package-lock.json'], { cwd: ROOT, reject: false });
  const history = await execa('git', ['log', '-p', '--all', '--', '.', ':!package-lock.json'], { cwd: ROOT, reject: false, maxBuffer: 50_000_000 });
  const fakeValue = /dummy|fake|test-secret|placeholder|not-a-real/i;
  const historyHits = history.stdout
    .split('\n')
    .filter((line) => line.startsWith('+') && SECRET_PATTERNS.some((re) => re.test(line)))
    .filter((line) => !fakeValue.test(line));

  if (tree.stdout.trim()) add('secrets in working tree', 'FAIL', tree.stdout.split('\n')[0].slice(0, 160));
  else add('secrets in working tree', 'PASS', 'none');

  if (historyHits.length > 0) add('secrets in git history', 'FAIL', historyHits[0].slice(0, 160));
  else add('secrets in git history', 'PASS', 'none');
}

async function checkIgnoreRules(): Promise<void> {
  const untracked = await execa('git', ['ls-files', '--error-unmatch', '.env'], { cwd: ROOT, reject: false });
  add('.env untracked', untracked.exitCode !== 0 ? 'PASS' : 'FAIL', untracked.exitCode !== 0 ? 'not tracked' : 'tracked');

  try {
    const example = await readFile(path.join(ROOT, '.env.example'), 'utf8');
    const valued = example.split('\n').filter((line) => /^[A-Z0-9_]+=.+/.test(line.trim()));
    add('.env.example has no values', valued.length === 0 ? 'PASS' : 'FAIL', valued.length ? valued[0] : 'all empty');
  } catch {
    add('.env.example has no values', 'FAIL', 'missing .env.example');
  }

  const ignored = await execa('git', ['check-ignore', 'out/x', '.testpilot-cache/x'], { cwd: ROOT, reject: false });
  const lines = ignored.stdout.split('\n').filter(Boolean);
  add('out/ and .testpilot-cache ignored', lines.length === 2 ? 'PASS' : 'WARN', lines.join(', ') || 'not ignored');
}

async function checkAnswerKeyLeak(): Promise<void> {
  const roots = [path.join(ROOT, 'out', 'runs'), path.join(ROOT, 'demo-artifacts')];
  const hits: string[] = [];
  const forbidden = /reference\/regression-tests|payment-failure\.reference|profile-lean\.reference/;

  for (const root of roots) {
    if (!existsSync(root)) continue;
    const files = await execa('find', [root, '-type', 'f'], { reject: false });
    for (const file of files.stdout.split('\n').filter(Boolean)) {
      if (file.endsWith('.html') || file.endsWith('.md')) continue;
      try {
        if (forbidden.test(await readFile(file, 'utf8'))) hits.push(path.relative(ROOT, file));
      } catch { /* unreadable */ }
    }
  }

  add('no answer-key leak in saved prompts/runs', hits.length === 0 ? 'PASS' : 'FAIL', hits[0] ?? 'none');
}

async function checkReadme(): Promise<void> {
  try {
    const readme = await readFile(path.join(ROOT, 'README.md'), 'utf8');
    const scripts = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')).scripts as Record<string, string>;
    const used = [...readme.matchAll(/npm run ([a-z0-9:-]+)/g)].map((match) => match[1]);
    const missing = [...new Set(used)].filter((name) => !(name in scripts));
    add('README scripts exist', missing.length === 0 ? 'PASS' : 'FAIL', missing.join(', ') || 'all present');

    const stats = existsSync(path.join(ROOT, 'docs', 'STATS.md')) ? await readFile(path.join(ROOT, 'docs', 'STATS.md'), 'utf8') : '';
    const results = /## Results([\s\S]*?)(?=\n## |$)/.exec(readme)?.[1] ?? '';
    const numbers = [...new Set(results.matchAll(/\b\d+(?:\.\d+)?\b/g))].map((match) => match[0]);
    const missingNumbers = numbers.filter((number) => !stats.includes(number));
    add('README numbers in STATS.md', missingNumbers.length === 0 ? 'PASS' : 'FAIL', missingNumbers.join(', ') || `checked ${numbers.length}`);
  } catch (error) {
    add('README checks', 'FAIL', (error as Error).message.slice(0, 160));
  }
}

async function freshCloneCheck(): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'testpilot-fresh-'));
  try {
    const clone = await execa('git', ['clone', '--quiet', ROOT, dir], { reject: false });
    if (clone.exitCode !== 0) { add('fresh clone', 'FAIL', clone.stderr.slice(0, 160)); return; }
    const install = await execa('npm', ['ci', '--no-audit', '--no-fund', '--cache', path.join(tmpdir(), 'testpilot-npm-cache')], { cwd: dir, reject: false, timeout: 900_000 });
    if (install.exitCode !== 0) { add('fresh clone npm ci', 'FAIL', (install.stderr ?? '').slice(-200)); return; }
    add('fresh clone npm ci', 'PASS', 'ok');
    await run('fresh clone build', 'npx', ['tsc', '--noEmit'], dir, 300_000);
    await run('fresh clone offline demo', 'npx', ['tsx', 'scripts/demo.ts', '--fast', '--no-serve', '--no-color'], dir, 300_000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function checkDemoShop(): Promise<void> {
  const status = await execa('git', ['-C', REPO, 'status', '--short'], { reject: false });
  add('demo-shop clean', status.stdout.trim() ? 'FAIL' : 'PASS', status.stdout.trim() || 'clean');
  const list = await execa('git', ['-C', REPO, 'worktree', 'list', '--porcelain'], { reject: false });
  const count = list.stdout.split('\n').filter((line) => line.startsWith('worktree ')).length;
  add('demo-shop worktrees', count === 1 ? 'PASS' : 'FAIL', `${count} worktree(s)`);
  const branches = await execa('git', ['-C', REPO, 'branch', '--format=%(refname:short)'], { reject: false });
  const expected = ['main', 'bug/payment-concurrency', 'bug/user-lean', 'reference/regression-tests'];
  const current = branches.stdout.split('\n').map((line) => line.trim());
  add('demo-shop branches', expected.every((branch) => current.includes(branch)) ? 'PASS' : 'FAIL', current.join(', '));
}

async function main(): Promise<void> {
  await run('tsc', 'npx', ['tsc', '--noEmit']);
  await run('unit tests', 'npx', ['tsx', '--test', '--test-concurrency=1', 'src/generate/*.test.ts', 'src/runner/*.test.ts', 'src/repair/*.test.ts', 'src/store/*.test.ts', 'src/report/*.test.ts', 'src/mcp/*.test.ts']);
  await run('verification controls', 'npx', ['tsx', 'scripts/check-verification.ts']);
  await run('repair controls', 'npx', ['tsx', 'scripts/check-repair.ts']);
  await run('analysis controls', 'npx', ['tsx', 'scripts/check-analysis.ts']);
  await scanSecrets();
  await checkIgnoreRules();
  await checkAnswerKeyLeak();
  await checkReadme();
  await freshCloneCheck();
  await checkDemoShop();

  const widths = { check: Math.max(6, ...rows.map((row) => row.check.length)), detail: Math.max(6, ...rows.map((row) => row.detail.length)) };
  console.log(`\n${['Check'.padEnd(widths.check), 'Status'.padEnd(6), 'Detail'.padEnd(widths.detail)].join('  ')}`);
  console.log('-'.repeat(widths.check + widths.detail + 12));
  for (const row of rows) console.log([row.check.padEnd(widths.check), row.status.padEnd(6), row.detail.padEnd(widths.detail)].join('  '));

  const failed = rows.filter((row) => row.status === 'FAIL');
  console.log(`\n${rows.length - failed.length}/${rows.length} checks passed.`);

  const docs = [
    '# Final QA and security sweep',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    '| Check | Status | Detail |',
    '| --- | --- | --- |',
    ...rows.map((row) => `| ${row.check} | ${row.status} | ${row.detail.replace(/\|/g, '\\|')} |`),
    '',
    `${rows.length - failed.length}/${rows.length} checks passed.`
  ].join('\n');
  await mkdir(path.dirname(DOCS), { recursive: true });
  await writeFile(DOCS, `${docs}\n`, 'utf8');
  console.log(`Saved ${DOCS}`);

  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
