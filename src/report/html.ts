/**
 * Self-contained HTML report. Every repo/LLM-derived value goes through esc();
 * no external requests, no frameworks, no build step.
 */
import { loadRun } from './artifacts';
import { bannerFor } from './vocab';
import { formatMs, shortSha } from './mdutil';

export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function diffHtml(patch: string): string {
  return patch
    .split('\n')
    .map((line) => {
      const cls = line.startsWith('+') && !line.startsWith('+++')
        ? 'add'
        : line.startsWith('-') && !line.startsWith('---')
          ? 'del'
          : line.startsWith('@@')
            ? 'hunk'
            : '';
      return `<span class="${cls}">${esc(line)}</span>`;
    })
    .join('\n');
}

function card(title: string, body: string, id?: string): string {
  return `<section class="card"${id ? ` id="${esc(id)}"` : ''}><h2>${esc(title)}</h2>${body}</section>`;
}

function chip(status: string | undefined): string {
  const value = status ?? 'not run';
  const tone = value === 'passed' ? 'ok' : value === 'failed' ? 'bad' : 'muted';
  return `<span class="chip ${tone}">${esc(value)}</span>`;
}

function notRun(what: string): string {
  return `<p class="muted">${esc(what)} was not run for this run.</p>`;
}

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f7f9;--fg:#16181d;--card:#fff;--muted:#5b6472;--line:#dfe3e8;--green:#0f7a3d;--amber:#9a5b00;--grey:#5b6472;--add:#e6f4ea;--del:#fdecea}
@media (prefers-color-scheme:dark){:root{--bg:#0f1216;--fg:#e8ebef;--card:#171b21;--muted:#9aa4b2;--line:#2a313a;--green:#5cd18f;--amber:#f0b35a;--grey:#9aa4b2;--add:#12301f;--del:#3a1717}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:960px;margin:0 auto;padding:24px 16px 64px}
header.top{display:flex;flex-wrap:wrap;gap:12px;align-items:baseline;justify-content:space-between;border-bottom:1px solid var(--line);padding-bottom:16px}
h1{font-size:28px;margin:0}h2{font-size:19px;margin:0 0 12px}h3{font-size:15px;margin:16px 0 6px}
.muted{color:var(--muted)}.mono,code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.banner{margin:20px 0;padding:14px 16px;border-radius:10px;border:2px solid;font-weight:600}
.banner.green{border-color:var(--green);color:var(--green)}.banner.amber{border-color:var(--amber);color:var(--amber)}.banner.grey{border-color:var(--grey);color:var(--grey)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px;margin:16px 0}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:8px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-weight:600;color:var(--muted)}
.chip{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:600;border:1px solid}
.chip.ok{color:var(--green);border-color:var(--green)}.chip.bad{color:#b3261e;border-color:#b3261e}.chip.muted{color:var(--muted);border-color:var(--line)}
pre{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:12px;overflow:auto;font-size:13px;max-height:460px}
pre span{display:block;white-space:pre-wrap}pre span.add{background:var(--add)}pre span.del{background:var(--del)}pre span.hunk{color:var(--muted)}
.stepper{display:flex;gap:8px;flex-wrap:wrap;list-style:none;padding:0;margin:18px 0}
.stepper li{flex:1 1 140px;border:1px solid var(--line);border-radius:8px;padding:10px;font-size:14px;background:var(--card)}
.stepper li.done{border-color:var(--green)}.stepper .step-state{display:block;font-size:12px;color:var(--muted)}
.actions{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}
button,.button{font:inherit;font-size:14px;padding:6px 12px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer;text-decoration:none}
details summary{cursor:pointer;color:var(--muted)}
.timeline{list-style:none;padding:0;margin:0}.timeline li{display:grid;grid-template-columns:160px 1fr 70px;gap:10px;align-items:center;font-size:13px;margin:6px 0}
.bar{height:10px;border-radius:999px;background:var(--green);min-width:2px}
footer{margin-top:24px;border-top:1px solid var(--line);padding-top:12px;font-size:13px;color:var(--muted)}
@media (max-width:560px){.timeline li{grid-template-columns:100px 1fr 60px}h1{font-size:22px}}
`;

export async function renderHtmlReport(runDir: string): Promise<string> {
  const run = await loadRun(runDir);
  const banner = bannerFor({
    verdict: run.verification?.verdict,
    repairStatus: run.repair?.status
  });
  const verification = run.verification;
  const analysis = run.analysis;
  const scenario = run.scenario;
  const repair = run.repair;
  const attempt = run.repairAttempt;
  const running = run.run?.status === 'running';

  const baseRef = run.generation?.base?.ref ?? run.run?.base ?? 'unknown';
  const headRef = run.generation?.head?.ref ?? run.run?.head ?? 'unknown';
  const baseSha = shortSha(run.generation?.base?.sha);
  const headSha = shortSha(run.generation?.head?.sha);

  const changeBody = analysis
    ? [
        analysis.changedFunctions.length
          ? `<table><thead><tr><th>Function</th><th>File</th><th>Lines</th></tr></thead><tbody>${analysis.changedFunctions
              .map(
                (fn) =>
                  `<tr><td class="mono">${esc(fn.qualifiedName)}</td><td class="mono">${esc(fn.file)}</td><td>${fn.startLine}-${fn.endLine}</td></tr>`
              )
              .join('')}</tbody></table>`
          : '<p class="muted">No changed functions recorded.</p>',
        analysis.changedFiles.length
          ? `<h3>Changed files</h3><ul>${analysis.changedFiles
              .map((file) => `<li class="mono">${esc(file.path)} <span class="muted">(${esc(file.status)})</span></li>`)
              .join('')}</ul>`
          : ''
      ].join('')
    : '<p class="muted">Analysis artifact is not stored for this run.</p>';

  const riskBody = scenario
    ? `<p><strong>${esc(scenario.title)}</strong></p><p>${esc(scenario.risk)}</p>` +
      (scenario.evidence?.length
        ? `<h3>Evidence lines</h3><ul>${scenario.evidence
            .map((item) => `<li class="mono">${esc(item.file)}:${esc(item.line)} <span class="muted">${esc(item.note)}</span></li>`)
            .join('')}</ul>`
        : '')
    : '<p class="muted">No scenario recorded.</p>';

  const fixed = run.fixedSummary;
  const evidenceBody = verification
    ? `<table><thead><tr><th>Revision</th><th>Status</th><th>Stable runs</th><th>Failure type</th><th>Failure location</th></tr></thead><tbody>
<tr><td>base</td><td>${chip(verification.revisions.base.consistentStatus)}</td><td>${verification.revisions.base.runs.length}</td><td>${esc(verification.revisions.base.failureType ?? '-')}</td><td class="mono">${esc(verification.revisions.base.failureLocation ? `${verification.revisions.base.failureLocation.file}:${verification.revisions.base.failureLocation.line}` : '-')}</td></tr>
<tr><td>head</td><td>${chip(verification.revisions.head.consistentStatus)}</td><td>${verification.revisions.head.runs.length}</td><td>${esc(verification.revisions.head.failureType ?? '-')}</td><td class="mono">${esc(verification.revisions.head.failureLocation ? `${verification.revisions.head.failureLocation.file}:${verification.revisions.head.failureLocation.line}` : '-')}</td></tr>
<tr><td>fixed</td><td>${chip(fixed?.consistentStatus)}</td><td>${fixed ? fixed.runs : '-'}</td><td>${esc(fixed?.failureType ?? '-')}</td><td class="mono">${esc(fixed?.failureLocation ? `${fixed.failureLocation.file}:${fixed.failureLocation.line}` : '-')}</td></tr>
</tbody></table>
<p>Existing suite on head: <strong>${verification.existingSuite.passed}/${verification.existingSuite.total}</strong> passed, ${verification.existingSuite.failed} failed.</p>
<details><summary>Head failure output</summary><pre>${esc(
      verification.revisions.head.runs
        .flatMap((entry) => entry.tests)
        .find((test) => test.failureMessages.length > 0)?.failureMessages[0] ?? 'No failure output recorded.'
    )}</pre></details>`
    : notRun('Verification');

  const testBody = run.testCode
    ? `<div class="actions"><button class="copy" data-target="test-code" type="button">Copy test</button></div><pre id="test-code">${esc(run.testCode)}</pre>`
    : notRun('Test generation');

  const fixDownload = run.fixPatch
    ? `<a class="button" download="fix.patch" href="data:text/plain;charset=utf-8,${encodeURIComponent(run.fixPatch)}">Download fix.patch</a>`
    : '';
  const fixBody = repair
    ? `<p>${esc(attempt?.proposal?.diagnosis ?? 'No diagnosis recorded.')}</p>
<div class="actions"><button class="copy" data-target="fix-diff" type="button">Copy diff</button>${fixDownload}</div>
${run.fixPatch ? `<pre id="fix-diff">${diffHtml(run.fixPatch)}</pre>` : '<p class="muted">No patch produced.</p>'}
<ul>
<li>repair status: <strong>${esc(repair.status)}</strong></li>
<li>restoresBase: <strong>${repair.restoresBase}</strong></li>
<li>preservesPrIntent: <strong>${repair.preservesPrIntent}</strong>${repair.intentNote ? ` - ${esc(repair.intentNote)}` : ''}</li>
<li>proof: ${run.fixedExistingSuite ? `test passes on patched code; existing suite ${run.fixedExistingSuite.passed}/${run.fixedExistingSuite.total} green` : 'not recorded'}</li>
</ul>
${run.guards.length ? `<table><thead><tr><th>Guard</th><th>Result</th><th>Reason</th></tr></thead><tbody>${run.guards
      .map((guard) => `<tr><td>${esc(guard.name)}</td><td>${guard.ok ? 'pass' : 'fail'}</td><td>${esc(guard.reason)}</td></tr>`)
      .join('')}</tbody></table>` : ''}`
    : notRun('Repair');

  const caveatBody = `<ul>
<li>confidence: <strong>${esc(verification?.confidence ?? 'unknown')}</strong></li>
<li>isolation: <strong>${esc(verification?.isolation ?? 'unknown')}</strong></li>
<li>${verification?.verdict === 'regression_caught' ? '<strong>Verified failure:</strong> the test fails on head in changed code.' : '<strong>Potential risk only:</strong> no regression was verified.'}</li>
${repair?.status === 'fixed_by_revert' ? '<li><strong>The fix reverts the change;</strong> the PR intent was not preserved.</li>' : ''}
${verification?.verdict === 'regression_caught_suspect' ? '<li><strong>Suspect result:</strong> human review needed.</li>' : ''}
${(verification?.reasons ?? []).map((reason) => `<li>${esc(reason)}</li>`).join('')}
</ul>`;

  const events = run.timeline?.events ?? [];
  const maxMs = Math.max(1, ...events.map((event) => event.durationMs));
  const timelineBody = events.length
    ? `<ul class="timeline">${events
        .map(
          (event) =>
            `<li><span class="mono">${esc(event.stage)}</span><span class="bar" style="width:${Math.round((event.durationMs / maxMs) * 100)}%"></span><span>${esc(formatMs(event.durationMs))}</span></li>`
        )
        .join('')}</ul>`
    : '<p class="muted">No timeline recorded.</p>';

  const steps: { label: string; done: boolean }[] = [
    { label: 'Change', done: Boolean(analysis) },
    { label: 'Risk', done: Boolean(scenario) },
    { label: 'Evidence', done: Boolean(verification) },
    { label: 'Fix', done: repair?.status === 'fixed' || repair?.status === 'fixed_by_revert' }
  ];

  const stepper = `<ol class="stepper">${steps
    .map(
      (step) =>
        `<li class="${step.done ? 'done' : ''}">${esc(step.label)}<span class="step-state">${step.done ? 'verified' : 'not run'}</span></li>`
    )
    .join('')}</ol>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">
${running ? '<meta http-equiv="refresh" content="2">' : ''}
<title>TestPilot report ${esc(headRef)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<header class="top">
<div><h1>TestPilot</h1><p class="muted mono">${esc(baseRef)} (${esc(baseSha)}) &rarr; ${esc(headRef)} (${esc(headSha)})</p></div>
<div class="mono muted">${esc(run.runId ?? run.run?.runId ?? 'unrecorded')}${running ? `<br>stage: ${esc(run.run?.stage ?? 'running')}` : ''}</div>
</header>
<div class="banner ${banner.tone}">${esc(banner.title)}</div>
${stepper}
${card('What changed', changeBody)}
${card('What could break', riskBody)}
${card('Evidence', evidenceBody)}
${card('Generated test', testBody)}
${card('Proposed fix', fixBody)}
${card('Caveats', caveatBody)}
${card('Timeline', timelineBody)}
<footer>provider/model: ${esc(run.generation?.provider ?? 'n/a')} / ${esc(run.generation?.model ?? 'n/a')} &middot; prompt ${esc(run.generation?.promptVersion ?? 'n/a')} &middot; generated ${esc(verification?.generatedAt ?? run.run?.finishedAt ?? 'n/a')} &middot; tokens ${esc(run.generation?.totalUsage?.totalTokens ?? 0)} + ${esc(repair?.totalUsage.totalTokens ?? 0)}</footer>
</main>
<script>
document.querySelectorAll('.copy').forEach(function (button) {
  button.addEventListener('click', async function () {
    var target = document.getElementById(button.dataset.target);
    if (!target) return;
    try {
      await navigator.clipboard.writeText(target.textContent || '');
      button.textContent = 'Copied';
    } catch (error) {
      button.textContent = 'Copy failed';
    }
  });
});
</script>
</body>
</html>`;
}