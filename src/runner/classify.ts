/**
 * Pure verdict classification. Every input comes from the test runner's
 * output (exit codes and parsed Jest JSON); no LLM is involved.
 */
import type {
  Confidence,
  FailureType,
  RevisionResult,
  Verdict
} from './schema';

export interface ClassificationInput {
  base: RevisionResult;
  head: RevisionResult;
  fixed?: RevisionResult;
  repeat: number;
  /** True when the head failure was traced to code that the change touched. */
  headFailureInChangedCode: boolean;
}

export interface Classification {
  verdict: Verdict;
  confidence: Confidence;
  reasons: string[];
  fixedCheck: 'passed' | 'still_failing' | 'not_run' | 'flaky' | 'invalid';
}

function failedType(revision: RevisionResult): FailureType | undefined {
  if (revision.stable && revision.consistentStatus === 'failed') return revision.failureType;
  return undefined;
}

function baseIsInvalid(revision: RevisionResult): boolean {
  if (revision.consistentStatus === 'failed') return true;
  // A suite that fails to compile is an invalid test, not infrastructure.
  return (
    revision.consistentStatus === 'error' && revision.failureType === 'compile-error'
  );
}

function isInfrastructureProblem(revision: RevisionResult): boolean {
  if (revision.consistentStatus === 'timeout') return true;
  if (revision.consistentStatus === 'error') return !baseIsInvalid(revision);
  return revision.runs.some((run) => run.status === 'timeout');
}

/**
 * Confidence rules, in one place:
 *   high   = regression_caught, at least 3 stable runs on every revision, and
 *            the head failure traced into a changed file.
 *   medium = caught, but fewer runs or no changed-code evidence.
 *   low    = suspect (a human should look).
 * `high` is never emitted for any other verdict.
 */
export function classify(input: ClassificationInput): Classification {
  const reasons: string[] = [];
  const { base, head, fixed } = input;

  const basePassed = base.stable && base.consistentStatus === 'passed';
  const headPassed = head.stable && head.consistentStatus === 'passed';
  const headFailed = head.stable && head.consistentStatus === 'failed';

  if (!base.stable || !head.stable) {
    const unstable = [!base.stable ? 'base' : null, !head.stable ? 'head' : null]
      .filter(Boolean)
      .join(' and ');
    return {
      verdict: 'flaky',
      confidence: 'low',
      reasons: [`Test status was not stable on ${unstable}.`],
      fixedCheck: 'not_run'
    };
  }

  if (isInfrastructureProblem(base)) {
    return {
      verdict: 'inconclusive',
      confidence: 'low',
      reasons: ['The test could not be executed reliably on the base revision.'],
      fixedCheck: 'not_run'
    };
  }

  if (baseIsInvalid(base)) {
    return {
      verdict: 'invalid_fails_on_base',
      confidence: 'high',
      reasons: [
        `The test ${base.consistentStatus} on the base revision, so it does not describe base behavior.`,
        ...(base.failureType ? [`Base failure type: ${base.failureType}.`] : [])
      ],
      fixedCheck: 'not_run'
    };
  }

  if (headPassed) {
    return {
      verdict: 'not_demonstrated_passes_both',
      confidence: 'high',
      reasons: ['The test passed on both base and head, so it does not detect the change.'],
      fixedCheck: fixed ? 'passed' : 'not_run'
    };
  }

  if (head.consistentStatus === 'error' || head.consistentStatus === 'timeout') {
    return {
      verdict: 'regression_caught_suspect',
      confidence: 'low',
      reasons: [
        `The test ${head.consistentStatus} on the head revision, which is not a behavioural difference.`,
        'A human should review this result.'
      ],
      fixedCheck: 'not_run'
    };
  }

  if (!headFailed) {
    return {
      verdict: 'inconclusive',
      confidence: 'low',
      reasons: ['The head revision produced an unusable result.'],
      fixedCheck: 'not_run'
    };
  }

  const headType = failedType(head) ?? 'runtime-error';
  const strongFailure = headType === 'assertion' || headType === 'runtime-error';

  if (!strongFailure) {
    return {
      verdict: 'regression_caught_suspect',
      confidence: 'low',
      reasons: [
        `The head failure type was ${headType}, not a behavioural difference.`,
        'A human should review this result.'
      ],
      fixedCheck: 'not_run'
    };
  }

  if (!input.headFailureInChangedCode) {
    return {
      verdict: 'regression_caught_suspect',
      confidence: 'low',
      reasons: [
        'The head failure could not be traced into a file that the change touched.',
        'A human should review this result.'
      ],
      fixedCheck: 'not_run'
    };
  }

  reasons.push(
    'The test passed on base and failed on head with a behavioural failure.',
    `Head failure type: ${headType}.`
  );
  if (head.failureLocation) {
    reasons.push(
      `Failure located in ${head.failureLocation.file}:${head.failureLocation.line}, which the change touched.`
    );
  } else {
    reasons.push('The failing test exercises the changed function.');
  }

  if (fixed) {
    if (!fixed.stable) {
      return {
        verdict: 'flaky',
        confidence: 'low',
        reasons: [...reasons, 'The fixed revision was unstable.'],
        fixedCheck: 'flaky'
      };
    }
    if (fixed.consistentStatus === 'passed') {
      reasons.push('The test passed on the fixed revision, confirming the bug was reverted.');
      const allStable = base.stable && head.stable && fixed.stable;
      const hasLocation = Boolean(head.failureLocation);
      const confidence: Confidence =
        allStable && input.repeat >= 3 && hasLocation ? 'high' : 'medium';
      return { verdict: 'regression_caught', confidence, reasons, fixedCheck: 'passed' };
    }
    reasons.push('The test still fails on the fixed revision.');
    return {
      verdict: 'regression_caught_suspect',
      confidence: 'low',
      reasons,
      fixedCheck: 'still_failing'
    };
  }

  const confidence: Confidence =
    input.repeat >= 3 && Boolean(head.failureLocation) ? 'high' : 'medium';

  return { verdict: 'regression_caught', confidence, reasons, fixedCheck: 'not_run' };
}
