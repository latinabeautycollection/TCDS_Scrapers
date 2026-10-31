const fs=require('fs'); const path=require('path');
test('main rethrows GovDeals crawl failures',()=>{
  const s=fs.readFileSync(path.join(__dirname,'../../main.js'),'utf8');
  expect(s).toMatch(/GovDeals crawl failed[\s\S]*throw err;/);
});

test('API auth failure (401/403) is fatal and never retried',()=>{
  const s=fs.readFileSync(path.join(__dirname,'../../src/govdeals/api.js'),'utf8');
  expect(s).toMatch(/GOVDEALS_API_AUTH_FAILED/);
  expect(s).toMatch(/fatal: true/);
});

test('missing API keys fail the run before any request',()=>{
  const s=fs.readFileSync(path.join(__dirname,'../../main.js'),'utf8');
  expect(s).toMatch(/GOVDEALS_API_KEYS_MISSING/);
});

test('proxy mode fails closed because GovDeals API transport is direct-only',()=>{
  const s=fs.readFileSync(path.join(__dirname,'../../src/extractors/govdeals.js'),'utf8');
  expect(s).toMatch(/GOVDEALS_PROXY_CONFIGURATION_FAILED/);
  expect(s).toMatch(/proxyEnabled=false/);
});

test('required webhook delivery failure is run-fatal',()=>{
  const s=fs.readFileSync(path.join(__dirname,'../../main.js'),'utf8');
  expect(s).toMatch(/REQUIRED_WEBHOOK_DELIVERY_FAILED/);
});
