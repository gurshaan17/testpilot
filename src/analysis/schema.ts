/**
 * Zod schema for the deterministic analysis report.
 */
import { z } from 'zod';

export const LineRangeSchema = z.object({
  start: z.number().int(),
  end: z.number().int()
});

export const ChangedFileSchema = z.object({
  path: z.string(),
  status: z.enum(['added', 'modified', 'deleted']),
  changedLineRanges: z.array(LineRangeSchema),
  diff: z.string()
});

export const TestRunSchema = z.object({
  file: z.string(),
  passed: z.boolean(),
  durationMs: z.number()
});

export const ChangedLineCoverageSchema = z.object({
  percentage: z.number(),
  coveredLines: z.array(z.number().int()),
  uncoveredLines: z.array(z.number().int())
});

export const ChangedFunctionSchema = z.object({
  name: z.string(),
  qualifiedName: z.string(),
  file: z.string(),
  startLine: z.number().int(),
  endLine: z.number().int(),
  signature: z.string(),
  diff: z.string(),
  changedLineCoverage: ChangedLineCoverageSchema,
  coveringTests: z.array(z.string())
});

export const OtherChangeSchema = z.object({
  file: z.string(),
  range: LineRangeSchema
});

export const ImpactNodeSchema = z.object({
  id: z.string(),
  name: z.string(),
  qualifiedName: z.string(),
  file: z.string(),
  startLine: z.number().int(),
  endLine: z.number().int(),
  depth: z.number().int(),
  coveringTests: z.array(z.string()),
  testNameMatches: z.array(z.string())
});

export const ImpactEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  file: z.string(),
  line: z.number().int()
});

export const UnresolvedReferenceSchema = z.object({
  from: z.string(),
  file: z.string(),
  line: z.number().int(),
  reason: z.string()
});

export const AnalysisReportSchema = z.object({
  repo: z.string(),
  base: z.object({ ref: z.string(), sha: z.string() }),
  head: z.object({ ref: z.string(), sha: z.string() }),
  generatedAt: z.string(),
  baseline: z.object({
    testFiles: z.array(TestRunSchema),
    failures: z.array(TestRunSchema)
  }),
  changedFiles: z.array(ChangedFileSchema),
  changedTestFiles: z.array(ChangedFileSchema),
  changedFunctions: z.array(ChangedFunctionSchema),
  otherChanges: z.array(OtherChangeSchema),
  impactGraph: z.object({
    nodes: z.array(ImpactNodeSchema),
    edges: z.array(ImpactEdgeSchema)
  }),
  callersWithoutTests: z.array(ImpactNodeSchema),
  unresolvedReferences: z.array(UnresolvedReferenceSchema)
});

export type AnalysisReport = z.infer<typeof AnalysisReportSchema>;
export type ChangedFunction = z.infer<typeof ChangedFunctionSchema>;
export type ImpactNode = z.infer<typeof ImpactNodeSchema>;
export type ImpactEdge = z.infer<typeof ImpactEdgeSchema>;
export type UnresolvedReference = z.infer<typeof UnresolvedReferenceSchema>;
export type TestRun = z.infer<typeof TestRunSchema>;
export type LineRange = z.infer<typeof LineRangeSchema>;