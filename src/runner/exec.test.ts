/**
 * Unit tests for the sandboxed executor.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runSandboxed } from './exec';

test('child process never sees provider keys or tokens', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test-secret';
  process.env.OPENAI_API_KEY = 'sk-test-secret-2';
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'test-secret-3';
  process.env.GITHUB_TOKEN = 'ghp-test-secret';
  process.env.MY_CUSTOM_TOKEN = 'custom-secret';

  const result = await runSandboxed({
    cwd: process.cwd(),
    command: process.execPath,
    args: ['-e', 'console.log(JSON.stringify(process.env))'],
    timeoutMs: 20_000
  });

  const childEnv = JSON.parse(result.stdout) as Record<string, string>;
  const visible = Object.keys(childEnv).filter((key) =>
    /API_KEY|TOKEN|SECRET|PASSWORD/i.test(key)
  );

  assert.deepEqual(visible, []);
  assert.equal(childEnv.ANTHROPIC_API_KEY, undefined);
  assert.equal(childEnv.GITHUB_TOKEN, undefined);
  assert.equal(childEnv.NODE_ENV, 'test');
  assert.equal(childEnv.CI, 'true');
  assert.ok(childEnv.PATH);
  assert.ok(childEnv.HOME);
  assert.notEqual(childEnv.HOME, process.env.HOME);

  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  delete process.env.GITHUB_TOKEN;
  delete process.env.MY_CUSTOM_TOKEN;
});

test('output is capped and marked truncated', async () => {
  const result = await runSandboxed({
    cwd: process.cwd(),
    command: process.execPath,
    args: ['-e', 'for (let i = 0; i < 5000; i++) console.log("x".repeat(100));'],
    timeoutMs: 20_000,
    maxOutputBytes: 4096
  });

  assert.equal(result.truncated, true);
  assert.ok(result.stdout.length <= 4096);
  assert.equal(result.exitCode, 0);
});

test('timeout kills the whole process group', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'testpilot-kill-'));
  const marker = path.join(dir, 'ticks.txt');
  const script = `
    const fs = require('node:fs');
    setInterval(() => fs.appendFileSync(${JSON.stringify(marker)}, 'x'), 50);
  `;

  try {
    const result = await runSandboxed({
      cwd: dir,
      command: process.execPath,
      args: ['-e', script],
      timeoutMs: 1_500
    });

    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, null);
    assert.ok(result.signal);

    const sizeAfterKill = (await stat(marker)).size;
    await new Promise((resolve) => setTimeout(resolve, 500));
    const sizeLater = (await stat(marker)).size;

    assert.equal(sizeLater, sizeAfterKill, 'the child kept running after the timeout');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('non-zero exit codes are reported', async () => {
  const result = await runSandboxed({
    cwd: process.cwd(),
    command: process.execPath,
    args: ['-e', 'process.exit(3)'],
    timeoutMs: 20_000
  });

  assert.equal(result.exitCode, 3);
  assert.equal(result.timedOut, false);
  assert.equal(result.isolation, 'process');
});
