/**
 * LLM repair agent. It proposes find/replace source edits; the diff is built
 * by git, never trusted from the model.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { LanguageModelUsage } from 'ai';
import { execa } from 'execa';
import { generateStructured, type ProviderName } from '../llm/client';
import { buildSourceRepairPrompt } from '../llm/prompts';
import type { RepairContext } from './context';

export const RepairProposalSchema = z.object({
  diagnosis: z.string().min(1),
  rootCause: z.object({
    file: z.string(),
    function: z.string(),
    line: z.number().int()
  }),
  strategy: z.string().min(1),
  edits: z
    .array(
      z.object({
        file: z.string(),
        find: z.string().min(1),
        replace: z.string()
      })
    )
    .min(1)
    .max(10),
  preservesPrIntent: z.boolean(),
  intentNote: z.string()
});

export type RepairProposal = z.infer<typeof RepairProposalSchema>;

export interface ProposeRepairOptions {
  context: RepairContext;
  provider?: ProviderName;
  model?: string;
}

export interface RepairProposalResult {
  proposal: RepairProposal;
  prompt: string;
  system: string;
  provider: ProviderName;
  model: string;
  usage: LanguageModelUsage;
}

export async function proposeRepair(
  options: ProposeRepairOptions
): Promise<RepairProposalResult> {
  const promptPair = buildSourceRepairPrompt(options.context);
  const result = await generateStructured({
    provider: options.provider,
    model: options.model,
    system: promptPair.system,
    prompt: promptPair.prompt,
    schema: RepairProposalSchema,
    temperature: 0.1
  });

  return {
    proposal: result.data,
    prompt: promptPair.prompt,
    system: promptPair.system,
    provider: result.provider,
    model: result.model,
    usage: result.usage
  };
}

export type ApplyEditsResult =
  | {
      ok: true;
      patch: string;
      changedFiles: string[];
      /** Original file contents, keyed by repo-relative path. */
      originals: Record<string, string>;
    }
  | { ok: false; error: string };

function safeSourcePath(worktreeDir: string, file: string): string | undefined {
  const normalized = file.split(path.sep).join('/');
  if (!normalized.startsWith('src/') || normalized.includes('..')) return undefined;
  return path.join(worktreeDir, normalized);
}

/**
 * Applies edits in order. Every `find` must match exactly once.
 */
export async function applyEditsToWorktree(options: {
  worktreeDir: string;
  edits: RepairProposal['edits'];
}): Promise<ApplyEditsResult> {
  const originals = new Map<string, string>();
  const changedFiles = new Set<string>();

  for (const [index, edit] of options.edits.entries()) {
    const relative = edit.file.split(path.sep).join('/');
    const absolute = safeSourcePath(options.worktreeDir, relative);
    if (!absolute) {
      await restore(originals);
      return { ok: false, error: `Edit ${index + 1}: ${edit.file} is not a source file under src/.` };
    }

    let content: string;
    try {
      content = originals.get(absolute) ?? (await readFile(absolute, 'utf8'));
    } catch {
      await restore(originals);
      return { ok: false, error: `Edit ${index + 1}: ${relative} does not exist on head.` };
    }
    if (!originals.has(absolute)) originals.set(absolute, content);

    const occurrences = content.split(edit.find).length - 1;
    if (occurrences === 0) {
      await restore(originals);
      return {
        ok: false,
        error: `Edit ${index + 1}: find text was not found in ${relative}.`
      };
    }
    if (occurrences > 1) {
      await restore(originals);
      return {
        ok: false,
        error: `Edit ${index + 1}: find text matched ${occurrences} times in ${relative}; it must match exactly once.`
      };
    }

    await writeFile(absolute, content.replace(edit.find, edit.replace), 'utf8');
    changedFiles.add(relative);
  }

  const diff = await execa('git', ['-C', options.worktreeDir, 'diff'], { reject: false });
  if (diff.exitCode !== 0 || !diff.stdout.trim()) {
    await restore(originals);
    return { ok: false, error: 'The proposed edits produced no diff.' };
  }

  return {
    ok: true,
    patch: diff.stdout.endsWith('\n') ? diff.stdout : `${diff.stdout}\n`,
    changedFiles: [...changedFiles],
    originals: Object.fromEntries(
      [...originals.entries()].map(([absolute, content]) => [
        path.relative(options.worktreeDir, absolute).split(path.sep).join('/'),
        content
      ])
    )
  };
}

async function restore(originals: Map<string, string>): Promise<void> {
  for (const [file, content] of originals) {
    try {
      await writeFile(file, content, 'utf8');
    } catch {
      // The disposable worktree will be removed anyway.
    }
  }
}