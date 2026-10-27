/**
 * Collects only numbers that already exist in committed docs/artifacts.
 * No estimates, no rounding up. Each metric carries its source and n.
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve('.');
const DOCS = path.join(ROOT, 'docs');

interface Metric {
  metric: string;
  value: string | number;
  numerator?: number;
  denominator?: number;
  n: number;
  source: string;
  note?: string;
}

async function read(name: string): Promise<string> {
  const file = path.join(DOCS, name);
  if (!existsSync(file)) throw new Error(`Missing source: docs/${name}`);
  return readFile(file, 'utf8');
}

function controlCount(text: string, source: string): Metric {
  const match = /(\d+)\/(\d+)[^\n]*? passed/.exec(text);
  if (!match) throw new Error(`No control count in ${source}`);
  return {
    metric: `${source} controls passed`,
    value: `${match[1]}/${match[2]}`,
    numerator: Number(match[1]),
    denominator: Number(match[2]),
    n: Number(match[2]),
    source: `docs/${source}`
  };
}

function tableRows(text: string): string[][] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('| ') && !line.startsWith('| ---') && !line.startsWith('| Control') && !line.startsWith('| Branch'))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
}

function mainLoopMetrics(text: string): Metric[] {
  const metrics: Metric[] = [];
  const summary = /caught (\d+)\/(\d+), fixed (\d+), fixed_by_revert (\d+), avg attempts ([\d.]+), tokens (\d+)/.exec(text);
  if (!summary) throw new Error('No loop summary in docs/loop-results.md');

  const [caught, total, fixed, reverted, attempts, tokens] = summary.slice(1).map(Number);
  metrics.push({ metric: 'regression_caught', value: `${caught}/${total}`, numerator: caught, denominator: total, n: total, source: 'docs/loop-results.md' });
  metrics.push({ metric: 'fixed', value: fixed, numerator: fixed, denominator: total, n: total, source: 'docs/loop-results.md' });
  metrics.push({ metric: 'fixed_by_revert', value: reverted, numerator: reverted, denominator: total, n: total, source: 'docs/loop-results.md' });
  metrics.push({ metric: 'average repair attempts', value: attempts, n: total, source: 'docs/loop-results.md' });
  metrics.push({ metric: 'total tokens across runs', value: tokens, n: total, source: 'docs/loop-results.md' });

  // The run and stage tables are inside ```text blocks with space-aligned columns.
  const runLines = text
    .split('\n')
    .filter((line) => /^bug\//.test(line.trim()))
    .map((line) => line.trim().split(/\s+/));
  if (runLines.length > 0) {
    metrics.push({
      metric: 'tokens per run',
      value: runLines.map((row) => Number(row[5])).join(', '),
      n: runLines.length,
      source: 'docs/loop-results.md'
    });
  }

  const stageSection = /## Wall-clock time per stage([\s\S]*?)(?=\n## |$)/.exec(text)?.[1] ?? '';
  for (const line of stageSection.split('\n')) {
    const row = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line.trim());
    if (!row) continue;
    metrics.push({
      metric: `average ${row[1]} wall-clock`,
      value: `${row[3]} ms`,
      n: Number(row[2]),
      source: 'docs/loop-results.md'
    });
  }

  return metrics;
}

async function main(): Promise<void> {
  const verificationControls = await read('verification-controls.md');
  const repairControls = await read('repair-controls.md');
  const alan = await read('alan-integration.md');
  const loop = await read('loop-results.md');
  const e2eVerification = await read('e2e-verification-results.md');
  const generation = await read('generation-results.md');

  const metrics: Metric[] = [];

  metrics.push(controlCount(verificationControls, 'verification-controls.md'));
  metrics.push(controlCount(repairControls, 'repair-controls.md'));
  metrics.push(controlCount(alan, 'alan-integration.md'));

  const repairRows = tableRows(repairControls);
  const guardRejections = repairRows.filter((row) => row[2] === 'rejected').length;
  const patchFailures = repairRows.filter((row) => row[2] === 'patch_failed').length;
  metrics.push({
    metric: 'repair guard rejection controls',
    value: guardRejections,
    numerator: guardRejections,
    denominator: repairRows.length,
    n: repairRows.length,
    source: 'docs/repair-controls.md'
  });
  metrics.push({
    metric: 'patch_failed controls',
    value: patchFailures,
    numerator: patchFailures,
    denominator: repairRows.length,
    n: repairRows.length,
    source: 'docs/repair-controls.md'
  });

  metrics.push(...mainLoopMetrics(loop));

  const validMatch = /regression_caught\D+(\d+)\/(\d+) runs \((\d+) valid generated tests\)/.exec(e2eVerification);
  if (validMatch) {
    metrics.push({
      metric: 'valid generated tests',
      value: `${validMatch[3]}/${validMatch[2]}`,
      numerator: Number(validMatch[3]),
      denominator: Number(validMatch[2]),
      n: Number(validMatch[2]),
      source: 'docs/e2e-verification-results.md'
    });
  }

  const generationRuns = /No live generation runs were executed/.test(generation);
  metrics.push({
    metric: 'generation acceptance run',
    value: generationRuns ? 'blocked at the time (no provider keys)' : 'ran',
    n: 0,
    source: 'docs/generation-results.md',
    note: generationRuns ? 'Superseded by the later live loop runs; recorded here for honesty.' : undefined
  });

  const payload = { generatedAt: new Date().toISOString(), metrics };
  await writeFile(path.join(DOCS, 'stats.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  const lines = [
    '# TestPilot stats',
    '',
    `Generated: ${payload.generatedAt}`,
    '',
    'Every number below is copied from a committed document. `n` is the number of runs or controls behind it.',
    '',
    '| Metric | Value | n | Source | Note |',
    '| --- | --- | ---: | --- | --- |',
    ...metrics.map(
      (metric) =>
        `| ${metric.metric} | ${metric.value} | ${metric.n} | ${metric.source} | ${metric.note ?? ''} |`
    ),
    ''
  ];
  await writeFile(path.join(DOCS, 'STATS.md'), lines.join('\n'), 'utf8');
  console.log(`Wrote ${metrics.length} metrics to docs/stats.json and docs/STATS.md`);
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
