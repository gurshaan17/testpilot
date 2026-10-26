/**
 * Temporary git worktrees for running the target repo at a specific revision.
 * Each worktree shares the repo's node_modules via a symlink.
 */
import { mkdtemp, rm, stat, symlink } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execa, execaSync } from 'execa';

export interface Worktree {
  dir: string;
  sha: string;
  cleanup: () => Promise<void>;
}

const syncCleanups = new Set<() => void>();
let handlersInstalled = false;

function runSyncCleanups(): void {
  for (const cleanup of syncCleanups) {
    try {
      cleanup();
    } catch {
      // Best effort during shutdown.
    }
  }
}

function installExitHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;

  process.once('exit', runSyncCleanups);
  process.once('SIGINT', () => {
    runSyncCleanups();
    process.exit(130);
  });
  process.once('SIGTERM', () => {
    runSyncCleanups();
    process.exit(143);
  });
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

export async function createWorktree(repoPath: string, ref: string): Promise<Worktree> {
  installExitHandlers();

  const repo = path.resolve(repoPath);
  const { stdout } = await execa('git', ['-C', repo, 'rev-parse', '--verify', `${ref}^{commit}`]);
  const sha = stdout.trim();

  const dir = await mkdtemp(path.join(tmpdir(), 'testpilot-wt-'));
  // git worktree add wants to create the directory itself.
  await rm(dir, { recursive: true, force: true });

  try {
    await execa('git', ['-C', repo, 'worktree', 'add', '--detach', dir, sha]);
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }

  const nodeModules = path.join(repo, 'node_modules');
  if (await pathExists(nodeModules)) {
    await symlink(nodeModules, path.join(dir, 'node_modules'), 'dir');
  }

  let cleaned = false;

  const syncCleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    syncCleanups.delete(syncCleanup);
    try {
      execaSync('git', ['-C', repo, 'worktree', 'remove', '--force', dir]);
    } catch {
      // The worktree may already be gone.
    }
    rmSync(dir, { recursive: true, force: true });
  };

  syncCleanups.add(syncCleanup);

  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    syncCleanups.delete(syncCleanup);

    try {
      await execa('git', ['-C', repo, 'worktree', 'remove', '--force', dir]);
    } catch {
      // Fall through to removing the directory.
    }
    await rm(dir, { recursive: true, force: true });
  };

  return { dir, sha, cleanup };
}