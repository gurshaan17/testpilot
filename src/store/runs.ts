/**
 * Run store: every loop/run execution gets a validated id and an artifact
 * directory that a caller can poll and read.
 */
import { mkdir, readFile, readdir, rm, writeFile, cp } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { RUN_ID_PATTERN, RunIdSchema, RunRecordSchema, type RunRecord } from './schema';

export { RUN_ID_PATTERN };

export interface CreateRunOptions {
  repoPath: string;
  base: string;
  head: string;
  provider?: string;
  model?: string;
}

const ARTIFACT_NAME = /^[A-Za-z0-9._/-]+$/;

export function runsRoot(): string {
  return path.resolve(process.env.TESTPILOT_RUNS_DIR ?? path.join('out', 'runs'));
}

export function isValidRunId(runId: string): boolean {
  return RunIdSchema.safeParse(runId).success;
}

export function assertRunId(runId: string): string {
  if (!isValidRunId(runId)) {
    throw new Error(`Invalid run id: ${runId}`);
  }
  return runId;
}

export function runDir(runId: string): string {
  return path.join(runsRoot(), assertRunId(runId));
}

export function newRunId(now = new Date()): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  const stamp =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  const suffix = Math.floor(Math.random() * 0xffff)
    .toString(16)
    .padStart(4, '0');
  return `run-${stamp}-${suffix}`;
}

export async function createRun(options: CreateRunOptions): Promise<RunRecord> {
  const runId = newRunId();
  const dir = runDir(runId);
  await mkdir(dir, { recursive: true });

  const record: RunRecord = {
    runId,
    repoPath: path.resolve(options.repoPath),
    base: options.base,
    head: options.head,
    status: 'running',
    stage: 'created',
    startedAt: new Date().toISOString(),
    provider: options.provider,
    model: options.model
  };

  await writeRun(record);
  return record;
}

async function writeRun(record: RunRecord): Promise<void> {
  const dir = runDir(record.runId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'run.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

export async function updateRun(
  runId: string,
  patch: Partial<Omit<RunRecord, 'runId'>>
): Promise<RunRecord> {
  const current = await getRun(runId);
  const next = RunRecordSchema.parse({ ...current, ...patch, runId: current.runId });
  await writeRun(next);
  return next;
}

export async function getRun(runId: string): Promise<RunRecord> {
  const dir = runDir(runId);
  if (!existsSync(path.join(dir, 'run.json'))) {
    throw new Error(`Run not found: ${runId}`);
  }
  return RunRecordSchema.parse(JSON.parse(await readFile(path.join(dir, 'run.json'), 'utf8')));
}

export async function listRuns(): Promise<RunRecord[]> {
  const root = runsRoot();
  if (!existsSync(root)) return [];

  const entries = await readdir(root, { withFileTypes: true });
  const records: RunRecord[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidRunId(entry.name)) continue;
    try {
      records.push(await getRun(entry.name));
    } catch {
      // Ignore partially written runs.
    }
  }

  return records.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function artifactPath(runId: string, name: string): string {
  const normalized = name.split(path.sep).join('/');
  if (!ARTIFACT_NAME.test(normalized) || normalized.includes('..')) {
    throw new Error(`Invalid artifact name: ${name}`);
  }
  const dir = runDir(runId);
  const absolute = path.resolve(dir, normalized);
  if (!absolute.startsWith(`${dir}${path.sep}`)) {
    throw new Error(`Artifact escapes the run directory: ${name}`);
  }
  return absolute;
}

export async function readArtifact(runId: string, name: string): Promise<string> {
  const absolute = artifactPath(runId, name);
  if (!existsSync(absolute)) throw new Error(`Artifact not found: ${name}`);
  return readFile(absolute, 'utf8');
}

export function readArtifactSync(runId: string, name: string): string | undefined {
  try {
    const absolute = artifactPath(runId, name);
    return existsSync(absolute) ? readFileSync(absolute, 'utf8') : undefined;
  } catch {
    return undefined;
  }
}

function readJsonSync<T>(dir: string, name: string): T | undefined {
  try {
    const absolute = path.join(dir, name);
    return existsSync(absolute) ? (JSON.parse(readFileSync(absolute, 'utf8')) as T) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Imports recorded runs so the demo works with zero LLM calls.
 */
export async function importRunsFrom(sourceDir: string): Promise<RunRecord[]> {
  const source = path.resolve(sourceDir);
  if (!existsSync(source)) throw new Error(`No such directory: ${sourceDir}`);

  const entries = await readdir(source, { withFileTypes: true });
  const imported: RunRecord[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const from = path.join(source, entry.name);
    if (!existsSync(path.join(from, 'verification.json'))) continue;

    const generation = readJsonSync<Record<string, unknown>>(from, 'generation.json');
    const verification = readJsonSync<Record<string, unknown>>(from, 'verification.json');
    const repair = readJsonSync<Record<string, unknown>>(from, 'repair.json');
    const timeline = readJsonSync<{ base?: string; head?: string }>(from, 'timeline.json');

    const runId = newRunId();
    const dir = runDir(runId);
    await rm(dir, { recursive: true, force: true });
    await cp(from, dir, { recursive: true });

    const baseRef =
      (generation?.base as { ref?: string } | undefined)?.ref ??
      timeline?.base ??
      'main';
    const headRef =
      (generation?.head as { ref?: string } | undefined)?.ref ??
      timeline?.head ??
      entry.name;

    const record: RunRecord = {
      runId,
      repoPath: path.resolve((generation?.repo as string) ?? '../demo-shop'),
      base: baseRef,
      head: headRef,
      status: 'done',
      stage: 'imported',
      startedAt:
        (generation?.generatedAt as string) ??
        (repair?.generatedAt as string) ??
        new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      provider: (generation?.provider as string) ?? 'recorded',
      model: (generation?.model as string) ?? 'recorded',
      verdict: verification?.verdict as string | undefined,
      repairStatus: repair?.status as string | undefined
    };

    await writeRun(record);
    imported.push(record);
  }

  return imported;
}