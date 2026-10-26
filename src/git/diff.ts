/**
 * Deterministic git helpers: ref resolution, changed-file parsing, and reads.
 * Diffs use --unified=0 so hunk headers map directly to changed lines.
 */
import { execa } from 'execa';

export interface LineRange {
  start: number;
  end: number;
}

export type ChangeStatus = 'added' | 'modified' | 'deleted';

export interface ChangedFile {
  path: string;
  status: ChangeStatus;
  changedLineRanges: LineRange[];
  diff: string;
}

export interface ChangedFilesResult {
  changedFiles: ChangedFile[];
  changedTestFiles: ChangedFile[];
}

export interface ResolvedRefs {
  baseSha: string;
  headSha: string;
  mergeBase: string;
}

export interface DiffHunk {
  header: string;
  newStart: number;
  newEnd: number;
  lines: string[];
}

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execa('git', ['-C', repoPath, ...args]);
  return stdout;
}

export async function resolveRefs(
  repoPath: string,
  base: string,
  head: string
): Promise<ResolvedRefs> {
  const [baseSha, headSha, mergeBase] = await Promise.all([
    git(repoPath, ['rev-parse', '--verify', `${base}^{commit}`]),
    git(repoPath, ['rev-parse', '--verify', `${head}^{commit}`]),
    git(repoPath, ['merge-base', base, head])
  ]);

  return { baseSha: baseSha.trim(), headSha: headSha.trim(), mergeBase: mergeBase.trim() };
}

export function parseHunks(diffText: string): DiffHunk[] {
  const lines = diffText.split('\n');
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | undefined;

  for (const line of lines) {
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (match) {
      const newStart = Number(match[1]);
      const count = match[2] === undefined ? 1 : Number(match[2]);
      current = {
        header: line,
        newStart,
        newEnd: count === 0 ? newStart - 1 : newStart + count - 1,
        lines: [line]
      };
      hunks.push(current);
      continue;
    }

    if (current && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' '))) {
      current.lines.push(line);
    }
  }

  return hunks;
}

function mergeRanges(ranges: LineRange[]): LineRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: LineRange[] = [];

  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }

  return merged;
}

function pathFromDiff(block: string): string | undefined {
  const newPath = /^\+\+\+ b\/(.+)$/m.exec(block)?.[1];
  if (newPath) return newPath;
  return /^--- a\/(.+)$/m.exec(block)?.[1];
}

function statusFromDiff(block: string): ChangeStatus {
  if (/^new file mode /m.test(block)) return 'added';
  if (/^deleted file mode /m.test(block)) return 'deleted';
  return 'modified';
}

function isTestPath(filePath: string): boolean {
  return (
    filePath.endsWith('.test.ts') ||
    filePath.startsWith('__testpilot__/') ||
    filePath.includes('/__testpilot__/')
  );
}

export async function getChangedFiles(
  repoPath: string,
  base: string,
  head: string
): Promise<ChangedFilesResult> {
  const output = await git(repoPath, [
    'diff',
    '--unified=0',
    '--no-color',
    '--find-renames',
    `${base}...${head}`
  ]);

  const changedFiles: ChangedFile[] = [];
  const changedTestFiles: ChangedFile[] = [];
  const blocks = output.split(/^(?=diff --git )/m).filter((block) => block.trim());

  for (const block of blocks) {
    const filePath = pathFromDiff(block);
    if (!filePath || !filePath.endsWith('.ts')) continue;

    const changedLineRanges = mergeRanges(
      parseHunks(block)
        .filter((hunk) => hunk.newEnd >= hunk.newStart)
        .map((hunk) => ({ start: hunk.newStart, end: hunk.newEnd }))
    );

    const file: ChangedFile = {
      path: filePath,
      status: statusFromDiff(block),
      changedLineRanges,
      diff: block.trimEnd()
    };

    if (isTestPath(filePath)) {
      changedTestFiles.push(file);
    } else if (filePath.startsWith('src/')) {
      changedFiles.push(file);
    }
  }

  return { changedFiles, changedTestFiles };
}

export async function getFileAtRef(
  repoPath: string,
  ref: string,
  filePath: string
): Promise<string> {
  return git(repoPath, ['show', `${ref}:${filePath}`]);
}