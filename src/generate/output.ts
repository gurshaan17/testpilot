/**
 * Writes run artifacts. Everything stays under the requested output root.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sanitizeRef } from './naming';

export interface PromptFile {
  kind: 'plan' | 'generate';
  scenarioId: string | null;
  function: string;
  file: string;
}

function promptText(system: string, prompt: string): string {
  return `SYSTEM\n${system}\n\nPROMPT\n${prompt}\n`;
}

export async function writePrompt(
  runDir: string,
  name: string,
  system: string,
  prompt: string
): Promise<string> {
  const relative = path.posix.join('prompts', `${sanitizeRef(name)}.txt`);
  const absolute = path.join(runDir, relative);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, promptText(system, prompt), 'utf8');
  return relative;
}

export async function writeGenerationJson(
  runDir: string,
  payload: unknown
): Promise<string> {
  await mkdir(runDir, { recursive: true });
  const absolute = path.join(runDir, 'generation.json');
  await writeFile(absolute, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return absolute;
}
