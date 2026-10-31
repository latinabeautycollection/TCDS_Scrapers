// Offline behavioral check for targeted GovDeals rechecks; no network access is used.
import assert from 'node:assert/strict';
import { createGovDealsCrawler } from '../../src/extractors/govdeals.js';
import { searchFingerprint } from '../../src/govdeals/apiParser.js';

const targetRow = {
  assetId: 795, accountId: 28251, assetShortDescription: 'Test item', currentBid: 25,
  bidCount: 2, assetAuctionEndDateUtc: '2030-01-01T12:00:00Z', companyName: 'Test County',
  businessId: 'GD', locationCity: 'Fairfax', locationState: 'VA',
};
const detail = {
  assetId: 795, assetShortDescription: 'Test item', assetLongDesc: 'Shipping is available; ask seller for a quote.',
  assetAuctionStartDateUtc: '2029-12-20T09:00:00Z', auctionId: 550,
  city: 'Fairfax', state: 'VA', assetConditionCd: 'U',
  assetAttributeGroups: [{ attributes: [{ attributeName: 'Model', attributeValue: 'S60' }] }],
};
const bidbox = { bidCount: 2, premiumPercent: 10, auctionStartDate: '2029-12-20T09:00:00Z' };
const requests = [];
const fetchImpl = async (url, init) => {
  const body = init.body ? JSON.parse(init.body) : null;
  requests.push({ url: String(url), method: init.method, body });
  let payload;
  if (String(url).endsWith('/search/list')) {
    assert.equal(body.searchText, '795');
    assert.deepEqual(body.accountIds, ['28251']);
    payload = { assetSearchResults: [targetRow] };
  } else if (String(url).includes('/assets/795/28251/false')) payload = detail;
  else if (String(url).includes('/bids/bidbox/GD/795/28251/550')) payload = bidbox;
  else throw new Error(`Unexpected API request: ${url}`);
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-total-count': '1' },
  });
};
const dataset = { items: [], async pushData(item) { this.items.push(item); } };
const kv = {
  async getValue(key) {
    if (key !== 'GOVDEALS_SEARCH_INDEX') return null;
    return { entries: { 'govdeals-28251-795': { fp: searchFingerprint(targetRow), at: Date.now() } } };
  },
  async setValue() {},
};
let shouldProcessCalls = 0;
let markSeenCalls = 0;
const dedupeManager = {
  getEntry: () => ({ fingerprint: searchFingerprint(targetRow) }),
  async shouldProcess() { shouldProcessCalls += 1; return false; },
  async markSeenWithFingerprint() { markSeenCalls += 1; },
};
const log = { info() {}, warning() {}, error() {}, debug() {} };
const crawler = createGovDealsCrawler({
  apiKey: 'test-key', subscriptionKey: 'test-sub', apiBaseUrl: 'https://mock.invalid',
  requestDelayMs: 0, detailRefreshHours: 720, displayRows: 500, includeBidBox: true,
  recheckLots: ['govdeals-28251-795'], stateKvStore: kv, dataset, dedupeManager,
  seenExternalIds: new Set(), runContext: { actorRunId: 'recheck-test' },
  fetchImpl, log, sleep: async () => {},
});

const stats = await crawler.run();
assert.equal(requests.length, 3, 'only one targeted search, detail, and bid-box request occur');
assert.equal(requests.filter((r) => r.url.endsWith('/search/list')).length, 1);
assert.equal(requests.filter((r) => r.url.includes('/assets/')).length, 1);
assert.equal(requests.filter((r) => r.url.includes('/bids/bidbox/')).length, 1);
assert.equal(stats.recheck_targets, 1);
assert.equal(stats.records_saved, 1);
assert.equal(stats.unchanged_search_skipped, 0);
assert.equal(shouldProcessCalls, 0, 'recheck bypasses persistent dedupe');
assert.equal(markSeenCalls, 1);
assert.equal(dataset.items.length, 1);
assert.equal(dataset.items[0].external_id, 'govdeals-28251-795');
assert.equal(dataset.items[0].shipping_method, 'shipping_quote');
assert.equal(dataset.items[0].mpn, 'S60');
assert.deepEqual(dataset.items[0].source_record, { search: targetRow, detail, bidbox });
console.log('PASS targeted recheck fetches exactly one lot and bypasses fresh-index/dedupe skips');