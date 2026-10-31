let C;beforeAll(async()=>({SourceCircuitBreaker:C}=await import('../../src/liquidation/circuitBreaker.js')));
test('circuit opens on configured 403 streak',()=>{const c=new C({maxConsecutive403:2,maxConsecutive5xx:10,maxRateLimited:10});expect(c.note(403)).toBeNull();expect(c.note(403)).toMatch(/403/i);expect(()=>c.assertClosed()).toThrow();});
