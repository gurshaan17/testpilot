/**
 * Persisted repair result shapes.
 */
import { z } from 'zod';
import { RepairProposalSchema } from './agent';

export const RepairStatusSchema = z.enum([
  'fixed',
  'fixed_by_revert',
  'failed',
  'skipped'
]);

export const UsageSchema = z.object({
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  totalTokens: z.number().int()
});

export const GuardOutcomeSchema = z.object({
  name: z.string(),
  ok: z.boolean(),
  reason: z.string()
});

export const PatchStatsSchema = z.object({
  filesChanged: z.number().int(),
  insertions: z.number().int(),
  deletions: z.number().int(),
  files: z.array(z.string())
});

export const AttemptVerificationSchema = z.object({
  verdict: z.string(),
  confidence: z.string(),
  fixedCheck: z.string(),
  fixedStatus: z.string().optional(),
  fixedExistingSuite: z
    .object({
      ran: z.boolean(),
      passed: z.number().int(),
      failed: z.number().int(),
      total: z.number().int()
    })
    .optional(),
  testFileIntact: z.boolean().optional(),
  reasons: z.array(z.string())
});

export const RepairAttemptSchema = z.object({
  attempt: z.number().int(),
  proposal: RepairProposalSchema.optional(),
  editsApplied: z.boolean(),
  patch: z.string().optional(),
  patchStats: PatchStatsSchema.optional(),
  guards: z.array(GuardOutcomeSchema),
  verification: AttemptVerificationSchema.optional(),
  failure: z.string().optional(),
  provider: z.string(),
  model: z.string(),
  usage: UsageSchema,
  durationMs: z.number().int()
});

export const RepairResultSchema = z.object({
  status: RepairStatusSchema,
  reasons: z.array(z.string()),
  attempts: z.array(RepairAttemptSchema),
  patch: z.string().optional(),
  patchStats: PatchStatsSchema.optional(),
  filesTouched: z.array(z.string()),
  restoresBase: z.boolean(),
  preservesPrIntent: z.boolean(),
  intentNote: z.string(),
  provider: z.string(),
  model: z.string(),
  totalUsage: UsageSchema,
  durations: z.object({ totalMs: z.number().int() }),
  generatedAt: z.string()
});

export type RepairStatus = z.infer<typeof RepairStatusSchema>;
export type RepairAttempt = z.infer<typeof RepairAttemptSchema>;
export type RepairResult = z.infer<typeof RepairResultSchema>;
export type GuardOutcome = z.infer<typeof GuardOutcomeSchema>;