/**
 * Prompt templates for regression-test generation.
 */

export interface TestPromptInput {
  diff: string;
  impactedFiles: string[];
  coverageGaps: string[];
}

export function buildTestPrompt(_input: TestPromptInput): string {
  throw new Error('Not implemented: llm/prompts.buildTestPrompt');
}
