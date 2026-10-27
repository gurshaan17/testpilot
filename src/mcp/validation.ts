/**
 * Shared validation for MCP tools: repo allowlist, ref validation and output
 * truncation. Errors are short and actionable; no stack traces, no env values.
 */
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';

export interface McpTextResult {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

const REF_PATTERN = /^[A-Za-z0-9._/@-]+$/;
const OUTPUT_LIMIT = 20_000;

export function allowedRepos(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.TESTPILOT_ALLOWED_REPOS?.trim();
  const entries = raw ? raw.split(':').filter(Boolean) : [path.resolve(process.cwd(), '../demo-shop')];
  return entries.map((entry) => path.resolve(entry));
}

function isInside(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

export async function validateRepoPath(
  input: string,
  roots: string[] = allowedRepos()
): Promise<string> {
  let resolved: string;
  try {
    resolved = await realpath(path.resolve(input));
  } catch {
    throw new Error(`Repository not found: ${input}`);
  }

  const realRoots = await Promise.all(
    roots.map(async (root) => {
      try {
        return await realpath(root);
      } catch {
        return path.resolve(root);
      }
    })
  );

  if (!realRoots.some((root) => isInside(resolved, root))) {
    throw new Error(
      'Repository is outside the allowlist. Set TESTPILOT_ALLOWED_REPOS to permit it.'
    );
  }

  return resolved;
}

export function validateRef(ref: string): string {
  if (!ref || ref.startsWith('-') || !REF_PATTERN.test(ref)) {
    throw new Error(
      `Invalid ref "${ref}". Use a branch, tag or SHA (letters, digits, . _ / @ -).`
    );
  }
  return ref;
}

export async function verifyRef(repoPath: string, ref: string): Promise<string> {
  const safeRef = validateRef(ref);
  const result = await execa(
    'git',
    ['-C', repoPath, 'rev-parse', '--verify', `${safeRef}^{commit}`],
    { reject: false }
  );
  if (result.exitCode !== 0) {
    throw new Error(`Ref not found in ${path.basename(repoPath)}: ${safeRef}`);
  }
  return result.stdout.trim();
}

export function truncate(text: string, limit = OUTPUT_LIMIT): string {
  return text.length <= limit
    ? text
    : `${text.slice(0, limit)}\n\n[truncated: output exceeded ${limit} characters]`;
}

export function ok(text: string, structured?: Record<string, unknown>): McpTextResult {
  return {
    content: [{ type: 'text', text: truncate(text) }],
    ...(structured ? { structuredContent: structured } : {})
  };
}

export function fail(message: string): McpTextResult {
  return {
    isError: true,
    content: [{ type: 'text', text: truncate(message) }]
  };
}

export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  what: string
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `${what} timed out after ${Math.round(ms / 1000)}s; the run remains in the store.`
              )
            ),
          ms
        );
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function timeoutMs(): number {
  const parsed = Number.parseInt(process.env.TESTPILOT_MCP_TIMEOUT_MS ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 300_000;
}
