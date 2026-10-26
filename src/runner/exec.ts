/**
 * Hardened process execution for repository code.
 *
 * Every child gets a minimal environment: PATH, a temporary HOME, TMPDIR,
 * NODE_ENV=test and CI=true. Nothing else is inherited, so provider API keys
 * and tokens are never visible to code under test.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execa } from 'execa';

export type Isolation = 'process' | 'docker';

export interface RunSandboxedOptions {
  cwd: string;
  command: string;
  args: string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
  docker?: boolean;
  dockerImage?: string;
  /** Extra environment entries, used only for non-secret wiring. */
  env?: Record<string, string>;
  /** Host directories mounted read-write into the container. */
  mounts?: { host: string; container: string }[];
}

export interface SandboxResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
  isolation: Isolation;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const KILL_GRACE_MS = 2_000;
const DOCKER_IMAGE = 'node:22';
const DOCKER_MEMORY = '512m';
const DOCKER_CPUS = '1';

let dockerUsable: boolean | undefined;

export async function isDockerAvailable(): Promise<boolean> {
  if (dockerUsable !== undefined) return dockerUsable;
  try {
    const result = await execa('docker', ['info'], { reject: false, timeout: 10_000 });
    dockerUsable = result.exitCode === 0;
  } catch {
    dockerUsable = false;
  }
  return dockerUsable;
}

/**
 * The child environment. Provider credentials are intentionally absent so a
 * test can never read or exfiltrate them.
 */
export async function buildChildEnv(
  homeDir: string,
  extra: Record<string, string> = {}
): Promise<Record<string, string>> {
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: homeDir,
    TMPDIR: tmpdir(),
    NODE_ENV: 'test',
    CI: 'true',
    ...extra
  };
}

function appendCapped(
  current: string,
  chunk: Buffer,
  maxBytes: number,
  state: { truncated: boolean }
): string {
  let next = current + chunk.toString('utf8');
  if (Buffer.byteLength(next, 'utf8') > maxBytes) {
    state.truncated = true;
    const buffer = Buffer.from(next, 'utf8');
    // Keep the tail: the end of the output carries the failure detail.
    next = buffer.subarray(Math.max(0, buffer.length - maxBytes)).toString('utf8');
  }
  return next;
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The group is already gone.
    }
  }
}

async function runProcess(
  options: RunSandboxedOptions,
  env: Record<string, string>
): Promise<SandboxResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const startedAt = Date.now();

  return new Promise<SandboxResult>((resolve) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env,
      // Own process group so a timeout can kill every descendant.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    const state = { truncated: false };
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killGroup(child.pid, 'SIGTERM');
      killTimer = setTimeout(() => {
        if (child.pid) killGroup(child.pid, 'SIGKILL');
      }, KILL_GRACE_MS);
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = appendCapped(stdout, chunk, maxOutputBytes, state);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = appendCapped(stderr, chunk, maxOutputBytes, state);
    });

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        exitCode,
        signal,
        timedOut,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        truncated: state.truncated,
        isolation: 'process'
      });
    };

    child.on('error', (error) => {
      stderr = appendCapped(stderr, Buffer.from(String(error)), maxOutputBytes, state);
      finish(null, null);
    });

    child.on('close', (code, signal) => {
      finish(code, signal);
    });
  });
}

async function runDocker(
  options: RunSandboxedOptions,
  env: Record<string, string>
): Promise<SandboxResult | undefined> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const startedAt = Date.now();

  const dockerArgs = [
    'run',
    '--rm',
    '--network',
    'none',
    '--memory',
    DOCKER_MEMORY,
    '--cpus',
    DOCKER_CPUS,
    '-w',
    options.cwd
  ];

  for (const mount of options.mounts ?? []) {
    dockerArgs.push('-v', `${mount.host}:${mount.container}`);
  }

  for (const [key, value] of Object.entries(env)) {
    if (key === 'PATH' || key === 'HOME' || key === 'TMPDIR') continue;
    dockerArgs.push('-e', `${key}=${value}`);
  }

  dockerArgs.push(options.dockerImage ?? DOCKER_IMAGE, options.command, ...options.args);

  const result = await execa('docker', dockerArgs, {
    cwd: options.cwd,
    reject: false,
    timeout: timeoutMs,
    env,
    maxBuffer: maxOutputBytes
  });

  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const timedOut = result.timedOut === true;

  return {
    exitCode: result.exitCode ?? null,
    signal: (result.signal as NodeJS.Signals | undefined) ?? null,
    timedOut,
    stdout,
    stderr,
    durationMs: Date.now() - startedAt,
    truncated: stdout.length > maxOutputBytes || stderr.length > maxOutputBytes,
    isolation: 'docker'
  };
}

export async function runSandboxed(
  options: RunSandboxedOptions
): Promise<SandboxResult> {
  const homeDir = await mkdtemp(path.join(tmpdir(), 'testpilot-home-'));

  try {
    const env = await buildChildEnv(homeDir, options.env);

    if (options.docker && (await isDockerAvailable())) {
      const dockerResult = await runDocker(options, env);
      if (dockerResult) return dockerResult;
    }

    return await runProcess(options, env);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}
