/**
 * Renders the human-readable TestPilot verdict.
 */

import type { VerificationResult } from '../runner/schema';

export interface ReportInput {
  repo: string;
  base: string;
  head: string;
  testPath: string;
  result: VerificationResult;
}

export function renderMarkdownReport(_input: ReportInput): string {
  throw new Error('Not implemented: report/markdown.renderMarkdownReport');
}
