/**
 * HTML report tests: required sections, verdict banners and XSS escaping.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { esc, renderHtmlReport } from './html';

interface Fixture {
  verdict: string;
  repairStatus?: string;
  testCode?: string;
  failure?: string;
  patch?: string;
}

async function fixture(input: Fixture): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'testpilot-html-'));
  await mkdir(path.join(dir, '__testpilot__'), { recursive: true });
  await writeFile(
    path.join(dir, '__testpilot__', 'x.testpilot.test.ts'),
    input.testCode ?? "import { getPublicProfile } from '../src/users/userProfileService';\n",
    'utf8'
  );
  await writeFile(
    path.join(dir, 'generation.json'),
    JSON.stringify({
      repo: '../demo-shop',
      base: { ref: 'main', sha: 'a'.repeat(40) },
      head: { ref: 'bug/user-lean', sha: 'b'.repeat(40) },
      provider: 'google',
      model: 'm',
      promptVersion: 'v2',
      scenarios: [{ id: 's', title: 'profile method', risk: 'lean objects lose methods', evidence: [] }]
    }),
    'utf8'
  );
  await writeFile(
    path.join(dir, 'verification.json'),
    JSON.stringify({
      testFile: '__testpilot__/x.testpilot.test.ts',
      verdict: input.verdict,
      confidence: 'medium',
      reasons: ['reason'],
      fixedCheck: 'not_run',
      revisions: {
        base: { ref: 'main', sha: 'a', runs: [], consistentStatus: 'passed', stable: true, changedCodeEvidence: 'none', durationMs: 1 },
        head: { ref: 'bug/user-lean', sha: 'b', runs: [{ status: 'failed', tests: [{ title: 't', fullName: 't', status: 'failed', failureMessages: [input.failure ?? 'TypeError: boom'], durationMs: 1 }], numPassed: 0, numFailed: 1, numTotal: 1, suiteFailedToRun: false, exitCode: 1, outputTail: '', failureLocation: { file: 'src/users/userProfileService.ts', line: 7 } }], consistentStatus: 'failed', stable: true, failureType: 'runtime-error', changedCodeEvidence: 'coverage-of-changed-lines', durationMs: 1 }
      },
      existingSuite: { ran: true, passed: 15, failed: 0, total: 15 },
      isolation: 'process',
      repeat: 3,
      timeoutMs: 1000,
      durationMs: 10,
      generatedAt: new Date().toISOString()
    }),
    'utf8'
  );

  if (input.repairStatus || input.patch) {
    await writeFile(
      path.join(dir, 'repair.json'),
      JSON.stringify({
        status: input.repairStatus ?? 'failed',
        reasons: [],
        attempts: [],
        patch: input.patch,
        filesTouched: ['src/users/userRepository.ts'],
        restoresBase: input.repairStatus === 'fixed_by_revert',
        preservesPrIntent: input.repairStatus === 'fixed',
        intentNote: '',
        provider: 'google',
        model: 'm',
        totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        durations: { totalMs: 5 },
        generatedAt: new Date().toISOString()
      }),
      'utf8'
    );
  }

  return dir;
}

test('esc escapes HTML metacharacters', () => {
  assert.equal(esc('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(esc('"a" & \'b\''), '&quot;a&quot; &amp; &#39;b&#39;');
});

test('html report has the required sections for a fixed_by_revert run', async () => {
  const dir = await fixture({ verdict: 'regression_caught', repairStatus: 'fixed_by_revert', patch: '-old\n+new' });
  try {
    const html = await renderHtmlReport(dir);
    for (const title of ['What changed', 'What could break', 'Evidence', 'Generated test', 'Proposed fix', 'Caveats', 'Timeline']) {
      assert.ok(html.includes(title), title);
    }
    assert.match(html, /Regression caught and fixed by reverting the change/);
    assert.match(html, /banner amber/);
    assert.match(html, /Content-Security-Policy/);
    assert.match(html, /prefers-color-scheme/);
    assert.ok(!/https?:\/\/(?!127\.0\.0\.1)/.test(html), 'no external requests');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('caught and fixed is green', async () => {
  const dir = await fixture({ verdict: 'regression_caught', repairStatus: 'fixed', patch: '-old\n+new' });
  try {
    const html = await renderHtmlReport(dir);
    assert.match(html, /Regression caught and fixed</);
    assert.match(html, /banner green/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('not demonstrated is grey', async () => {
  const dir = await fixture({ verdict: 'not_demonstrated_passes_both' });
  try {
    const html = await renderHtmlReport(dir);
    assert.match(html, /No regression demonstrated/);
    assert.match(html, /banner grey/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('untrusted code and failure output are escaped', async () => {
  const attack = '<script>alert(1)</script></pre><img src=x onerror=alert(1)>';
  const dir = await fixture({
    verdict: 'regression_caught',
    repairStatus: 'fixed',
    testCode: attack,
    failure: attack,
    patch: `-old\n+${attack}`
  });
  try {
    const html = await renderHtmlReport(dir);
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.ok(!html.includes('</pre><img src=x onerror=alert(1)>'));
    assert.match(html, /&lt;\/pre&gt;&lt;img src=x/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
