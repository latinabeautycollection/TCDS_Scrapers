const fs=require('fs'); const path=require('path');
test('dataset write occurs before dedupe commit',()=>{
  const s=fs.readFileSync(path.join(__dirname,'../../src/extractors/govdeals.js'),'utf8');
  const write=s.indexOf('await dataset.pushData(record)');
  const commit=s.indexOf('await dedupeManager.markSeenWithFingerprint(record.external_id');
  expect(write).toBeGreaterThan(-1); expect(commit).toBeGreaterThan(write);
});

test('GovDeals extractor does not invoke price-only early skip',()=>{
  const s=fs.readFileSync(path.join(__dirname,'../../src/extractors/govdeals.js'),'utf8');
  expect(s).not.toMatch(/shouldEarlySkip\s*\(/);
});
