/**
 * Replays a recorded loop run from demo-artifacts with realistic pacing.
 * `--live` runs the real loop instead (requires provider credentials).
 */
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';

const ROOT = path.resolve('.');
const ARTIFACTS = path.join(ROOT, 'demo-artifacts');
const REPO = path.resolve('../demo-shop');

interface Options {
  live: boolean;
  branch?: string;
  speed: number;
}

function parseArgs(argv: string[]): Options {
  const branchIndex = argv.indexOf('--branch');
  const speedIndex = argv.indexOf('--speed');
  return {
    live: argv.includes('--live'),
    branch: branchIndex >= 0 ? argv[branchIndex + 1] : undefined,
    speed: speedIndex >= 0 ? Number(argv[speedIndex + 1]) || 1 : 1
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function replay(branchDir: string, speed: number): Promise<void> {
  const transcript = await readFile(path.join(branchDir, 'transcript.txt'), 'utf8');
  const delay = Math.max(0, Math.round(140 / speed));

  for (const line of transcript.split('\n')) {
    console.log(line);
    if (line.trim() && delay > 0) await sleep(delay);
  }

  const patchPath = path.join(branchDir, 'fix.patch');
  if (existsSync(patchPath)) {
    console.log('');
    console.log('--- fix.patch ---');
    console.log(await readFile(patchPath, 'utf8'));
    await sleep(delay * 4);
  }

  const verificationPath = path.join(branchDir, 'verification.json');
  if (existsSync(verificationPath)) {
    const verification = JSON.parse(await readFile(verificationPath, 'utf8'));
    console.log(
      `verdict: ${verification.verdict} (${verification.confidence}); ` +
        `base=${verification.revisions.base.consistentStatus} ` +
        `head=${verification.revisions.head.consistentStatus}`
    );
  }
}

async function runLive(branch: string): Promise<void> {
  const head = branch.startsWith('bug/') ? branch : branch;
  console.log(`Running the live loop for ${head}...`);
  await execa(
    'npx',
    ['tsx', 'src/cli.ts', 'loop', '--repo', REPO, '--base', 'main',
      '--head', head, '--max-scenarios', '1', '--out', 'out/demo'],
    { cwd: ROOT, stdio: 'inherit' }
  );
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (!existsSync(ARTIFACTS)) {
    console.error('No demo-artifacts/ directory found. Run `npm run e2e-loop` first.');
    process.exitCode = 1;
    return;
  }

  const branches = (
    await readdir(ARTIFACTS, { withFileTypes: true })
  )
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !options.branch || name === options.branch)
    .sort();

  if (branches.length === 0) {
    console.error(`No recorded branch matched "${options.branch}".`);
    process.exitCode = 1;
    return;
  }

  for (const branch of branches) {
    console.log(`\n=== Replaying recorded run: ${branch} ===\n`);
    if (options.live) {
      await runLive(branch);
    } else {
      await replay(path.join(ARTIFACTS, branch), options.speed);
    }
  }
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
