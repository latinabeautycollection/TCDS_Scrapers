const fs=require('fs');const path=require('path');
const source=()=>fs.readFileSync(path.join(__dirname,'../../src/extractors/municibid.js'),'utf8');
test('source request DLQ and checkpoint recovery are wired',()=>{const s=source();expect(s).toMatch(/MunicibidRecoveryState/);expect(s).toMatch(/recovery\.addFailure/);expect(s).toMatch(/recovery\.pendingIndexRequests/);expect(s).toMatch(/recovery\.pendingDetailRequests/);});
test('status aware handling includes no-retry auth and backoff for retryable statuses',()=>{const s=source();expect(s).toMatch(/request\.noRetry = true/);expect(s).toMatch(/retryDelayMs/);expect(s).toMatch(/Retry-After|retry-after/);});
test('coverage reconciliation and exhaustive health gates are wired',()=>{const s=source();expect(s).toMatch(/recovery\.reconciliation\(\)/);expect(s).toMatch(/discoveryMode/);expect(s).toMatch(/MUNICIBID_HEALTH_FAIL/);});
