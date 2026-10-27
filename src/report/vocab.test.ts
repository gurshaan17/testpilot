import assert from 'node:assert/strict';
import test from 'node:test';
import { bannerFor } from './vocab';

test('regression caught + fixed is green', () => {
  assert.deepEqual(bannerFor({ verdict: 'regression_caught', repairStatus: 'fixed' }), {
    state: 'caught_and_fixed',
    title: 'Regression caught and fixed',
    tone: 'green'
  });
});

test('regression caught + fixed_by_revert is amber', () => {
  const banner = bannerFor({ verdict: 'regression_caught', repairStatus: 'fixed_by_revert' });
  assert.equal(banner.state, 'caught_and_fixed_by_revert');
  assert.equal(banner.title, 'Regression caught and fixed by reverting the change');
  assert.equal(banner.tone, 'amber');
});

test('regression caught without a verified fix is amber', () => {
  for (const repairStatus of ['failed', 'skipped', undefined]) {
    const banner = bannerFor({ verdict: 'regression_caught', repairStatus });
    assert.equal(banner.state, 'caught_no_verified_fix');
    assert.equal(banner.title, 'Regression caught, no verified fix');
    assert.equal(banner.tone, 'amber');
  }
});

test('suspect is amber', () => {
  const banner = bannerFor({ verdict: 'regression_caught_suspect', repairStatus: 'fixed' });
  assert.equal(banner.state, 'suspect');
  assert.equal(banner.title, 'Suspect result, human review needed');
  assert.equal(banner.tone, 'amber');
});

test('not demonstrated is grey', () => {
  const banner = bannerFor({ verdict: 'not_demonstrated_passes_both' });
  assert.equal(banner.state, 'not_demonstrated');
  assert.equal(banner.title, 'No regression demonstrated');
  assert.equal(banner.tone, 'grey');
});

test('invalid, flaky, inconclusive and missing verdicts are inconclusive', () => {
  for (const verdict of ['invalid_fails_on_base', 'flaky', 'inconclusive', 'unknown', undefined]) {
    const banner = bannerFor({ verdict });
    assert.equal(banner.state, 'inconclusive');
    assert.equal(banner.title, 'Inconclusive');
    assert.equal(banner.tone, 'grey');
  }
});
