const fs=require('fs'); const path=require('path');
let mod; beforeAll(async()=>{mod=await import('../../src/publicsurplus/discovery.js')});
const fixture=()=>fs.readFileSync(path.join(__dirname,'../fixtures/publicsurplus-discovery.html'),'utf8');
test('exhaustive seeds include active, home, new, and closing partitions',()=>{const s=mod.exhaustiveSeedRequests();expect(s.map(x=>x.partition)).toEqual(expect.arrayContaining(['global_active','home_regions','new_24h','closing_24h']));});
test('discovery parser finds regions and agency partitions',()=>{const r=mod.parseDiscoveryLinks(fixture(),'https://www.publicsurplus.com/sms/browse/home');const parts=r.map(x=>x.partition);expect(parts.some(x=>x.startsWith('region:'))).toBe(true);expect(parts.some(x=>x.startsWith('agency:'))).toBe(true);expect(parts).toEqual(expect.arrayContaining(['new_24h','closing_24h']));});
