let DedupeManager;
beforeAll(async () => ({ DedupeManager } = await import('../../src/utils/dedupe.js')));

function store(){return {value:null,async getValue(){return this.value;},async setValue(_k,v){this.value=v;}};}

test('same GovDeals fingerprint skips unchanged and changed fingerprint reprocesses across runs', async () => {
  const kv=store(); const opts={enableFingerprintRefresh:true,enableStaleRefresh:false,log:{info(){},warning(){}}};
  const d1=new DedupeManager(kv,opts); await d1.initialize();
  expect(await d1.shouldProcess('govdeals-782-41319','aaa')).toBe(true);
  await d1.markSeenWithFingerprint('govdeals-782-41319','aaa',{price:250});
  await d1.persist();

  const d2=new DedupeManager(kv,opts); await d2.initialize();
  expect(await d2.shouldProcess('govdeals-782-41319','aaa')).toBe(false);

  const d3=new DedupeManager(kv,opts); await d3.initialize();
  expect(await d3.shouldProcess('govdeals-782-41319','bbb')).toBe(true);
  expect(kv.value.entries['govdeals-782-41319'].source).toBe('govdeals');
});
