/**
 * Writes a generated test into the target repo's __testpilot__ folder.
 */

export interface WriteTestInput {
  repo: string;
  relativePath: string;
  source: string;
}

export async function writeGeneratedTest(_input: WriteTestInput): Promise<string> {
  throw new Error('Not implemented: generate/writeTest.writeGeneratedTest');
}
