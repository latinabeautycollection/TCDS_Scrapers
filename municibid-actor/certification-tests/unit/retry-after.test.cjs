let retryDelayMs; beforeAll(async()=>({retryDelayMs}=await import('../../src/extractors/municibid.js')));
test('429 Retry-After seconds is honored',()=>{expect(retryDelayMs(429,0,{headers:{'retry-after':'10'}},0)).toBe(10000);});
test('429 Retry-After HTTP date is honored',()=>{const now=Date.parse('2026-10-08T12:00:00Z');expect(retryDelayMs(429,0,{headers:{'retry-after':'Thu, 08 Oct 2026 12:00:30 GMT'}},now)).toBe(30000);});
