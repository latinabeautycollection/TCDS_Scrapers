let detectEligibility; beforeAll(async()=>({detectEligibility}=await import('../../src/publicsurplus/eligibility.js')));
test('normal login-to-view-contact language is not treated as bid restriction',()=>expect(detectEligibility('Auction Contact Please login to view contact').bidding_eligibility).toBe('UNKNOWN'));
test('explicit account lock is fail-closed',()=>expect(detectEligibility('Your account is locked and not eligible to bid').bidding_allowed).toBe(false));
