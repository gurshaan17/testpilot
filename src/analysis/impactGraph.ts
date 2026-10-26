/**
 * Part 2 of impact analysis: caller graph up to two hops plus coverage signals.
 * Split from impact.ts to keep each module focused.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Node, Project, type Identifier } from 'ts-morph';
import { collectCallables, nearestCallable, type Callable } from './callables';
import { testsCoveringFunction, type CoverageData } from './coverage';
import type { ChangedFunctionInfo } from './impact';

export interface ImpactNode {
  id: string;
  name: string;
  qualifiedName: string;
  file: string;
  startLine: number;
  endLine: number;
  depth: number;
  coveringTests: string[];
  testNameMatches: string[];
}

export interface ImpactEdge {
  from: string;
  to: string;
  file: string;
  line: number;
}

export interface UnresolvedReference {
  from: string;
  file: string;
  line: number;
  reason: string;
}

export interface ImpactGraphResult {
  nodes: ImpactNode[];
  edges: ImpactEdge[];
  unresolvedReferences: UnresolvedReference[];
}

export interface BuildImpactOptions {
  worktreePath: string;
  changedFunctions: ChangedFunctionInfo[];
  coverage: CoverageData;
  testFiles: string[];
}

function nodeId(qualifiedName: string, file: string): string {
  return `${qualifiedName}::${file}`;
}

function isTestFile(filePath: string): boolean {
  return filePath.endsWith('.test.ts') || filePath.includes('__testpilot__/');
}

function referenceTarget(callable: Callable): Identifier | undefined {
  const node = callable.node;
  if (
    Node.isFunctionDeclaration(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isGetAccessorDeclaration(node) ||
    Node.isSetAccessorDeclaration(node)
  ) {
    const nameNode = node.getNameNode();
    return nameNode && Node.isIdentifier(nameNode) ? nameNode : undefined;
  }

  const parent = node.getParent();
  if (Node.isVariableDeclaration(parent) || Node.isPropertyDeclaration(parent)) {
    const nameNode = parent.getNameNode();
    return nameNode && Node.isIdentifier(nameNode) ? nameNode : undefined;
  }

  return undefined;
}

function isImportOrExportReference(node: Node): boolean {
  return Boolean(
    node.getFirstAncestor(
      (ancestor) =>
        Node.isImportDeclaration(ancestor) ||
        Node.isExportDeclaration(ancestor) ||
        Node.isImportEqualsDeclaration(ancestor)
    )
  );
}

export function buildImpactGraph(options: BuildImpactOptions): ImpactGraphResult {
  const { worktreePath, changedFunctions, coverage } = options;
  const project = new Project({ tsConfigFilePath: path.join(worktreePath, 'tsconfig.json') });

  const nodes = new Map<string, ImpactNode>();
  const edges = new Map<string, ImpactEdge>();
  const unresolved: UnresolvedReference[] = [];
  const expanded = new Set<string>();
  const queue: Array<{ callable: Callable; depth: number }> = [];

  const addNode = (callable: Callable, depth: number): ImpactNode => {
    const id = nodeId(callable.qualifiedName, callable.file);
    const existing = nodes.get(id);
    if (existing && existing.depth <= depth) return existing;

    const node: ImpactNode = {
      id,
      name: callable.name,
      qualifiedName: callable.qualifiedName,
      file: callable.file,
      startLine: callable.startLine,
      endLine: callable.endLine,
      depth,
      coveringTests: [],
      testNameMatches: []
    };
    nodes.set(id, node);
    return node;
  };

  for (const changed of changedFunctions) {
    const sourceFile = project.getSourceFile(path.join(worktreePath, changed.file));
    const callable = sourceFile
      ? collectCallables(sourceFile, changed.file).find(
          (candidate) => candidate.name === changed.name && candidate.startLine === changed.startLine
        )
      : undefined;

    if (!callable) {
      unresolved.push({
        from: changed.qualifiedName,
        file: changed.file,
        line: changed.startLine,
        reason: 'changed function declaration not found in the HEAD project'
      });
      continue;
    }

    addNode(callable, 0);
    queue.push({ callable, depth: 0 });
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentId = nodeId(current.callable.qualifiedName, current.callable.file);
    if (expanded.has(currentId)) continue;
    expanded.add(currentId);

    const target = referenceTarget(current.callable);
    if (!target) {
      unresolved.push({
        from: current.callable.qualifiedName,
        file: current.callable.file,
        line: current.callable.startLine,
        reason: 'no reference target available for this callable'
      });
      continue;
    }

    let references;
    try {
      references = target.findReferencesAsNodes();
    } catch (error) {
      unresolved.push({
        from: current.callable.qualifiedName,
        file: current.callable.file,
        line: current.callable.startLine,
        reason: `reference lookup failed: ${(error as Error).message}`
      });
      continue;
    }

    for (const reference of references) {
      if (isImportOrExportReference(reference)) continue;

      const referenceFile = path
        .relative(worktreePath, reference.getSourceFile().getFilePath())
        .split(path.sep)
        .join('/');
      if (isTestFile(referenceFile)) continue;

      const caller = nearestCallable(reference, referenceFile);
      if (!caller) {
        unresolved.push({
          from: current.callable.qualifiedName,
          file: referenceFile,
          line: reference.getStartLineNumber(),
          reason: 'reference is not inside a function'
        });
        continue;
      }

      const callerId = nodeId(caller.qualifiedName, caller.file);
      const edge: ImpactEdge = {
        from: callerId,
        to: currentId,
        file: referenceFile,
        line: reference.getStartLineNumber()
      };
      edges.set(`${edge.from}->${edge.to}:${edge.file}:${edge.line}`, edge);

      if (current.depth + 1 <= 2) {
        const depth = current.depth + 1;
        const previous = nodes.get(callerId);
        addNode(caller, depth);
        if (depth < 2 && (!previous || depth < previous.depth)) {
          queue.push({ callable: caller, depth });
        }
      }
    }
  }

  const testSources = new Map<string, string>();
  for (const testFile of options.testFiles) {
    try {
      testSources.set(testFile, readFileSync(path.join(worktreePath, testFile), 'utf8'));
    } catch {
      // A missing test file just contributes no name matches.
    }
  }

  for (const node of nodes.values()) {
    node.coveringTests = testsCoveringFunction(coverage, node);
    const pattern = new RegExp(`\\b${node.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    node.testNameMatches = [...testSources.entries()]
      .filter(([, source]) => pattern.test(source))
      .map(([file]) => file)
      .sort();
  }

  return {
    nodes: [...nodes.values()].sort(
      (a, b) => a.depth - b.depth || a.file.localeCompare(b.file) || a.startLine - b.startLine
    ),
    edges: [...edges.values()].sort(
      (a, b) => a.line - b.line || a.from.localeCompare(b.from) || a.to.localeCompare(b.to)
    ),
    unresolvedReferences: unresolved
  };
}
