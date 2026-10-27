/**
 * Minimal localhost-only report server. No external requests, no frameworks.
 */
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { getRun, isValidRunId, listRuns, readArtifact, runDir } from './store/runs';
import { renderHtmlReport, esc } from './report/html';
import { renderMarkdownReport } from './report/markdown';

export interface ServeOptions {
  port?: number;
  runsDir?: string;
  host?: string;
}

export interface RunningServer {
  server: Server;
  url: string;
  close: () => Promise<void>;
}

const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:";

function send(res: import('node:http').ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, {
    'Content-Type': type,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function text(res: import('node:http').ServerResponse, status: number, body: string): void {
  send(res, status, 'text/plain; charset=utf-8', body);
}

function html(res: import('node:http').ServerResponse, body: string): void {
  res.setHeader('Content-Security-Policy', CSP);
  send(res, 200, 'text/html; charset=utf-8', body);
}

async function indexPage(): Promise<string> {
  const runs = await listRuns();
  const rows = runs
    .map(
      (run) => `<tr>
<td class="mono"><a href="/runs/${esc(run.runId)}">${esc(run.runId)}</a></td>
<td class="mono">${esc(run.head)}</td>
<td>${esc(run.verdict ?? '-')}</td>
<td>${esc(run.repairStatus ?? '-')}</td>
<td>${esc(run.status)}</td>
<td>${esc(run.startedAt)}</td>
</tr>`
    )
    .join('\n');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>TestPilot runs</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:960px;margin:32px auto;padding:0 16px;color-scheme:light dark}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:8px;border-bottom:1px solid #8884}
.mono{font-family:ui-monospace,Menlo,monospace}a{color:inherit}</style></head>
<body><h1>TestPilot runs</h1>
${runs.length === 0 ? '<p>No runs yet. Run <code>testpilot runs import demo-artifacts</code>.</p>' : `<table><thead><tr><th>Run</th><th>Head</th><th>Verdict</th><th>Repair</th><th>Status</th><th>Started</th></tr></thead><tbody>${rows}</tbody></table>`}
</body></html>`;
}

export async function startServer(options: ServeOptions = {}): Promise<RunningServer> {
  if (options.runsDir) process.env.TESTPILOT_RUNS_DIR = path.resolve(options.runsDir);

  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 4317;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}:${port}`);

    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        text(res, 405, 'Method not allowed');
        return;
      }

      if (url.pathname === '/') {
        html(res, await indexPage());
        return;
      }

      const match = /^\/runs\/([^/]+)(?:\/([^/]+))?$/.exec(url.pathname);
      if (!match) {
        text(res, 404, 'Not found');
        return;
      }

      const runId = decodeURIComponent(match[1]);
      if (!isValidRunId(runId)) {
        text(res, 404, 'Not found');
        return;
      }

      const artifact = match[2] ? decodeURIComponent(match[2]) : undefined;
      const dir = runDir(runId);

      if (!artifact) {
        try {
          await getRun(runId);
        } catch {
          text(res, 404, `Run not found: ${runId}`);
          return;
        }
        html(res, await renderHtmlReport(dir));
        return;
      }

      if (artifact === 'report.md') {
        text(res, 200, await renderMarkdownReport(dir));
        return;
      }

      if (artifact === 'fix.patch' || artifact === 'run.json') {
        text(res, 200, await readArtifact(runId, artifact));
        return;
      }

      text(res, 404, 'Not found');
    } catch (error) {
      text(res, 404, (error as Error).message);
    }
  });

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;

  return {
    server,
    url: `http://${host}:${actualPort}`,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}
