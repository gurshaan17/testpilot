/**
 * Turns a diff plus coverage data into a ranked list of impact areas.
 */

export interface ImpactedFile {
  path: string;
  reason: string;
}

export function rankImpactedFiles(_diff: string, _coverage?: unknown): ImpactedFile[] {
  throw new Error('Not implemented: analysis/impact.rankImpactedFiles');
}
