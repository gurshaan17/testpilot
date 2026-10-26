/**
 * Reads Jest coverage output so prompts can target uncovered branches.
 */

export interface CoverageSummary {
  statements: number;
  branches: number;
  functions: number;
  lines: number;
  files: Record<string, number>;
}

export async function readCoverage(_coveragePath: string): Promise<CoverageSummary> {
  throw new Error('Not implemented: analysis/coverage.readCoverage');
}
