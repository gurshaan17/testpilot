/**
 * Unit tests for the run store and id/path validation.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createRun,
  getRun,
  importRunsFrom,
  isValidRunId,
  listRuns,
  newRunId,
  readArtifact,
  RUN_ID_PATTERN,
  updateRun
} from './runs';

test('generated run ids match the required pattern', () => {
  const runId = newRunId(new Date('2026-10-27T12:34:56Z'));
  assert.match(runId, RUN_ID_PATTERN);
  assert.match(runId, /^run-20261027-123456-[0-9a-f]{4}$/);
});

test('traversal-style ids are rejected', () => {
  for (const bad of ['../run-20260101-000000-aaaa', 'run-../../x', '/etc/passwd', 'run-2026', '']) {
    assert.equal(isValidRunId(bad), false, bad);
  }
  assert.equal(isValidRunId('run-20260101-000000-abcd'), true);
});

test('create, update, get and list round-trip', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'testpilot-runs-'));
  process.env.TESTPILOT_RUNS_DIR = dir;

  try {
    const created = await createRun({ repoPath: '../demo-shop', base: 'main', head: 'bug/user-lean' });
    assert.equal(created.status, 'running');
    assert.equal(created.stage, 'created');

    await updateRun(created.runId, { stage: 'verify', verdict: 'regression_caught' });
    const fetched = await getRun(created.runId);
    assert.equal(fetched.stage, 'verify');
    assert.equal(fetched.verdict, 'regression_caught');

    await updateRun(created.runId, { status: 'done', stage: 'complete' });
    const runs = await listRuns();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'done');
  } finally {
    await rm(dir, { recursive: true, force: true });
    delete process.env.TESTPILOT_RUNS_DIR;
  }
});

test('artifact reads reject traversal names', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'testpilot-runs-'));
  process.env.TESTPILOT_RUNS_DIR = dir;

  try {
    const run = await createRun({ repoPath: '../demo-shop', base: 'main', head: 'main' });
    await assert.rejects(() => readArtifact(run.runId, '../run.json'), /Invalid artifact name/);
    await assert.rejects(() => readArtifact(run.runId, 'a/../../x'), /Invalid artifact name/);
    await writeFile(path.join(dir, run.runId, 'fix.patch'), 'diff', 'utf8');
    assert.equal(await readArtifact(run.runId, 'fix.patch'), 'diff');
  } finally {
    await rm(dir, { recursive: true, force: true });
    delete process.env.TESTPILOT_RUNS_DIR;
  }
});

test('imports recorded artifact directories', async () => {
  const runs = await mkdtemp(path.join(tmpdir(), 'testpilot-runs-'));
  const source = await mkdtemp(path.join(tmpdir(), 'testpilot-recorded-'));
  process.env.TESTPILOT_RUNS_DIR = runs;

  try {
    const recorded = path.join(source, 'bug-user-lean');
    await mkdir(recorded, { recursive: true });
    await writeFile(
      path.join(recorded, 'generation.json'),
      JSON.stringify({ repo: '../demo-shop', base: { ref: 'main', sha: 'a' }, head: { ref: 'bug/user-lean', sha: 'b' }, provider: 'google', model: 'm' }),
      'utf8'
    );
    await writeFile(path.join(recorded, 'verification.json'), JSON.stringify({ verdict: 'regression_caught' }), 'utf8');
    await writeFile(path.join(recorded, 'repair.json'), JSON.stringify({ status: 'fixed_by_revert' }), 'utf8');

    const imported = await importRunsFrom(source);
    assert.equal(imported.length, 1);
    assert.equal(imported[0].verdict, 'regression_caught');
    assert.equal(imported[0].repairStatus, 'fixed_by_revert');
    assert.equal(imported[0].head, 'bug/user-lean');

    const listed = await listRuns();
    assert.equal(listed.length, 1);
  } finally {
    await rm(runs, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
    delete process.env.TESTPILOT_RUNS_DIR;
  }
});
