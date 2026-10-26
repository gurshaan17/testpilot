/**
 * Naming helpers for generated tests and output folders.
 */
export function kebabCase(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function scenarioFileName(scenarioId: string): string {
  return `__testpilot__/${kebabCase(scenarioId)}.testpilot.test.ts`;
}

export function sanitizeRef(ref: string): string {
  return ref.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}