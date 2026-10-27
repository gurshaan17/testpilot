/**
 * Persisted shapes for the run store.
 */
import { z } from 'zod';

export const RUN_ID_PATTERN = /^run-[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$/;

export const RunIdSchema = z.string().regex(RUN_ID_PATTERN, 'invalid run id');

export const RunStatusSchema = z.enum(['running', 'done', 'failed']);

export const RunRecordSchema = z.object({
  runId: RunIdSchema,
  repoPath: z.string(),
  base: z.string(),
  head: z.string(),
  status: RunStatusSchema,
  stage: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  verdict: z.string().optional(),
  repairStatus: z.string().optional(),
  error: z.string().optional()
});

export const GenerationArtifactSchema = z.object({
  repo: z.string().optional(),
  base: z.object({ ref: z.string(), sha: z.string() }).optional(),
  head: z.object({ ref: z.string(), sha: z.string() }).optional(),
  generatedAt: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  promptVersion: z.string().optional(),
  totalUsage: z
    .object({
      inputTokens: z.number().optional(),
      outputTokens: z.number().optional(),
      totalTokens: z.number().optional()
    })
    .optional(),
  scenarios: z
    .array(
      z.object({
        id: z.string().optional(),
        title: z.string().optional(),
        risk: z.string().optional(),
        kind: z.string().optional(),
        severity: z.string().optional(),
        status: z.string().optional(),
        fileName: z.string().optional(),
        evidence: z
          .array(
            z.object({
              file: z.string(),
              line: z.number(),
              note: z.string().optional()
            })
          )
          .optional()
      })
    )
    .optional()
});

export const TimelineSchema = z.object({
  head: z.string().optional(),
  base: z.string().optional(),
  totalMs: z.number().optional(),
  events: z
    .array(
      z.object({
        stage: z.string(),
        status: z.string(),
        detail: z.string().optional(),
        durationMs: z.number(),
        at: z.string()
      })
    )
    .optional()
});

export type RunRecord = z.infer<typeof RunRecordSchema>;
export type RunStatus = z.infer<typeof RunStatusSchema>;
export type GenerationArtifact = z.infer<typeof GenerationArtifactSchema>;
export type TimelineArtifact = z.infer<typeof TimelineSchema>;