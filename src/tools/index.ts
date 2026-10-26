/**
 * Placeholder for Alan-callable tool wrappers (analyze, generate, verify).
 */

export type ToolName = 'analyze_change' | 'generate_regression_test' | 'verify_regression';

export const TOOL_NAMES: ToolName[] = [
  'analyze_change',
  'generate_regression_test',
  'verify_regression'
];

export function registerTools(): void {
  throw new Error('Not implemented: tools.registerTools');
}
