import assert from 'node:assert/strict';
import { buildRecheckBootstrapRequests, buildRecheckRequests } from '../../src/publicsurplus/recheck.js';

const requests = buildRecheckRequests([
  '4046000',
  'publicsurplus-4094908',
  'https://www.publicsurplus.com/sms/auction/view?auc=4046000',
  'https://www.publicsurplus.com/sms/all%2Cca/auction/view?auc=4102888',
], 'run1');
assert.equal(requests.length, 3, 'duplicate lot IDs resolve to one request');
assert.deepEqual(requests.map((r) => r.url), [
  'https://www.publicsurplus.com/sms/auction/view?auc=4046000',
  'https://www.publicsurplus.com/sms/auction/view?auc=4094908',
  'https://www.publicsurplus.com/sms/all%2Cca/auction/view?auc=4102888',
]);
assert.ok(requests.every((r) => r.userData.type === 'detail' && r.userData.recheck));
assert.equal(buildRecheckBootstrapRequests(['https://register.publicsurplus.com/sms/auction/view?auc=4102888'], 'run2')[0].userData.recheck, true);
assert.equal(requests[2].userData.referer, 'https://www.publicsurplus.com/sms/all%2Cca/browse/home');
assert.equal(buildRecheckBootstrapRequests([
  'https://www.publicsurplus.com/sms/all%2Cca/auction/view?auc=4102888',
  'https://www.publicsurplus.com/sms/all%2Cca/auction/view?auc=4094908',
  'https://register.publicsurplus.com/sms/auction/view?auc=4046000',
], 'run3').length, 2, 'session bootstrap requests are unique by origin and route');
assert.throws(() => buildRecheckRequests(['not-a-lot-id']), /INVALID_PUBLICSURPLUS_RECHECK_TARGET/);
assert.throws(() => buildRecheckRequests(['https://example.com/sms/auction/view?auc=4046000']), /INVALID_PUBLICSURPLUS_RECHECK_TARGET/);
assert.equal(buildRecheckRequests(['https://register.publicsurplus.com/sms/auction/view?auc=4102888'], 'run2')[0].url, 'https://register.publicsurplus.com/sms/auction/view?auc=4102888');
assert.equal(buildRecheckRequests(['https://publicsurplus.com/sms/auction/view?auc=4102888'], 'run4')[0].url, 'https://publicsurplus.com/sms/auction/view?auc=4102888');
console.log('ALL recheck TESTS PASSED');