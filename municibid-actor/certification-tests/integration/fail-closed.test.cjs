const fs=require('fs');const path=require('path');
test('Municibid does not call PropertyRoom price-only early skip',()=>{const s=fs.readFileSync(path.join(__dirname,'../../src/extractors/municibid.js'),'utf8');expect(s).not.toMatch(/shouldEarlySkip\s*\(/);});
test('proxy configuration and health failures are fail-closed',()=>{const s=fs.readFileSync(path.join(__dirname,'../../src/extractors/municibid.js'),'utf8');expect(s).toMatch(/MUNICIBID_PROXY_CONFIGURATION_FAILED/);expect(s).toMatch(/MUNICIBID_HEALTH_FAIL/);});
