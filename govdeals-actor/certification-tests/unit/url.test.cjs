let mod;
beforeAll(async () => { mod = await import('../../src/govdeals/url.js'); });

test('GovDeals identity is seller+asset collision safe', () => {
  const id = mod.parseAssetIdentity('https://prod-seo.govdeals.com/en/asset/41319/782?utm_source=x');
  expect(id.assetId).toBe('41319');
  expect(id.sellerAccountId).toBe('782');
  expect(id.externalId).toBe('govdeals-782-41319');
  expect(id.lotNumberDerived).toBe('782-41319');
});

test('canonical URL removes tracking parameters', () => {
  expect(mod.canonicalizeGovDealsUrl('https://prod-seo.govdeals.com/en/asset/41319/782?utm_source=x#frag'))
    .toBe('https://prod-seo.govdeals.com/en/asset/41319/782');
});

test('recheck identity accepts asset URL, account-first external ID, and asset/account pair', () => {
  expect(mod.parseRecheckIdentity('https://www.govdeals.com/en/asset/795/28251').externalId).toBe('govdeals-28251-795');
  expect(mod.parseRecheckIdentity('govdeals-28251-795').assetId).toBe('795');
  expect(mod.parseRecheckIdentity('795/28251').sellerAccountId).toBe('28251');
  expect(mod.parseRecheckIdentity({ assetId: 795, accountId: 28251 }).externalId).toBe('govdeals-28251-795');
  expect(mod.parseRecheckIdentity('not-a-lot')).toBeNull();
});
