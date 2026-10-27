/**
 * CLI output and argument helpers.
 */
import { z } from 'zod';
import type { AnalysisReport, ImpactNode } from './analysis/schema';
import type { GenerationRun } from './generate/engine';
import {
  generateStructured,
  listAvailableProviders,
  providerEnvKey,
  resolveModel,
  type ProviderName
} from './llm/client';

const PROVIDER_NAMES: ProviderName[] = ['anthropic', 'openai', 'google'];

export function callersOf(changedId: string, report: AnalysisReport): ImpactNode[] {
  const nodes = new Map(report.impactGraph.nodes.map((node) => [node.id, node]));
  const found = new Map<string, ImpactNode>();

  let frontier = [changedId];
  for (let depth = 0; depth < 2; depth += 1) {
    const next: string[] = [];
    for (const edge of report.impactGraph.edges) {
      if (!frontier.includes(edge.to)) continue;
      const caller = nodes.get(edge.from);
      if (caller && !found.has(caller.id)) {
        found.set(caller.id, caller);
        next.push(caller.id);
      }
    }
    frontier = next;
  }

  return [...found.values()].sort((a, b) => a.depth - b.depth || a.name.localeCompare(b.name));
}

export function parseProvider(value?: string): ProviderName | undefined {
  if (!value) return undefined;
  if (value === 'anthropic' || value === 'openai' || value === 'google') return value;
  throw new Error(`Unknown provider "${value}". Use anthropic, openai, or google.`);
}

export function parseMaxScenarios(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3) {
    throw new Error('--max-scenarios must be an integer from 1 to 3');
  }
  return parsed;
}

export function printGenerationSummary(run: GenerationRun): void {
  console.log('Test generation');
  console.log(`  output: ${run.outDir}`);
  console.log(`  provider/model: ${run.provider || 'unknown'} / ${run.model || 'unknown'}`);
  console.log(`  prompt version: ${run.promptVersion}`);
  console.log(`  scenarios: ${run.scenarios.length}`);

  for (const scenario of run.scenarios) {
    const attempts = scenario.attempts.length;
    const headPreview = scenario.headPreview
      ? `  head preview: ${scenario.headPreview.passed ? 'PASS' : 'FAIL'} (informational)`
      : '';
    if (scenario.status === 'valid') {
      console.log(
        `  [valid] ${scenario.title} (${attempts} attempt(s)) -> ${scenario.fileName}`
      );
      console.log(headPreview);
    } else {
      const reason = (scenario.finalError ?? 'unknown error').split('\n')[0].slice(0, 200);
      console.log(
        `  [invalid] ${scenario.title} (${attempts} attempt(s)): ${reason}`
      );
    }
  }

  if (run.scenarios.every((scenario) => scenario.status !== 'valid')) {
    console.log('  No valid tests were produced.');
  }
  console.log(`  generation log: ${run.generationPath}`);
}

export function printSummary(report: AnalysisReport): void {
  const baselineFailures = report.baseline.failures.length;

  console.log('TestPilot analysis');
  console.log(`  repo: ${report.repo}`);
  console.log(`  base: ${report.base.ref} (${report.base.sha.slice(0, 8)})`);
  console.log(`  head: ${report.head.ref} (${report.head.sha.slice(0, 8)})`);
  console.log(
    `  baseline: ${report.baseline.testFiles.length} test files, ` +
      `${baselineFailures} failing`
  );

  console.log(`\nChanged files (${report.changedFiles.length})`);
  for (const file of report.changedFiles) {
    const ranges = file.changedLineRanges
      .map((range) => `${range.start}-${range.end}`)
      .join(', ');
    console.log(`  ${file.status.padEnd(8)} ${file.path}${ranges ? ` (${ranges})` : ''}`);
  }

  console.log(`\nChanged functions (${report.changedFunctions.length})`);
  for (const fn of report.changedFunctions) {
    console.log(`  ${fn.qualifiedName}  ${fn.file}:${fn.startLine}-${fn.endLine}`);
    console.log(
      `    changed lines: ${fn.changedLineCoverage.percentage}% covered` +
        (fn.changedLineCoverage.uncoveredLines.length > 0
          ? ` (uncovered: ${fn.changedLineCoverage.uncoveredLines.join(', ')})`
          : '')
    );
    console.log(
      `    covering tests: ${fn.coveringTests.length > 0 ? fn.coveringTests.join(', ') : 'none'}`
    );

    const callers = callersOf(
      `${fn.qualifiedName}::${fn.file}`,
      report
    );
    if (callers.length === 0) {
      console.log('    callers: none found');
    } else {
      console.log('    callers:');
      for (const caller of callers) {
        const tests =
          caller.coveringTests.length > 0 ? caller.coveringTests.join(', ') : 'NONE';
        console.log(
          `      [depth ${caller.depth}] ${caller.qualifiedName} ` +
            `${caller.file}:${caller.startLine}  tests: ${tests}`
        );
      }
    }
  }

  if (report.otherChanges.length > 0) {
    console.log(`\nChanges outside functions (${report.otherChanges.length})`);
    for (const change of report.otherChanges) {
      console.log(`  ${change.file}:${change.range.start}-${change.range.end}`);
    }
  }

  console.log(`\n${'='.repeat(64)}`);
  if (report.callersWithoutTests.length === 0) {
    console.log('No untested callers found.');
  } else {
    console.log(`!! CALLERS WITHOUT TESTS (${report.callersWithoutTests.length})`);
    for (const node of report.callersWithoutTests) {
      console.log(
        `!! [depth ${node.depth}] ${node.qualifiedName}  ${node.file}:${node.startLine}`
      );
    }
  }
  console.log('='.repeat(64));

  if (report.unresolvedReferences.length > 0) {
    console.log(`\nUnresolved references (${report.unresolvedReferences.length})`);
    for (const ref of report.unresolvedReferences) {
      console.log(`  ${ref.from}: ${ref.file}:${ref.line} - ${ref.reason}`);
    }
  }

  if (baselineFailures > 0) {
    console.log('\nBaseline failures:');
    for (const failure of report.baseline.failures) {
      console.log(`  ${failure.file}`);
    }
  }
}

export async function runLlmCheck(requested: string): Promise<void> {
  const providers: ProviderName[] =
    requested === 'all'
      ? PROVIDER_NAMES
      : PROVIDER_NAMES.includes(requested as ProviderName)
        ? [requested as ProviderName]
        : [];

  if (providers.length === 0) {
    throw new Error(`Unknown provider "${requested}". Use anthropic, openai, google, or all.`);
  }

  const available = listAvailableProviders();
  let failed = false;

  console.log('Provider   Model                          Latency   Result');
  console.log('---------  -----------------------------  --------  ------');

  for (const provider of providers) {
    if (!available.includes(provider)) {
      console.log(
        `${provider.padEnd(9)}  ${'-'.padEnd(29)}  ${'-'.padEnd(8)}  ` +
          `SKIPPED (${providerEnvKey(provider)} not set)`
      );
      continue;
    }

    const startedAt = Date.now();
    const resolved = resolveModel(provider);
    try {
      const result = await generateStructured({
        provider,
        model: resolved.modelId,
        system: 'You are a connectivity check. Answer with JSON only.',
        prompt: 'Reply with the word ok',
        schema: z.object({ answer: z.string() }),
        temperature: 0
      });
      const latency = Date.now() - startedAt;
      console.log(
        `${provider.padEnd(9)}  ${result.model.padEnd(29)}  ` +
          `${`${latency}ms`.padEnd(8)}  PASS`
      );
    } catch (error) {
      const latency = Date.now() - startedAt;
      failed = true;
      console.log(
        `${provider.padEnd(9)}  ${resolved.modelId.padEnd(29)}  ${`${latency}ms`.padEnd(8)}  FAIL: ` +
          `${(error as Error).message}`
      );
    }
  }

  if (failed) process.exitCode = 1;
}
