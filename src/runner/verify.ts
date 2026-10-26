/**
 * Runs one generated test against the base and head revisions.
 */

export type VerifyVerdict = 'regression-reproduced' | 'passes-on-both' | 'fails-on-both' | 'flaky';

export interface VerifyInput {
  repo: string;
  base: string;
  head: string;
  testPath: string;
}

export interface VerifyResult {
  verdict: VerifyVerdict;
  basePassed: boolean;
  headPassed: boolean;
}

export async function verifyRegression(_input: VerifyInput): Promise<VerifyResult> {
  throw new Error('Not implemented: runner/verify.verifyRegression');
}
