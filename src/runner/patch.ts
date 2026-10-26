/**
 * Applies a source patch to a detached HEAD worktree without creating refs.
 * A failed `git apply --check` is returned as typed data, never thrown.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { createWorktree } from './worktree';

export interface PatchStats {
  filesChanged: number;
  insertions: number;
  deletions: number;
  files: string[];
}

export interface PatchApplied {
  ok: true;
  dir: string;
  sha: string;
  patchStats: PatchStats;
  cleanup: () => Promise<void>;
}

export interface PatchRejected {
  ok: false;
  error: 'patch_failed';
  message: string;
  stderr: string;
}

export type PatchResult = PatchApplied | PatchRejected;

export interface CreatePatchedWorktreeOptions {
  repoPath: string;
  headRef: string;
  patchText: string;
}

function parseNumstat(stdout: string): PatchStats {
  const files: string[] = [];
  let insertions = 0;
  let deletions = 0;

  for (const line of stdout.split('\n')) {
    const [added, removed, file] = line.split('\t');
    if (!file) continue;
    files.push(file);
    insertions += added === '-' ? 0 : Number(added) || 0;
    deletions += removed === '-' ? 0 : Number(removed) || 0;
  }

  return { filesChanged: files.length, insertions, deletions, files };
}

export async function createPatchedWorktree(
  options: CreatePatchedWorktreeOptions
): Promise<PatchResult> {
  if (!options.patchText.trim()) {
    return {
      ok: false,
      error: 'patch_failed',
      message: 'Refusing to apply an empty patch',
      stderr: ''
    };
  }

  const worktree = await createWorktree(options.repoPath, options.headRef);
  const scratch = await mkdtemp(path.join(tmpdir(), 'testpilot-patch-'));
  const patchFile = path.join(scratch, 'change.patch');
  // A patch must end with a newline, otherwise git reports it as corrupt.
  const patchText = options.patchText.endsWith('\n')
    ? options.patchText
    : `${options.patchText}\n`;
  await writeFile(patchFile, patchText, 'utf8');

  try {
    const check = await execa(
      'git',
      ['-C', worktree.dir, 'apply', '--check', '--whitespace=nowarn', patchFile],
      { reject: false }
    );

    if (check.exitCode !== 0) {
      await worktree.cleanup();
      return {
        ok: false,
        error: 'patch_failed',
        message: (check.stderr || check.stdout || 'git apply --check failed').trim(),
        stderr: check.stderr ?? ''
      };
    }

    await execa('git', [
      '-C',
      worktree.dir,
      'apply',
      '--index',
      '--whitespace=nowarn',
      patchFile
    ]);

    const numstat = await execa('git', [
      '-C',
      worktree.dir,
      'diff',
      '--cached',
      '--numstat'
    ]);

    return {
      ok: true,
      dir: worktree.dir,
      sha: worktree.sha,
      patchStats: parseNumstat(numstat.stdout),
      cleanup: worktree.cleanup
    };
  } catch (error) {
    await worktree.cleanup();
    return {
      ok: false,
      error: 'patch_failed',
      message: (error as Error).message,
      stderr: ''
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}