/**
 * Acceptance checks for the Alan integration: run store, reports, server, MCP.
 */
import { config } from 'dotenv';
config({ quiet: true });
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { importRunsFrom, isValidRunId, listRuns, runDir } from '../src/store/runs';
import { renderMarkdownReport } from '../src/report/markdown';
import { renderHtmlReport } from '../src/report/html';
import { startServer } from '../src/server';
import { listAvailableProviders } from '../src/llm/client';

const ROOT = path.resolve('.');
const REPO = path.resolve('../demo-shop');
const TOOL_NAMES = [
  'analyze_pull_request',
  'generate_regression_tests',
  'run_regression_tests',
  'repair_regression',
  'get_verification_report',
  'run_testpilot_loop',
  'get_run_status'
];
const DOCS = path.join(ROOT, 'docs', 'alan-integration.md');

interface Row { check: string; expected: string; actual: string; pass: boolean }
const rows: Row[] = [];
function check(name: string, expected: string, actual: string): void {
  rows.push({ check: name, expected, actual, pass: expected === actual });
}

async function noRepairFixture(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'alan-norepair-'));
  await mkdir(path.join(dir, '__testpilot__'), { recursive: true });
  await writeFile(path.join(dir, '__testpilot__/x.testpilot.test.ts'), 'it("x", () => expect(1).toBe(1));\n');
  await writeFile(path.join(dir, 'generation.json'), JSON.stringify({
    base: { ref: 'main', sha: 'a' }, head: { ref: 'bug/x', sha: 'b' }, provider: 'p', model: 'm',
    scenarios: [{ id: 's', title: 't', risk: 'r', evidence: [] }]
  }));
  await writeFile(path.join(dir, 'verification.json'), JSON.stringify({
    testFile: '__testpilot__/x.testpilot.test.ts', verdict: 'not_demonstrated_passes_both',
    confidence: 'high', reasons: [], fixedCheck: 'not_run',
    revisions: {
      base: { ref: 'main', sha: 'a', runs: [], consistentStatus: 'passed', stable: true, changedCodeEvidence: 'none', durationMs: 1 },
      head: { ref: 'bug/x', sha: 'b', runs: [], consistentStatus: 'passed', stable: true, changedCodeEvidence: 'none', durationMs: 1 }
    },
    existingSuite: { ran: true, passed: 1, failed: 0, total: 1 }, isolation: 'process',
    repeat: 1, timeoutMs: 1000, durationMs: 1, generatedAt: new Date().toISOString()
  }));
  return dir;
}

async function xssFixture(): Promise<string> {
  const dir = await noRepairFixture();
  const attack = '<script>alert(1)</script></pre><img src=x onerror=alert(1)>';
  await writeFile(path.join(dir, '__testpilot__/x.testpilot.test.ts'), attack);
  await writeFile(path.join(dir, 'generation.json'), JSON.stringify({
    base: { ref: 'main', sha: 'a' }, head: { ref: 'bug/x', sha: 'b' },
    scenarios: [{ id: 's', title: attack, risk: attack, evidence: [] }]
  }));
  return dir;
}

async function stdoutCleanliness(env: Record<string, string>): Promise<Row> {
  const child = spawn('npx', ['tsx', 'src/mcp/server.ts'], {
    cwd: ROOT,
    env,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let stdout = '';
  child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
  child.stdin?.write(JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'stdout-check', version: '1' } }
  }) + '\n');

  await new Promise((resolve) => setTimeout(resolve, 3_000));
  child.kill('SIGTERM');

  const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  const bad = lines.filter((line) => {
    try { return JSON.parse(line).jsonrpc !== '2.0'; } catch { return true; }
  });

  return {
    check: 'stdio stdout is JSON-RPC only',
    expected: '0 non-JSON lines',
    actual: `${bad.length} non-JSON line(s)`,
    pass: bad.length === 0
  };
}

async function main(): Promise<void> {
  const store = await mkdtemp(path.join(tmpdir(), 'alan-store-'));
  process.env.TESTPILOT_RUNS_DIR = store;
  process.env.TESTPILOT_ALLOWED_REPOS = REPO;

  const htmlFixtures: string[] = [];
  try {
    const imported = await importRunsFrom(path.join(ROOT, 'demo-artifacts'));
    check('import recorded runs', '2', String(imported.length));

    const byBranch = {
      payment: imported.find((run) => run.head === 'bug/payment-concurrency'),
      lean: imported.find((run) => run.head === 'bug/user-lean')
    };

    for (const [label, run] of Object.entries(byBranch)) {
      if (!run) { check(`${label} report`, 'present', 'missing'); continue; }
      const dir = runDir(run.runId);
      const md = await renderMarkdownReport(dir);
      const html = await renderHtmlReport(dir);
      check(`${label} md sections`, 'yes', ['## What changed', '## Verification evidence', '## Proposed fix'].every((h) => md.includes(h)) ? 'yes' : 'no');
      check(`${label} html banner`, 'amber', /banner (amber|green)/.test(html) ? 'amber' : 'none');
      check(`${label} fixed_by_revert`, 'yes', md.includes('fixed_by_revert') ? 'yes' : 'no');
    }

    const noRepair = await noRepairFixture();
    htmlFixtures.push(noRepair);
    const noRepairMd = await renderMarkdownReport(noRepair);
    check('no-repair state', 'not attempted', noRepairMd.includes('Repair was not attempted') ? 'not attempted' : 'missing');

    const xss = await xssFixture();
    htmlFixtures.push(xss);
    const xssHtml = await renderHtmlReport(xss);
    check('XSS escaped', 'escaped', xssHtml.includes('&lt;script&gt;alert(1)') && !xssHtml.includes('<script>alert(1)</script>') ? 'escaped' : 'raw');
    check('id traversal rejected', 'rejected', isValidRunId('../run-20260101-000000-aaaa') ? 'accepted' : 'rejected');

    const env = {
      ...process.env,
      TESTPILOT_RUNS_DIR: store,
      TESTPILOT_ALLOWED_REPOS: REPO
    } as Record<string, string>;

    const transport = new StdioClientTransport({
      command: 'npx', args: ['tsx', 'src/mcp/server.ts'], cwd: ROOT, env, stderr: 'pipe'
    });
    const client = new Client({ name: 'alan-acceptance', version: '1.0.0' });
    await client.connect(transport);

    try {
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name).sort();
      check('MCP tool names', TOOL_NAMES.slice().sort().join(','), names.join(','));
      check('MCP descriptions', 'all present', tools.tools.every((tool) => Boolean(tool.description)) ? 'all present' : 'missing');

      const report = await client.callTool({ name: 'get_verification_report', arguments: { runId: imported[0].runId } });
      check('MCP report call', 'ok', report.isError ? 'error' : 'ok');

      const invalid = [
        ['outside allowlist', await client.callTool({ name: 'analyze_pull_request', arguments: { repoPath: '/etc', base: 'main', head: 'main' } })],
        ['ref injection', await client.callTool({ name: 'analyze_pull_request', arguments: { repoPath: REPO, base: '--upload-pack=x', head: 'main' } })],
        ['missing run', await client.callTool({ name: 'get_run_status', arguments: { runId: 'run-00000000-000000-0000' } })]
      ] as const;
      for (const [label, result] of invalid) {
        check(`invalid input: ${label}`, 'clean error', result.isError ? 'clean error' : 'accepted');
      }

      const providers = listAvailableProviders();
      if (providers.length > 0) {
        const started = await client.callTool({ name: 'run_testpilot_loop', arguments: { repoPath: REPO, base: 'main', head: 'bug/payment-concurrency', provider: providers[0], maxScenarios: 1 } });
        const startedData = started.structuredContent as { runId?: string } | undefined;
        const runId = startedData?.runId;
        check('MCP loop started', 'running', runId ? 'running' : 'no run id');

        if (runId) {
          let status = 'running';
          for (let attempt = 0; attempt < 120 && status === 'running'; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 5_000));
            const poll = await client.callTool({ name: 'get_run_status', arguments: { runId } });
            status = String((poll.structuredContent as { status?: string } | undefined)?.status ?? 'unknown');
          }
          check('MCP loop finished', 'done', status);

          const final = await client.callTool({ name: 'get_verification_report', arguments: { runId } });
          check('MCP final report', 'ok', final.isError ? 'error' : 'ok');

          const server = await startServer({ port: 0, runsDir: store });
          try {
            const response = await fetch(`${server.url}/runs/${runId}`);
            check('served HTML for new run', '200', String(response.status));
          } finally {
            await server.close();
          }
        }
      } else {
        check('MCP live loop', 'skipped (no provider keys)', 'skipped');
      }
    } finally {
      await client.close();
    }

    rows.push(await stdoutCleanliness(env));
  } finally {
    for (const dir of htmlFixtures) await rm(dir, { recursive: true, force: true });
    await rm(store, { recursive: true, force: true });
    delete process.env.TESTPILOT_RUNS_DIR;
    delete process.env.TESTPILOT_ALLOWED_REPOS;
  }

  const widths = {
    check: Math.max(6, ...rows.map((row) => row.check.length)),
    expected: Math.max(8, ...rows.map((row) => row.expected.length)),
    actual: Math.max(6, ...rows.map((row) => row.actual.length))
  };
  const header = ['Check'.padEnd(widths.check), 'Expected'.padEnd(widths.expected), 'Actual'.padEnd(widths.actual), 'Result'].join('  ');
  console.log(`\n${header}`);
  console.log('-'.repeat(header.length));
  for (const row of rows) {
    console.log([row.check.padEnd(widths.check), row.expected.padEnd(widths.expected), row.actual.padEnd(widths.actual), row.pass ? 'PASS' : 'FAIL'].join('  '));
  }

  const failed = rows.filter((row) => !row.pass);
  console.log(`\n${rows.length - failed.length}/${rows.length} checks passed.`);

  await mkdir(path.dirname(DOCS), { recursive: true });
  const docs = [
    '# Alan integration checks',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    '| Check | Expected | Actual | Result |',
    '| --- | --- | --- | --- |',
    ...rows.map((row) => `| ${row.check} | ${row.expected} | ${row.actual} | ${row.pass ? 'PASS' : 'FAIL'} |`),
    '',
    `${rows.length - failed.length}/${rows.length} checks passed.`
  ].join('\n');
  await writeFile(DOCS, `${docs}\n`, 'utf8');
  console.log(`Saved ${DOCS}`);

  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
