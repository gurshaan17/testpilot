/**
 * Reporting helpers for the generation acceptance harness.
 */
import { providerEnvKey, type ProviderName } from '../src/llm/client';

export interface RunRecord {
  run: number;
  status: 'valid' | 'invalid' | 'error';
  attempts: number;
  headPreview: 'pass' | 'fail' | 'none';
  targetsReference: 'same-behavior' | 'different-behavior' | 'n/a';
  title: string;
  fileName: string;
  error: string;
}

export interface ProviderResult {
  branch: string;
  provider: ProviderName;
  runs: RunRecord[];
  validRate: number;
  avgAttempts: number;
  caughtOnHeadRate: number;
  caughtOnHead: number;
  validCount: number;
  targetMet: boolean;
  skippedReason?: string;
}

export interface ReferenceNote {
  branch: string;
  file: string;
  available: boolean;
  sameBehaviorRuns: number;
  note: string;
}

export function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function printTable(results: ProviderResult[]): void {
  const header = [
    'Branch'.padEnd(25),
    'Provider'.padEnd(10),
    'Runs'.padEnd(4),
    'Valid'.padEnd(7),
    'Avg att'.padEnd(7),
    'Caught on head'.padEnd(16),
    'Target'
  ].join('  ');

  console.log(`\n${header}`);
  console.log('-'.repeat(header.length));
  for (const result of results) {
    if (result.skippedReason) {
      console.log(
        [
          result.branch.padEnd(25),
          result.provider.padEnd(10),
          '-'.padEnd(4),
          '-'.padEnd(7),
          '-'.padEnd(7),
          '-'.padEnd(16),
          'SKIPPED'
        ].join('  ')
      );
      continue;
    }

    console.log(
      [
        result.branch.padEnd(25),
        result.provider.padEnd(10),
        String(result.runs.length).padEnd(4),
        percent(result.validRate).padEnd(7),
        result.avgAttempts.toFixed(1).padEnd(7),
        `${result.caughtOnHead}/${result.validCount} (${percent(result.caughtOnHeadRate)})`.padEnd(16),
        result.targetMet ? 'MET' : 'NOT MET'
      ].join('  ')
    );
  }
}

export function referenceNote(
  branch: string,
  file: string,
  reference: string | null,
  runs: RunRecord[]
): ReferenceNote {
  const same = runs.filter((run) => run.targetsReference === 'same-behavior').length;
  return {
    branch,
    file,
    available: reference !== null,
    sameBehaviorRuns: same,
    note:
      reference === null
        ? 'reference branch/file unavailable'
        : runs.length === 0
          ? 'reference available; no generated runs to compare'
          : `${same} run(s) targeted the same behavior by heuristic keyword comparison`
  };
}

export function renderDocs(params: {
  available: ProviderName[];
  skipped: ProviderName[];
  results: ProviderResult[];
  references: ReferenceNote[];
  liveTargetsMet: boolean;
}): string {
  const liveResults = params.results.filter((result) => !result.skippedReason);
  const tableRows = params.results
    .map((result) => {
      if (result.skippedReason) {
        return `| ${result.branch} | ${result.provider} | - | n/a | n/a | n/a | SKIPPED (${result.skippedReason}) |`;
      }
      return `| ${result.branch} | ${result.provider} | ${result.runs.length} | ${percent(result.validRate)} | ${result.avgAttempts.toFixed(1)} | ${result.caughtOnHead}/${result.validCount} (${percent(result.caughtOnHeadRate)}) | ${result.targetMet ? 'MET' : 'NOT MET'} |`;
    })
    .join('\n');

  const referenceRows = params.references
    .map(
      (note) =>
        `| ${note.branch} | \`${note.file}\` | ${note.available ? 'available' : 'missing'} | ${note.note} |`
    )
    .join('\n');

  return `# Test generation results

Generated: ${new Date().toISOString()}

## Status

${
  params.available.length === 0
    ? `**Blocked: no provider API keys are configured.** Skipped: ${params.skipped
        .map((provider) => `${provider} (${providerEnvKey(provider)})`)
        .join(', ')}. No live generation runs were executed, so the 2/3 valid and caught-on-head targets remain unverified.`
    : params.liveTargetsMet
      ? '**Live targets met.**'
      : '**Live targets not met.** See per-run details and improvement rounds below.'
}

The validation loop itself was exercised on both bug branches with deterministic canned candidates by \`npm test\`; the base checks passed and the head previews failed for both planted regressions.

## Results

| Branch | Provider | Runs | Valid rate | Avg attempts | Caught on head | Target |
| --- | --- | ---: | ---: | ---: | ---: | --- |
${tableRows}

## Reference comparison

Reference tests were read only for this comparison; they were never passed to an LLM.

| Branch | Reference file | Availability | Note |
| --- | --- | --- | --- |
${referenceRows}

## Per-run details

${
  liveResults.length === 0
    ? 'No live runs (no provider keys).'
    : liveResults
        .map(
          (result) =>
            `### ${result.branch} / ${result.provider}\n\n` +
            result.runs
              .map(
                (run) =>
                  `- run ${run.run}: ${run.status}, attempts=${run.attempts}, head=${run.headPreview}, reference=${run.targetsReference}${run.title ? `, scenario="${run.title}"` : ''}${run.error ? `, error=${run.error.split('\n')[0]}` : ''}`
              )
              .join('\n')
        )
        .join('\n\n')
}

## Improvement rounds

${
  params.available.length === 0
    ? 'Round 1: not run. No prompt changes were made because there were no provider credentials to measure a before/after.'
    : 'Round 1: initial prompts and context pack. See the table above for current numbers.'
}
`;
}
