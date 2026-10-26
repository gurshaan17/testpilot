/**
 * Composes the deterministic analysis pipeline.
 * No LLM calls happen here.
 */
import path from 'node:path';
import { getChangedFiles, resolveRefs } from '../git/diff';
import { createWorktree } from '../runner/worktree';
import { changedLineCoverage, computeCoverageMap, testsCoveringFunction } from './coverage';
import { buildImpactGraph, extractChangedFunctions } from './impact';
import { AnalysisReportSchema, type AnalysisReport } from './schema';

export interface AnalyzeOptions {
  repoPath: string;
  base: string;
  head: string;
  noCache?: boolean;
}

export async function analyzeRepo(options: AnalyzeOptions): Promise<AnalysisReport> {
  const repoPath = path.resolve(options.repoPath);
  const refs = await resolveRefs(repoPath, options.base, options.head);
  const { changedFiles, changedTestFiles } = await getChangedFiles(
    repoPath,
    options.base,
    options.head
  );

  const worktree = await createWorktree(repoPath, refs.headSha);

  try {
    const coverage = await computeCoverageMap({
      repoPath,
      worktreePath: worktree.dir,
      headSha: refs.headSha,
      noCache: options.noCache
    });
    const testFiles = coverage.testFiles.map((test) => test.file);
    const { changedFunctions, otherChanges } = extractChangedFunctions(
      worktree.dir,
      changedFiles
    );
    const graph = buildImpactGraph({
      worktreePath: worktree.dir,
      changedFunctions,
      coverage,
      testFiles
    });

    return AnalysisReportSchema.parse({
      repo: repoPath,
      base: { ref: options.base, sha: refs.baseSha },
      head: { ref: options.head, sha: refs.headSha },
      generatedAt: new Date().toISOString(),
      baseline: {
        testFiles: coverage.testFiles,
        failures: coverage.baselineFailures
      },
      changedFiles,
      changedTestFiles,
      changedFunctions: changedFunctions.map((fn) => ({
        name: fn.name,
        qualifiedName: fn.qualifiedName,
        file: fn.file,
        startLine: fn.startLine,
        endLine: fn.endLine,
        signature: fn.signature,
        diff: fn.diff,
        changedLineCoverage: changedLineCoverage(coverage, fn),
        coveringTests: testsCoveringFunction(coverage, fn)
      })),
      otherChanges,
      impactGraph: {
        nodes: graph.nodes,
        edges: graph.edges
      },
      callersWithoutTests: graph.nodes.filter(
        (node) => node.depth >= 1 && node.coveringTests.length === 0
      ),
      unresolvedReferences: graph.unresolvedReferences
    });
  } finally {
    await worktree.cleanup();
  }
}