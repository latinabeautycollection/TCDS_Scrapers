let m; beforeAll(async()=>m=await import('../../src/liquidation/url.js'));
test('auction/view identity',()=>{const x=m.parseAuctionIdentity('https://www.liquidation.com/auction/view?id=21443326&utm_source=x');expect(x.externalId).toBe('liquidation-21443326');expect(x.canonicalUrl).toBe('https://www.liquidation.com/auction/view?id=21443326');});
test('rejects unrelated host',()=>expect(m.isLiquidationUrl('https://evil.example/')).toBe(false));
