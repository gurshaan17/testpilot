/**
 * Applies a fix inside a temporary clone, never in the analyzed repository.
 * No remote is touched; the branch only exists in the throwaway clone.
 */
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execa } from 'execa';

export interface ApplyFixOptions {
  repoPath: string;
  head: string;
  branch: string;
  patch: string;
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

export async function applyFixToClone(
  options: ApplyFixOptions
): Promise<{ cloneDir: string; branch: string; commit: string }> {
  const repo = path.resolve(options.repoPath);
  const cloneDir = await mkdtemp(path.join(tmpdir(), 'testpilot-clone-'));

  try {
    await execa('git', ['clone', '--quiet', repo, cloneDir]);

    const nodeModules = path.join(repo, 'node_modules');
    if (await exists(nodeModules)) {
      await symlink(nodeModules, path.join(cloneDir, 'node_modules'), 'dir');
    }

    await execa('git', ['-C', cloneDir, 'checkout', '-q', '-B', options.branch, `origin/${options.head}`]);

    const patchFile = path.join(cloneDir, '.testpilot-fix.patch');
    const patchText = options.patch.endsWith('\n') ? options.patch : `${options.patch}\n`;
    await writeFile(patchFile, patchText, 'utf8');

    await execa('git', ['-C', cloneDir, 'apply', '--whitespace=nowarn', patchFile]);
    await rm(patchFile, { force: true });

    await execa('git', ['-C', cloneDir, 'add', '-A']);
    await execa('git', ['-C', cloneDir, 'commit', '-q', '-m', `fix: repair detected regression`]);
    const { stdout } = await execa('git', ['-C', cloneDir, 'rev-parse', 'HEAD']);

    return { cloneDir, branch: options.branch, commit: stdout.trim() };
  } catch (error) {
    await rm(cloneDir, { recursive: true, force: true });
    throw error;
  }
}
