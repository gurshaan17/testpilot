/**
 * One place that maps verdict + repair status to a report banner.
 */
export type BannerTone = 'green' | 'amber' | 'grey';

export type BannerState =
  | 'caught_and_fixed'
  | 'caught_and_fixed_by_revert'
  | 'caught_no_verified_fix'
  | 'suspect'
  | 'not_demonstrated'
  | 'inconclusive';

export interface Banner {
  state: BannerState;
  title: string;
  tone: BannerTone;
}

export function bannerFor(input: {
  verdict?: string;
  repairStatus?: string;
}): Banner {
  const { verdict, repairStatus } = input;

  if (verdict === 'regression_caught') {
    if (repairStatus === 'fixed') {
      return { state: 'caught_and_fixed', title: 'Regression caught and fixed', tone: 'green' };
    }
    if (repairStatus === 'fixed_by_revert') {
      return {
        state: 'caught_and_fixed_by_revert',
        title: 'Regression caught and fixed by reverting the change',
        tone: 'amber'
      };
    }
    return {
      state: 'caught_no_verified_fix',
      title: 'Regression caught, no verified fix',
      tone: 'amber'
    };
  }

  if (verdict === 'regression_caught_suspect') {
    return { state: 'suspect', title: 'Suspect result, human review needed', tone: 'amber' };
  }

  if (verdict === 'not_demonstrated_passes_both') {
    return { state: 'not_demonstrated', title: 'No regression demonstrated', tone: 'grey' };
  }

  return { state: 'inconclusive', title: 'Inconclusive', tone: 'grey' };
}

export function isVerifiedFailure(verdict?: string): boolean {
  return verdict === 'regression_caught';
}
