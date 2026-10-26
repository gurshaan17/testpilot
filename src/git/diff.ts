/**
 * Git diff retrieval for a base...head revision pair.
 */

export interface DiffOptions {
  repo: string;
  base: string;
  head: string;
}

export async function getDiff(_options: DiffOptions): Promise<string> {
  throw new Error('Not implemented: git/diff.getDiff');
}
