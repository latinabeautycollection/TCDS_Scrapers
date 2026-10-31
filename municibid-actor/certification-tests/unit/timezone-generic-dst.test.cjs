let parseMunicibidDate;beforeAll(async()=>({parseMunicibidDate}=await import('../../src/municibid/text.js')));
test('generic CT is season-aware',()=>{expect(parseMunicibidDate('January 15, 2026 12:00 PM CT')).toBe('2026-01-15T18:00:00.000Z');expect(parseMunicibidDate('July 15, 2026 12:00 PM CT')).toBe('2026-07-15T17:00:00.000Z');});
test('generic MT/PT are season-aware',()=>{expect(parseMunicibidDate('January 15, 2026 12:00 PM MT')).toBe('2026-01-15T19:00:00.000Z');expect(parseMunicibidDate('July 15, 2026 12:00 PM PT')).toBe('2026-07-15T19:00:00.000Z');});
