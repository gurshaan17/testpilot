/**
 * Persisted shapes for the verification runner.
 */
import { z } from 'zod';

export const VerdictSchema = z.enum([
  'regression_caught',
  'regression_caught_suspect',
  'not_demonstrated_passes_both',
  'invalid_fails_on_base',
  'flaky',
  'inconclusive'
]);

export const ConfidenceSchema = z.enum(['high', 'medium', 'low']);

export const FailureTypeSchema = z.enum([
  'assertion',
  'runtime-error',
  'compile-error',
  'timeout'
]);

export const TestStatusSchema = z.enum(['passed', 'failed', 'error', 'timeout']);

export const FailureLocationSchema = z.object({
  file: z.string(),
  line: z.number().int(),
  column: z.number().int().optional()
});

export const TestCaseSchema = z.object({
  title: z.string(),
  fullName: z.string(),
  status: z.enum(['passed', 'failed']),
  failureMessages: z.array(z.string()),
  failureType: FailureTypeSchema.optional(),
  durationMs: z.number()
});

export const TestRunSchema = z.object({
  status: TestStatusSchema,
  tests: z.array(TestCaseSchema),
  numPassed: z.number().int(),
  numFailed: z.number().int(),
  numTotal: z.number().int(),
  suiteFailedToRun: z.boolean(),
  exitCode: z.number().int().nullable(),
  outputTail: z.string(),
  failureLocation: FailureLocationSchema.optional(),
  error: z.string().optional()
});

export const RevisionResultSchema = z.object({
  ref: z.string(),
  sha: z.string(),
  runs: z.array(TestRunSchema),
  consistentStatus: z.enum(['passed', 'failed', 'error', 'timeout', 'mixed']),
  stable: z.boolean(),
  failureType: FailureTypeSchema.optional(),
  failureLocation: FailureLocationSchema.optional(),
  changedCodeEvidence: z.enum([
    'stack-frame',
    'coverage-of-changed-function',
    'coverage-of-changed-lines',
    'none'
  ]),
  durationMs: z.number()
});

export const ExistingSuiteSchema = z.object({
  ran: z.boolean(),
  passed: z.number().int(),
  failed: z.number().int(),
  total: z.number().int(),
  error: z.string().optional()
});

export const VerificationResultSchema = z.object({
  testFile: z.string(),
  scenarioId: z.string().optional(),
  scenarioTitle: z.string().optional(),
  verdict: VerdictSchema,
  confidence: ConfidenceSchema,
  reasons: z.array(z.string()),
  fixedCheck: z.enum([
    'passed',
    'still_failing',
    'not_run',
    'flaky',
    'invalid',
    'patch_failed'
  ]),
  revisions: z.object({
    base: RevisionResultSchema,
    head: RevisionResultSchema,
    fixed: RevisionResultSchema.optional()
  }),
  existingSuite: ExistingSuiteSchema,
  fixedExistingSuite: ExistingSuiteSchema.optional(),
  testFileIntact: z.boolean().optional(),
  fixedPatchStats: z
    .object({
      filesChanged: z.number().int(),
      insertions: z.number().int(),
      deletions: z.number().int(),
      files: z.array(z.string())
    })
    .optional(),
  isolation: z.enum(['process', 'docker']),
  repeat: z.number().int(),
  timeoutMs: z.number().int(),
  durationMs: z.number().int(),
  generatedAt: z.string()
});

export type Verdict = z.infer<typeof VerdictSchema>;
export type Confidence = z.infer<typeof ConfidenceSchema>;
export type FailureType = z.infer<typeof FailureTypeSchema>;
export type TestStatus = z.infer<typeof TestStatusSchema>;
export type TestCaseResult = z.infer<typeof TestCaseSchema>;
export type TestRunResult = z.infer<typeof TestRunSchema>;
export type RevisionResult = z.infer<typeof RevisionResultSchema>;
export type ExistingSuite = z.infer<typeof ExistingSuiteSchema>;
export type VerificationResult = z.infer<typeof VerificationResultSchema>;
export type FailureLocation = z.infer<typeof FailureLocationSchema>;
