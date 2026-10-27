/**
 * Deterministic Markdown report built only from persisted artifacts.
 */
import { loadRun, type LoadedRun } from './artifacts';
import { bannerFor, isVerifiedFailure } from './vocab';
import { cell, excerpt, fence, formatMs, inline, shortSha } from './mdutil';

function revisionRow(
  label: string,
  revision: { consistentStatus: string; runs: number; failureType?: string; failureLocation?: { file: string; line: number } } | undefined
): string {
  if (!revision) return `| ${label} | not run | - | - | - |`;
  const location = revision.failureLocation
    ? `${revision.failureLocation.file}:${revision.failureLocation.line}`
    : '-';
  return [
    `| ${label}`,
    cell(revision.consistentStatus),
    String(revision.runs),
    cell(revision.failureType),
    cell(location)
  ].join(' | ') + ' |';
}

function whatChanged(run: LoadedRun): string {
  const lines = [
    '## What changed',
    '',
    `- base: ${inline(run.generation?.base?.ref)} (${shortSha(run.generation?.base?.sha)})`,
    `- head: ${inline(run.generation?.head?.ref)} (${shortSha(run.generation?.head?.sha)})`,
    ''
  ];

  if (!run.analysis) {
    lines.push('_The analysis artifact is not stored for this run; changed functions are not available._');
    return lines.join('\n');
  }

  if (run.analysis.changedFunctions.length > 0) {
    lines.push('| Function | File | Lines |', '| --- | --- | --- |');
    for (const fn of run.analysis.changedFunctions) {
      lines.push(
        `| ${cell(fn.qualifiedName)} | ${cell(fn.file)} | ${fn.startLine}-${fn.endLine} |`
      );
    }
    lines.push('');
  }

  if (run.analysis.changedFiles.length > 0) {
    lines.push('| File | Status |', '| --- | --- |');
    for (const file of run.analysis.changedFiles) {
      lines.push(`| ${cell(file.path)} | ${cell(file.status)} |`);
    }
  }

  return lines.join('\n');
}

function coverageGap(run: LoadedRun): string {
  const lines = ['## Coverage gap', ''];
  if (!run.analysis) {
    lines.push('_No analysis artifact; coverage data is not available._');
    return lines.join('\n');
  }

  const callers = run.analysis.callersWithoutTests.map((node) => node.qualifiedName);
  const covering = run.analysis.changedFunctions[0]?.coveringTests ?? [];

  lines.push(
    `- callers without tests: ${callers.length > 0 ? callers.map((name) => inline(name)).join(', ') : 'none'}`,
    `- existing covering tests: ${covering.length > 0 ? covering.map((name) => inline(name)).join(', ') : 'none'}`
  );
  return lines.join('\n');
}

function risk(run: LoadedRun): string {
  const scenario = run.scenario;
  const lines = ['## What could break', ''];
  if (!scenario) {
    lines.push('_No scenario artifact recorded._');
    return lines.join('\n');
  }

  lines.push(
    `**Scenario:** ${scenario.title ?? 'untitled'}`,
    '',
    scenario.risk ?? '_No risk description._',
    '',
    `- kind: ${inline(scenario.kind, 'unknown')}`,
    `- severity: ${inline(scenario.severity, 'unknown')}`
  );

  if (scenario.evidence && scenario.evidence.length > 0) {
    lines.push('', '| Evidence | Note |', '| --- | --- |');
    for (const item of scenario.evidence) {
      lines.push(`| ${cell(`${item.file}:${item.line}`)} | ${cell(item.note)} |`);
    }
  }

  return lines.join('\n');
}

function verification(run: LoadedRun): string {
  const v = run.verification;
  const lines = ['## Verification evidence', ''];
  if (!v) {
    lines.push('_Verification did not run for this run._');
    return lines.join('\n');
  }

  lines.push(
    '| Revision | Status | Stable runs | Failure type | Failure location |',
    '| --- | --- | --- | --- | --- |',
    revisionRow('base', {
      consistentStatus: v.revisions.base.consistentStatus,
      runs: v.revisions.base.runs.length,
      failureType: v.revisions.base.failureType,
      failureLocation: v.revisions.base.failureLocation
    }),
    revisionRow('head', {
      consistentStatus: v.revisions.head.consistentStatus,
      runs: v.revisions.head.runs.length,
      failureType: v.revisions.head.failureType,
      failureLocation: v.revisions.head.failureLocation
    }),
    revisionRow(
      'fixed',
      run.fixedSummary ??
        (v.revisions.fixed
          ? {
              consistentStatus: v.revisions.fixed.consistentStatus,
              runs: v.revisions.fixed.runs.length,
              failureType: v.revisions.fixed.failureType,
              failureLocation: v.revisions.fixed.failureLocation
            }
          : undefined)
    )
  );

  const headFailure = v.revisions.head.runs
    .flatMap((runResult) => runResult.tests)
    .find((test) => test.failureMessages.length > 0)?.failureMessages[0];

  if (headFailure) {
    lines.push('', 'First lines of the head failure:', '', fence(excerpt(headFailure), 'text'));
  }

  const suite = v.existingSuite;
  lines.push(
    '',
    suite.ran
      ? `Existing suite on head: **${suite.passed}/${suite.total} passed**, ${suite.failed} failed.`
      : 'Existing suite on head: **not available**.'
  );

  return lines.join('\n');
}

function proposedFix(run: LoadedRun): string {
  const repair = run.repair;
  const lines = ['## Proposed fix', ''];

  if (!repair) {
    lines.push('_Repair was not attempted for this run._');
    return lines.join('\n');
  }

  const attempt = run.repairAttempt;
  if (attempt?.proposal?.diagnosis) lines.push(attempt.proposal.diagnosis, '');

  if (run.fixPatch) {
    lines.push(fence(run.fixPatch, 'diff'));
  } else {
    lines.push('_No patch was produced._');
  }

  if (repair.status === 'fixed' || repair.status === 'fixed_by_revert') {
    const suite = run.fixedExistingSuite;
    lines.push(
      '',
      `- repair status: ${inline(repair.status)}`,
      `- restoresBase: **${repair.restoresBase}** (${repair.restoresBase ? 'the fix reverts the change' : 'the fix keeps a changed implementation'})`,
      `- preservesPrIntent: **${repair.preservesPrIntent}**${repair.intentNote ? ` - ${repair.intentNote}` : ''}`,
      `- proof: test passes on the patched code; existing suite ${suite ? `${suite.passed}/${suite.total} green` : 'not recorded'}`
    );
  } else {
    lines.push('', `- repair status: ${inline(repair.status)} - no verified fix.`);
  }

  if (run.guards.length > 0) {
    lines.push('', '| Guard | Result | Reason |', '| --- | --- | --- |');
    for (const guard of run.guards) {
      lines.push(`| ${cell(guard.name)} | ${guard.ok ? 'pass' : 'fail'} | ${cell(guard.reason)} |`);
    }
  }

  return lines.join('\n');
}

function caveats(run: LoadedRun): string {
  const verificationResult = run.verification;
  const banner = bannerFor({
    verdict: verificationResult?.verdict,
    repairStatus: run.repair?.status
  });
  const lines = [
    '## Confidence and caveats',
    '',
    `- confidence: ${inline(verificationResult?.confidence, 'unknown')}`,
    `- isolation: ${inline(verificationResult?.isolation ?? run.run?.status, 'unknown')}`,
    `- report state: ${inline(banner.state)}`
  ];

  if (isVerifiedFailure(verificationResult?.verdict)) {
    lines.push('- **Verified failure:** the regression test fails on head in changed code.');
  } else {
    lines.push(
      '- **Potential risk only:** this run did not verify a regression, so treat the scenario as a risk to review rather than a confirmed failure.'
    );
  }

  if (run.repair?.status === 'fixed_by_revert') {
    lines.push(
      '- **The fix reverts the change.** The PR intent was not preserved; say so in the PR summary.'
    );
  }
  if (verificationResult?.verdict === 'regression_caught_suspect') {
    lines.push('- **Suspect result:** a human should review why the head failure occurred.');
  }
  if (verificationResult && verificationResult.verdict !== 'regression_caught') {
    lines.push('- No verified fix can be claimed for a non-`regression_caught` verdict.');
  }
  if (!run.analysis) {
    lines.push('- The analysis artifact is missing, so changed-code claims are limited.');
  }

  for (const reason of verificationResult?.reasons ?? []) lines.push(`- ${reason}`);
  return lines.join('\n');
}

function timeline(run: LoadedRun): string {
  const lines = ['## Timeline', ''];
  const events = run.timeline?.events ?? [];
  if (events.length === 0) {
    lines.push('_No timeline recorded._');
  } else {
    lines.push('| Stage | Status | Duration |', '| --- | --- | --- |');
    for (const event of events) {
      lines.push(`| ${cell(event.stage)} | ${cell(event.status)} | ${formatMs(event.durationMs)} |`);
    }
  }

  const generation = run.generation;
  lines.push(
    '',
    `- provider/model: ${inline(generation?.provider)} / ${inline(generation?.model)}`,
    `- prompt version: ${inline(generation?.promptVersion)}`,
    `- total tokens: ${generation?.totalUsage?.totalTokens ?? 0} generation + ${run.repair?.totalUsage.totalTokens ?? 0} repair`
  );
  return lines.join('\n');
}

export async function renderMarkdownReport(runDir: string): Promise<string> {
  const run = await loadRun(runDir);
  const banner = bannerFor({
    verdict: run.verification?.verdict,
    repairStatus: run.repair?.status
  });

  const header = [
    '# TestPilot report',
    '',
    `> **${banner.title}**`,
    '',
    `- run: ${inline(run.runId ?? run.run?.runId)}`,
    `- repo: ${inline(run.run?.repoPath ?? run.generation?.repo)}`,
    `- generated: ${inline(run.verification?.generatedAt ?? run.run?.finishedAt)}`
  ].join('\n');

  const test = run.testCode
    ? ['## Generated regression test', '', fence(run.testCode, 'ts')].join('\n')
    : ['## Generated regression test', '', '_No generated test artifact recorded._'].join('\n');

  return [
    header,
    whatChanged(run),
    risk(run),
    coverageGap(run),
    test,
    verification(run),
    proposedFix(run),
    caveats(run),
    timeline(run)
  ].join('\n\n');
}

/**
 * Compact PR-comment version: verdict, one paragraph, evidence, patch.
 */
export async function renderPrComment(runDir: string): Promise<string> {
  const run = await loadRun(runDir);
  const banner = bannerFor({
    verdict: run.verification?.verdict,
    repairStatus: run.repair?.status
  });
  const verificationResult = run.verification;
  const scenario = run.scenario;

  const summary = [
    `**${banner.title}.**`,
    scenario?.title ? `Scenario: ${scenario.title}.` : '',
    verificationResult
      ? `Base ${verificationResult.revisions.base.consistentStatus}, head ${verificationResult.revisions.head.consistentStatus}.`
      : '',
    run.repair?.status === 'fixed_by_revert'
      ? 'The fix reverts the change; the PR intent is not preserved.'
      : run.repair?.status === 'fixed'
        ? 'The fix keeps the change intent and the regression test passes.'
        : ''
  ]
    .filter(Boolean)
    .join(' ');

  const evidence = verificationResult?.revisions.head.runs
    .flatMap((entry) => entry.tests)
    .find((test) => test.failureMessages.length > 0)?.failureMessages[0];

  const details = run.fixPatch
    ? `<details><summary>Proposed fix</summary>\n\n${fence(run.fixPatch, 'diff')}\n\n</details>`
    : '';

  return [
    `## TestPilot: ${banner.title}`,
    '',
    summary,
    '',
    evidence ? fence(excerpt(evidence, 6), 'text') : '',
    '',
    details,
    '',
    `Run: ${inline(run.runId ?? run.run?.runId)} · confidence ${inline(verificationResult?.confidence, 'unknown')} · ${banner.state}`
  ]
    .filter((line) => line !== '')
    .join('\n');
}