#!/usr/bin/env node
/**
 * TestPilot CLI: deterministic analysis plus an optional LLM connectivity check.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Command } from 'commander';
import { config } from 'dotenv';
import { z } from 'zod';
import { analyzeRepo } from './analysis/analyze';
import { generateTests, type GenerationRun } from './generate/engine';
import { verifyTest } from './runner/verify';
import { runLoop } from './loop';
import {
  parseMaxScenarios,
  parseProvider,
  printGenerationSummary,
  printSummary,
  runLlmCheck
} from './cliHelpers';
import {
  parsePositiveInt,
  printVerificationSummary,
  readGeneratedDirectory,
  verifyGeneratedRun,
  writeVerification
} from './runner/verifyOutput';
import type { VerificationResult } from './runner/schema';
import {
  AnalysisReportSchema,
  type AnalysisReport,
  type ImpactNode
} from './analysis/schema';
import {
  generateStructured,
  listAvailableProviders,
  providerEnvKey,
  resolveModel,
  type ProviderName
} from './llm/client';

config({ quiet: true });

const PROVIDER_NAMES: ProviderName[] = ['anthropic', 'openai', 'google'];

const program = new Command();
program
  .name('testpilot')
  .description('Generate and verify targeted regression tests')
  .version('0.1.0');

program
  .command('analyze')
  .description('Analyze a change: changed functions, coverage, and callers')
  .requiredOption('--repo <path>', 'path to the target git repository')
  .requiredOption('--base <ref>', 'base revision')
  .requiredOption('--head <ref>', 'head revision')
  .option('--out <path>', 'report output path', './out/analysis.json')
  .option('--json', 'print the full report as JSON')
  .option('--no-cache', 'ignore cached coverage results')
  .action(async (options) => {
    const report = await analyzeRepo({
      repoPath: options.repo,
      base: options.base,
      head: options.head,
      noCache: options.cache === false
    });

    const outPath = path.resolve(options.out);
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printSummary(report);
      console.log(`\nReport written to ${outPath}`);
    }
  });

program
  .command('generate')
  .description('Generate and base-validate regression tests from an analysis report')
  .requiredOption('--analysis <path>', 'path to an AnalysisReport JSON file')
  .requiredOption('--repo <path>', 'path to the target git repository')
  .requiredOption('--base <ref>', 'base revision')
  .requiredOption('--head <ref>', 'head revision')
  .option('--provider <name>', 'anthropic | openai | google')
  .option('--model <id>', 'override the provider model id')
  .option('--max-scenarios <n>', 'number of scenarios to generate', '1')
  .option('--out <dir>', 'output root directory', './out/generated')
  .action(async (options) => {
    const report = AnalysisReportSchema.parse(
      JSON.parse(await readFile(path.resolve(options.analysis), 'utf8'))
    );
    const run = await generateTests({
      repoPath: options.repo,
      base: options.base,
      head: options.head,
      report,
      provider: parseProvider(options.provider),
      model: options.model,
      maxScenarios: parseMaxScenarios(options.maxScenarios),
      outRoot: options.out
    });
    printGenerationSummary(run);
  });

program
  .command('run')
  .description('Analyze a change and generate tests in one command')
  .requiredOption('--repo <path>', 'path to the target git repository')
  .requiredOption('--base <ref>', 'base revision')
  .requiredOption('--head <ref>', 'head revision')
  .option('--provider <name>', 'anthropic | openai | google')
  .option('--model <id>', 'override the provider model id')
  .option('--max-scenarios <n>', 'number of scenarios to generate', '1')
  .option('--out <dir>', 'output root directory', './out/generated')
  .option('--no-cache', 'ignore cached analysis coverage')
  .option('--skip-verify', 'skip the final verification step')
  .option('--repeat <n>', 'runs per revision during verification', '3')
  .option('--timeout <ms>', 'per-test timeout in milliseconds', '60000')
  .option('--fixed <ref>', 'optional fixed revision for a three-way check')
  .action(async (options) => {
    const report = await analyzeRepo({
      repoPath: options.repo,
      base: options.base,
      head: options.head,
      noCache: options.cache === false
    });
    const run = await generateTests({
      repoPath: options.repo,
      base: options.base,
      head: options.head,
      report,
      provider: parseProvider(options.provider),
      model: options.model,
      maxScenarios: parseMaxScenarios(options.maxScenarios),
      outRoot: options.out
    });
    printGenerationSummary(run);

    if (options.skipVerify) return;

    const verifications = await verifyGeneratedRun({
      repoPath: options.repo,
      base: options.base,
      head: options.head,
      fixed: options.fixed,
      report,
      generation: run,
      repeat: parsePositiveInt(options.repeat, 'repeat'),
      timeoutMs: parsePositiveInt(options.timeout, 'timeout'),
      outRoot: options.out
    });

    for (const verification of verifications) {
      printVerificationSummary(verification);
    }
  });

program
  .command('verify')
  .description('Verify a generated test against base, head and an optional fixed revision')
  .requiredOption('--repo <path>', 'path to the target git repository')
  .requiredOption('--base <ref>', 'base revision')
  .requiredOption('--head <ref>', 'head revision')
  .option('--fixed <ref>', 'optional fixed revision for a three-way check')
  .option('--fixed-patch <file>', 'optional patch applied to head as the fixed revision')
  .option('--test <file>', 'a single test file to verify')
  .option('--generated <dir>', 'a generated directory to verify')
  .option('--analysis <path>', 'analysis report used for changed-code evidence')
  .option('--repeat <n>', 'runs per revision', '3')
  .option('--timeout <ms>', 'per-test timeout in milliseconds', '60000')
  .option('--docker', 'run tests inside a container when docker is available')
  .option('--out <dir>', 'output root directory', './out/verified')
  .action(async (options) => {
    if (!options.test && !options.generated) {
      throw new Error('Provide --test <file> or --generated <dir>');
    }
    if (options.fixed && options.fixedPatch) {
      throw new Error('Use --fixed or --fixed-patch, not both');
    }

    const fixedPatch = options.fixedPatch
      ? await readFile(path.resolve(options.fixedPatch), 'utf8')
      : undefined;

    const report = options.analysis
      ? AnalysisReportSchema.parse(
          JSON.parse(await readFile(path.resolve(options.analysis), 'utf8'))
        )
      : undefined;

    const repeat = parsePositiveInt(options.repeat, 'repeat');
    const timeoutMs = parsePositiveInt(options.timeout, 'timeout');

    if (options.test) {
      const result = await verifyTest({
        repoPath: options.repo,
        base: options.base,
        head: options.head,
        fixed: options.fixed,
        fixedPatch,
        testFile: options.test,
        analysisReport: report,
        repeat,
        timeoutMs,
        docker: options.docker
      });
      await writeVerification(options.out, options.head, result);
      printVerificationSummary(result);
      return;
    }

    const generated = await readGeneratedDirectory(path.resolve(options.generated));
    const verifications: VerificationResult[] = [];

    for (const entry of generated) {
      const result = await verifyTest({
        repoPath: options.repo,
        base: options.base,
        head: options.head,
        fixed: options.fixed,
        fixedPatch,
        testFile: entry.testFile,
        analysisReport: report,
        scenarioId: entry.scenarioId,
        scenarioTitle: entry.scenarioTitle,
        repeat,
        timeoutMs,
        docker: options.docker
      });
      verifications.push(result);
      printVerificationSummary(result);
    }

    for (const verification of verifications) {
      await writeVerification(options.out, options.head, verification);
    }
  });

program
  .command('loop')
  .description('Analyze, generate, verify, repair and re-verify in one command')
  .requiredOption('--repo <path>', 'path to the target git repository')
  .requiredOption('--base <ref>', 'base revision')
  .requiredOption('--head <ref>', 'head revision')
  .option('--provider <name>', 'anthropic | openai | google')
  .option('--model <id>', 'override the provider model id')
  .option('--max-scenarios <n>', 'number of scenarios to generate', '1')
  .option('--max-repair-attempts <n>', 'repair attempts per regression', '3')
  .option('--repeat <n>', 'runs per revision during verification', '3')
  .option('--timeout <ms>', 'per-test timeout in milliseconds', '60000')
  .option('--out <dir>', 'output root directory', './out/loop')
  .option('--apply-to-branch <name>', 'commit the fix on a branch in a temporary clone')
  .option('--no-cache', 'ignore cached analysis coverage')
  .action(async (options) => {
    const result = await runLoop({
      repoPath: options.repo,
      base: options.base,
      head: options.head,
      provider: parseProvider(options.provider),
      model: options.model,
      maxScenarios: parseMaxScenarios(options.maxScenarios),
      maxRepairAttempts: parsePositiveInt(options.maxRepairAttempts, 'max-repair-attempts'),
      repeat: parsePositiveInt(options.repeat, 'repeat'),
      timeoutMs: parsePositiveInt(options.timeout, 'timeout'),
      out: options.out,
      applyToBranch: options.applyToBranch,
      noCache: options.cache === false
    });

    process.exitCode = result.exitCode;
  });

program
  .command('llm-check')
  .description('Check configured LLM providers with a trivial structured call')
  .option('--provider <name>', 'anthropic | openai | google | all', 'all')
  .action(async (options) => {
    await runLlmCheck(options.provider);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});