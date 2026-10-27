/**
 * Markdown report tests: sections, banner and untrusted text handling.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { renderMarkdownReport, renderPrComment } from './markdown';

const repoArtifacts = path.resolve('demo-artifacts');

test('markdown report contains the required sections and banner', async () => {
  const report = await renderMarkdownReport(path.join(repoArtifacts, 'bug-user-lean'));

  assert.match(report, /^# TestPilot report/m);
  assert.match(report, /\*\*Regression caught and fixed by reverting the change\*\*/);
  for (const heading of [
    '## What changed',
    '## What could break',
    '## Coverage gap',
    '## Generated regression test',
    '## Verification evidence',
    '## Proposed fix',
    '## Confidence and caveats',
    '## Timeline'
  ]) {
    assert.ok(report.includes(heading), heading);
  }
  assert.match(report, /\| fixed \[?\|? passed/);
  assert.match(report, /fixed_by_revert/);
});

test('comment format is compact and includes the verdict', async () => {
  const comment = await renderPrComment(path.join(repoArtifacts, 'bug-payment-concurrency'));
  assert.match(comment, /## TestPilot: Regression caught/);
  assert.match(comment, /<details>/);
});

test('untrusted test code is fenced, not interpolated into headings', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'testpilot-md-'));
  try {
    const malicious = 'const x = "</pre><img src=x onerror=alert(1)>";\nconst y = ```;\n<script>alert(1)</script>';
    await mkdir(path.join(dir, '__testpilot__'), { recursive: true });
    await writeFile(path.join(dir, '__testpilot__', 'testpilot.test.ts'), malicious, 'utf8');
    await writeFile(
      path.join(dir, 'generation.json'),
      JSON.stringify({
        base: { ref: 'main', sha: 'a' },
        head: { ref: 'bug/x', sha: 'b' },
        provider: 'p',
        model: 'm',
        promptVersion: 'v2',
        scenarios: [{ id: 'x', title: '</h2><script>alert(1)</script>', risk: 'risk', evidence: [] }]
      }),
      'utf8'
    );
    await writeFile(
      path.join(dir, 'verification.json'),
      JSON.stringify({
        testFile: '__testpilot__/testpilot.test.ts',
        verdict: 'regression_caught',
        confidence: 'medium',
        reasons: [],
        fixedCheck: 'not_run',
        revisions: {
          base: { ref: 'main', sha: 'a', runs: [], consistentStatus: 'passed', stable: true, changedCodeEvidence: 'none', durationMs: 1 },
          head: { ref: 'bug/x', sha: 'b', runs: [], consistentStatus: 'failed', stable: false, changedCodeEvidence: 'none', durationMs: 1 }
        },
        existingSuite: { ran: true, passed: 1, failed: 0, total: 1 },
        isolation: 'process',
        repeat: 1,
        timeoutMs: 1000,
        durationMs: 10,
        generatedAt: new Date().toISOString()
      }),
      'utf8'
    );

    const report = await renderMarkdownReport(dir);
    assert.ok(report.includes('</h2><script>alert(1)</script>'));
    assert.ok(report.includes('````'));
    assert.ok(!report.includes('## </h2>'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
