let detectEligibility;
beforeAll(async () => ({ detectEligibility } = await import('../../src/govdeals/eligibility.js')));

test('locked bidder account fails closed', () => {
  const r = detectEligibility('Your account is locked from bidding on this asset.');
  expect(r.bidding_allowed).toBe(false);
  expect(r.bidding_eligibility).toBe('LOCKED');
  expect(r.requires_account_review).toBe(true);
});
