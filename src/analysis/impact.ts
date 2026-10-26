/**
 * Impact analysis.
 * Part 1: changed functions and uncovered top-level changes.
 * Part 2 (below): caller graph up to two hops, with coverage signals.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Project, type SourceFile } from 'ts-morph';
import { parseHunks, type ChangedFile, type LineRange } from '../git/diff';
import { collectCallables } from './callables';

export interface ChangedFunctionInfo {
  name: string;
  qualifiedName: string;
  file: string;
  startLine: number;
  endLine: number;
  isExported: boolean;
  signature: string;
  bodyText: string;
  diff: string;
  changedLines: number[];
}

export interface OtherChange {
  file: string;
  range: LineRange;
}

export interface ExtractionResult {
  changedFunctions: ChangedFunctionInfo[];
  otherChanges: OtherChange[];
}

function intersects(start: number, end: number, ranges: LineRange[]): boolean {
  return ranges.some((range) => range.start <= end && range.end >= start);
}

function hunkIntersectsFunction(
  newStart: number,
  newEnd: number,
  functionStart: number,
  functionEnd: number
): boolean {
  if (newEnd < newStart) {
    // Pure deletion: the hunk anchors to the line where code was removed.
    return newStart >= functionStart - 1 && newStart <= functionEnd + 1;
  }
  return newStart <= functionEnd && newEnd >= functionStart;
}

export function diffForFunction(
  diffText: string,
  functionStart: number,
  functionEnd: number
): string {
  return parseHunks(diffText)
    .filter((hunk) =>
      hunkIntersectsFunction(hunk.newStart, hunk.newEnd, functionStart, functionEnd)
    )
    .map((hunk) => hunk.lines.join('\n'))
    .join('\n');
}

function changedLinesIn(start: number, end: number, ranges: LineRange[]): number[] {
  const lines = new Set<number>();

  for (const range of ranges) {
    const from = Math.max(range.start, start);
    const to = Math.min(range.end, end);
    for (let line = from; line <= to; line += 1) lines.add(line);
  }

  return [...lines].sort((a, b) => a - b);
}

function sourceAt(project: Project, absolutePath: string): SourceFile | undefined {
  const existing = project.getSourceFile(absolutePath);
  if (existing) return existing;
  return project.addSourceFileAtPath(absolutePath);
}

export function extractChangedFunctions(
  worktreePath: string,
  changedFiles: ChangedFile[]
): ExtractionResult {
  const project = new Project({ skipFileDependencyResolution: true });
  const changedFunctions: ChangedFunctionInfo[] = [];
  const otherChanges: OtherChange[] = [];

  for (const file of changedFiles) {
    if (file.status === 'deleted') continue;

    const absolutePath = path.join(worktreePath, file.path);
    if (!existsSync(absolutePath)) continue;

    const sourceFile = sourceAt(project, absolutePath);
    if (!sourceFile) continue;

    const callables = collectCallables(sourceFile, file.path);
    const callablesInFile = callables.filter((callable) =>
      intersects(callable.startLine, callable.endLine, file.changedLineRanges)
    );

    for (const callable of callablesInFile) {
      changedFunctions.push({
        name: callable.name,
        qualifiedName: callable.qualifiedName,
        file: callable.file,
        startLine: callable.startLine,
        endLine: callable.endLine,
        isExported: callable.isExported,
        signature: callable.signature,
        bodyText: callable.bodyText,
        diff: diffForFunction(file.diff, callable.startLine, callable.endLine),
        changedLines: changedLinesIn(callable.startLine, callable.endLine, file.changedLineRanges)
      });
    }

    for (const range of file.changedLineRanges) {
      const covered = callables.some(
        (callable) => callable.startLine <= range.end && callable.endLine >= range.start
      );
      if (!covered) otherChanges.push({ file: file.path, range });
    }
  }

  changedFunctions.sort(
    (a, b) => a.file.localeCompare(b.file) || a.startLine - b.startLine
  );

  return { changedFunctions, otherChanges };
}

export { buildImpactGraph } from './impactGraph';
export type {
  BuildImpactOptions,
  ImpactEdge,
  ImpactGraphResult,
  ImpactNode,
  UnresolvedReference
} from './impactGraph';
