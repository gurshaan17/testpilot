/**
 * Builds the plain-data context pack for scenario planning and test writing.
 * Reads only from the base/head worktrees and refuses answer-key material.
 */
import path from 'node:path';
import { Project } from 'ts-morph';
import type { AnalysisReport, ChangedFunction, ImpactNode } from '../analysis/schema';
import { collectCallables, type Callable } from '../analysis/callables';
import { fitToLimit, MAX_CONTEXT_CHARS } from './contextCap';
import { exportedSymbols, sourceAt, type ExportedSymbol } from './contextExports';
import {
  isForbiddenPath,
  isForbiddenText,
  lineCount,
  listSourceFiles,
  readSafe
} from './contextFiles';

const STYLE_EXAMPLE_LINES = 150;

export { isForbiddenPath, isForbiddenText, MAX_CONTEXT_CHARS };
export type { ExportedSymbol };

export interface FunctionRef {
  file: string;
  qualifiedName: string;
  name?: string;
}

export interface ContextPackOptions {
  repoPath: string;
  headWorktreeDir: string;
  baseWorktreeDir: string;
}

export interface CallerContext {
  qualifiedName: string;
  file: string;
  depth: number;
  signature: string;
  body: string;
  coveringTests: string[];
  testNameMatches: string[];
}

export interface ContextPack {
  function: {
    qualifiedName: string;
    file: string;
    signature: string;
    baseBody: string | null;
    headBody: string;
    diff: string;
    changedLineCoverage: { percentage: number; uncoveredLines: number[] };
    coveringTests: string[];
  };
  directCallers: CallerContext[];
  indirectCallers: Omit<CallerContext, 'body' | 'coveringTests' | 'testNameMatches'>[];
  callersWithoutTests: string[];
  styleExample: { file: string; content: string; truncated: boolean } | null;
  jestConfig: { file: string; content: string } | null;
  tsconfig: { file: string; content: string } | null;
  exports: ExportedSymbol[];
  helpers: ExportedSymbol[];
  files: { path: string; lines: number }[];
  characterCount: number;
  truncated: boolean;
}

function callableFor(
  project: Project,
  worktreeDir: string,
  file: string,
  matcher: { qualifiedName: string; name?: string; startLine?: number }
): Callable | undefined {
  const sourceFile = sourceAt(project, worktreeDir, file);
  if (!sourceFile) return undefined;

  const callables = collectCallables(sourceFile, file);
  return (
    (matcher.startLine !== undefined
      ? callables.find((callable) => callable.startLine === matcher.startLine)
      : undefined) ??
    callables.find(
      (callable) =>
        callable.qualifiedName === matcher.qualifiedName ||
        (matcher.name !== undefined && callable.name === matcher.name)
    )
  );
}

function safeBody(body: string): string {
  return isForbiddenText(body) ? '' : body;
}

function callersOf(report: AnalysisReport, changed: ChangedFunction): ImpactNode[] {
  const changedId = `${changed.qualifiedName}::${changed.file}`;
  const directIds = new Set(
    report.impactGraph.edges.filter((edge) => edge.to === changedId).map((edge) => edge.from)
  );
  const direct = report.impactGraph.nodes.filter(
    (node) => node.depth === 1 && directIds.has(node.id)
  );
  const directIdSet = new Set(direct.map((node) => node.id));
  const indirect = report.impactGraph.nodes.filter(
    (node) =>
      node.depth === 2 &&
      report.impactGraph.edges.some(
        (edge) => edge.from === node.id && directIdSet.has(edge.to)
      )
  );

  return [...direct, ...indirect];
}

function styleExample(
  worktreeDir: string,
  changed: ChangedFunction,
  direct: CallerContext[]
): ContextPack['styleExample'] {
  const candidates = [
    ...changed.coveringTests,
    ...direct.flatMap((caller) => caller.coveringTests)
  ];

  for (const candidate of candidates) {
    if (!candidate.endsWith('.test.ts') || isForbiddenPath(candidate)) continue;
    const read = readSafe(worktreeDir, candidate, { truncateLines: STYLE_EXAMPLE_LINES });
    if (read) {
      return { file: candidate, content: read.content, truncated: read.truncated };
    }
  }

  return null;
}

function jestConfig(worktreeDir: string): ContextPack['jestConfig'] {
  for (const candidate of [
    'jest.config.ts',
    'jest.config.js',
    'jest.config.mjs',
    'jest.config.cjs'
  ]) {
    const read = readSafe(worktreeDir, candidate, { maxChars: 8_000 });
    if (read) return { file: candidate, content: read.content };
  }

  const packageJson = readSafe(worktreeDir, 'package.json', { maxChars: 8_000 });
  if (packageJson && packageJson.content.includes('"jest"')) {
    return { file: 'package.json', content: packageJson.content };
  }
  return null;
}

export function buildContextPack(
  report: AnalysisReport,
  options: ContextPackOptions,
  functionRef: FunctionRef
): ContextPack {
  const changed = report.changedFunctions.find(
    (fn) =>
      fn.file === functionRef.file &&
      (fn.qualifiedName === functionRef.qualifiedName ||
        (functionRef.name !== undefined && fn.name === functionRef.name))
  );
  if (!changed) {
    throw new Error(
      `Changed function not found in report: ${functionRef.qualifiedName} (${functionRef.file})`
    );
  }

  const headProject = new Project({
    tsConfigFilePath: path.join(options.headWorktreeDir, 'tsconfig.json')
  });
  const baseProject = new Project({
    tsConfigFilePath: path.join(options.baseWorktreeDir, 'tsconfig.json')
  });

  const headCallable = callableFor(headProject, options.headWorktreeDir, changed.file, {
    qualifiedName: changed.qualifiedName,
    name: changed.name,
    startLine: changed.startLine
  });
  const baseCallable = callableFor(baseProject, options.baseWorktreeDir, changed.file, {
    qualifiedName: changed.qualifiedName,
    name: changed.name
  });

  const callerNodes = callersOf(report, changed);
  const directNodes = callerNodes.filter((node) => node.depth === 1);
  const indirectNodes = callerNodes.filter((node) => node.depth === 2);

  const directCallers: CallerContext[] = directNodes.map((node) => {
    const callable = callableFor(headProject, options.headWorktreeDir, node.file, {
      qualifiedName: node.qualifiedName,
      name: node.name,
      startLine: node.startLine
    });
    return {
      qualifiedName: node.qualifiedName,
      file: node.file,
      depth: node.depth,
      signature: callable && !isForbiddenText(callable.signature) ? callable.signature : '',
      body: callable ? safeBody(callable.bodyText) : '',
      coveringTests: node.coveringTests,
      testNameMatches: node.testNameMatches
    };
  });

  const indirectCallers = indirectNodes.map((node) => {
    const callable = callableFor(headProject, options.headWorktreeDir, node.file, {
      qualifiedName: node.qualifiedName,
      name: node.name,
      startLine: node.startLine
    });
    return {
      qualifiedName: node.qualifiedName,
      file: node.file,
      depth: node.depth,
      signature: callable && !isForbiddenText(callable.signature) ? callable.signature : ''
    };
  });

  const relevantIds = new Set(callerNodes.map((node) => node.id));
  const callersWithoutTests = report.callersWithoutTests
    .filter((node) => relevantIds.has(node.id))
    .map((node) => node.qualifiedName);

  const sourceFiles = listSourceFiles(options.headWorktreeDir);
  const allSymbols = sourceFiles.flatMap((module) =>
    exportedSymbols(headProject, options.headWorktreeDir, module)
  );
  const helpers = allSymbols.filter((symbol) => symbol.isHelper);
  const moduleSet = new Set([
    changed.file,
    ...directCallers.map((caller) => caller.file),
    ...indirectCallers.map((caller) => caller.file),
    ...helpers.map((helper) => helper.module)
  ]);

  const tsconfig = readSafe(options.headWorktreeDir, 'tsconfig.json', { maxChars: 8_000 });

  return fitToLimit({
    function: {
      qualifiedName: changed.qualifiedName,
      file: changed.file,
      signature: changed.signature,
      baseBody: baseCallable ? safeBody(baseCallable.bodyText) : null,
      headBody: headCallable ? safeBody(headCallable.bodyText) : '',
      diff: isForbiddenText(changed.diff) ? '' : changed.diff,
      changedLineCoverage: {
        percentage: changed.changedLineCoverage.percentage,
        uncoveredLines: changed.changedLineCoverage.uncoveredLines
      },
      coveringTests: changed.coveringTests
    },
    directCallers,
    indirectCallers,
    callersWithoutTests,
    styleExample: styleExample(options.headWorktreeDir, changed, directCallers),
    jestConfig: jestConfig(options.headWorktreeDir),
    tsconfig: tsconfig ? { file: 'tsconfig.json', content: tsconfig.content } : null,
    exports: allSymbols.filter((symbol) => moduleSet.has(symbol.module)),
    helpers,
    files: sourceFiles.map((file) => ({
      path: file,
      lines: lineCount(options.headWorktreeDir, file)
    })),
    characterCount: 0,
    truncated: false
  });
}