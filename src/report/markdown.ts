/**
 * Renders the human-readable TestPilot verdict.
 */

import type { VerifyResult } from '../runner/verify';

export interface ReportInput {
  repo: string;
  base: string;
  head: string;
  testPath: string;
  result: VerifyResult;
}

export function renderMarkdownReport(_input: ReportInput): string {
  throw new Error('Not implemented: report/markdown.renderMarkdownReport');
}
