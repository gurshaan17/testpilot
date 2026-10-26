/**
 * Safe filesystem access for the context pack. Nothing under __testpilot__ or
 * any path/content mentioning the reference branch may be read.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const FORBIDDEN = /__testpilot__|reference|regression-tests/i;

export function isForbiddenPath(filePath: string): boolean {
  return FORBIDDEN.test(filePath.split(path.sep).join('/'));
}

export function isForbiddenText(text: string): boolean {
  return FORBIDDEN.test(text);
}

export function normalize(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

export function safeRelative(filePath: string, worktreeDir: string): string {
  const root = path.resolve(worktreeDir);
  const absolute = path.resolve(root, filePath);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Refusing to read outside worktree: ${filePath}`);
  }
  return normalize(path.relative(root, absolute));
}

export function readSafe(
  worktreeDir: string,
  filePath: string,
  options: { maxChars?: number; truncateLines?: number } = {}
): { content: string; truncated: boolean } | null {
  try {
    const relative = safeRelative(filePath, worktreeDir);
    if (isForbiddenPath(relative)) return null;

    const absolute = path.join(worktreeDir, relative);
    if (!existsSync(absolute)) return null;

    let content = readFileSync(absolute, 'utf8');
    if (isForbiddenText(content)) return null;

    let truncated = false;
    if (options.truncateLines && content.split('\n').length > options.truncateLines) {
      const lines = content.split('\n');
      content = `${lines.slice(0, options.truncateLines).join('\n')}\n// ... truncated\n`;
      truncated = true;
    }
    if (options.maxChars && content.length > options.maxChars) {
      content = `${content.slice(0, options.maxChars)}\n// ... truncated\n`;
      truncated = true;
    }

    return { content, truncated };
  } catch {
    return null;
  }
}

export function lineCount(worktreeDir: string, filePath: string): number {
  const read = readSafe(worktreeDir, filePath);
  return read ? read.content.split('\n').length : 0;
}

export function listSourceFiles(worktreeDir: string): string[] {
  const root = path.join(worktreeDir, 'src');
  if (!existsSync(root)) return [];
  const files: string[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      const relative = normalize(path.relative(worktreeDir, absolute));
      if (entry.isDirectory()) {
        if (!isForbiddenPath(`${relative}/`)) walk(absolute);
      } else if (
        entry.isFile() &&
        relative.endsWith('.ts') &&
        !relative.endsWith('.test.ts') &&
        !relative.endsWith('.d.ts') &&
        !isForbiddenPath(relative)
      ) {
        files.push(relative);
      }
    }
  };

  walk(root);
  return files.sort();
}