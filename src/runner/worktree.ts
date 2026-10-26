/**
 * Creates and removes temporary git worktrees for base/head verification.
 */

export interface WorktreeOptions {
  repo: string;
  ref: string;
  directory: string;
}

export async function createWorktree(_options: WorktreeOptions): Promise<string> {
  throw new Error('Not implemented: runner/worktree.createWorktree');
}

export async function removeWorktree(_repo: string, _directory: string): Promise<void> {
  throw new Error('Not implemented: runner/worktree.removeWorktree');
}
