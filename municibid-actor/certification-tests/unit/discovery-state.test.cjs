let mod;
beforeAll(async()=>{mod=await import('../../src/municibid/discovery.js');});
test('auctions state pages are discovered from live-style state navigation',()=>{
  const html='<html><body><a href="/auctions/pa">Pennsylvania</a><a href="/auctions/va">Virginia</a></body></html>';
  const r=mod.parseDiscoveryLinks(html,'https://municibid.com/auctions');
  const parts=r.map(x=>x.partition);
  expect(parts).toEqual(expect.arrayContaining(['state:PA','state:VA']));
});
