let parsePublicSurplusDate; beforeAll(async()=>({parsePublicSurplusDate}=await import('../../src/publicsurplus/text.js')));
test.each([['Oct 8, 2026 1:00 PM EDT','2026-10-08T17:00:00.000Z'],['Oct 8, 2026 1:00 PM CDT','2026-10-08T18:00:00.000Z'],['Oct 8, 2026 1:00 PM MDT','2026-10-08T19:00:00.000Z'],['Oct 8, 2026 1:00 PM PDT','2026-10-08T20:00:00.000Z']])('timezone conversion %s',(input,expected)=>expect(parsePublicSurplusDate(input)).toBe(expected));
test('regional Eastern uses the auction date DST rule, and an unzoned clock is not guessed',()=>{
 expect(parsePublicSurplusDate('Oct 8, 2026 1:00 PM Eastern')).toBe('2026-10-08T17:00:00.000Z');
 expect(parsePublicSurplusDate('Jan 8, 2026 1:00 PM Eastern')).toBe('2026-01-08T18:00:00.000Z');
 expect(parsePublicSurplusDate('Oct 8, 2026 1:00 PM')).toBeNull();
});
