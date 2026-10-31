// Offline end-to-end test of the GovDeals API transport against a local mock of the maestro API.
// Run: node certification-tests/api/api-mock-test.mjs   (needs the "crawlee" package, or a stub, for logging.js)
// The mock data below is SYNTHETIC. Replace with real recorded responses (recordFixtures input) after the canary.
import http from 'node:http';
import assert from 'node:assert/strict';
import { createGovDealsCrawler } from '../../src/extractors/govdeals.js';
import { DedupeManager } from '../../src/utils/dedupe.js';
import { createLogger, initializeRunContext, resetRunStats } from '../../src/utils/logging.js';

const KEY = 'test-api-key-111';
const SUB = 'test-sub-key-222';

class MemKV {
  constructor() { this.m = new Map(); }
  async getValue(k) { return this.m.has(k) ? structuredClone(this.m.get(k)) : null; }
  async setValue(k, v) { this.m.set(k, structuredClone(v)); }
}
class MemDataset {
  constructor() { this.items = []; }
  async pushData(r) { this.items.push(r); }
}

// ── synthetic lots ────────────────────────────────────────────────────────
const lots = [];
for (let i = 1; i <= 25; i += 1) {
  lots.push({
    assetId: 1000 + i, accountId: 77, assetShortDescription: `Test lot ${i}`,
    currentBid: i === 23 || i === 24 ? 0 : 10 * i,
    ...(i === 24 ? { buyNowPrice: 30 } : {}),
    ...(i === 25 ? { startingBid: 7.5, buyNowPrice: 30 } : {}),
    assetAuctionEndDateUtc: '2030-01-01T12:00:00', categoryDescription: 'Electronics', makebrand: i < 4 ? 'Acme' : '',
    model: i < 4 ? `M${i}` : '', modelYear: '2020', locationCity: 'Fairfax', locationState: 'VA', locationZip: '22030',
    companyName: 'County of Test', isReserveNotMet: i % 5 === 0, bidCount: [23, 24, 25].includes(i) ? 0 : i, lotNumber: `L${i}`,
    photo: `thumb_${i}.jpg`, businessId: 'GD',
  });
}
// cross-listed duplicate of lot 3 under another business id
const withDup = () => [...lots, { ...lots[2], businessId: 'GI' }];

const calls = { search: 0, detail: 0, bidbox: 0, fees: 0, bad: 0, headersSeen: [], methods: [] };
let mode = 'ok'; // ok | auth | bidboxfail
let rateLeft = 0;

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const h = req.headers;
    calls.headersSeen.push(h);
    const send = (status, obj, extra = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...extra }); res.end(JSON.stringify(obj)); };
    calls.methods.push(`${req.method} ${req.url}`);
    const isBidbox = /^\/bids\/bidbox\//.test(req.url);
    if (isBidbox ? req.method !== 'GET' : req.method !== 'POST') return send(405, {});
    if (!h['x-api-correlation-id']) { calls.bad += 1; return send(400, { error: 'correlation' }); }
    if (mode === 'auth' || h['x-api-key'] !== KEY || h['ocp-apim-subscription-key'] !== SUB) return send(401, { error: `bad key ${h['x-api-key']}` });
    if (rateLeft > 0) { rateLeft -= 1; return send(429, {}, { 'retry-after': '0' }); }
    const j = body ? JSON.parse(body) : {};
    if (req.url === '/search/list') {
      calls.search += 1;
      const all = withDup();
      const start = (j.page - 1) * j.displayRows;
      return send(200, { assetSearchResults: all.slice(start, start + j.displayRows) }, { 'x-total-count': String(all.length) });
    }
    let m = req.url.match(/^\/assets\/(\d+)\/(\d+)\/false$/);
    if (m) {
      calls.detail += 1;
      if (!j.businessId) return send(200, {}); // blank record when body empty
      const lot = lots.find((l) => String(l.assetId) === m[1]);
      return send(200, {
        assetId: lot.assetId, accountId: 77, assetShortDescription: lot.assetShortDescription,
        assetLongDesc: lot.assetId === 1024
          ? '<p>Free shipping (USA only).</p>'
          : '<p>Working unit. <b>Pickup only</b>, inspection by appointment.</p>',
        willShip: lot.assetId === 1024 ? false : undefined, vinserial: `SN${lot.assetId}`,
        meterCount: '120', assetConditionCd: 'U', inspectionInstructions: 'Inspection: call ahead.', paymentInstructions: 'Payment required within 5 days.',
        removalInstructions: 'Removal within 10 days, appointment required.', specialInstructions: '',
        assetPhotos: [`${lot.assetId}-b.jpg`, { photoUrl: `/photos/77/${lot.assetId}-a.jpg` }],
        assetAttributeGroups: [{ groupName: 'Details', attributes: [{ attributeName: 'Condition', attributeValue: 'Used - Good' }, { attributeName: 'Color', attributeValue: 'Blue' }, { attributeName: 'Manufacturer', attributeValue: 'Acme Labs' }, { attributeName: 'Model', attributeValue: 'X-1' }] }],
        addressLine1: '1 Main St', city: 'Fairfax', state: 'VA', zipCode: '22030', saleEventTitle: 'Test Sale', auctionId: 555, assetAuctionEndDate: '2030-01-01T12:00:00',
      });
    }
    m = req.url.match(/^\/bids\/bidbox\/GD\/(\d+)\/(\d+)\/(\d+)$/);
    if (m) {
      calls.bidbox += 1;
      if (mode === 'bidboxfail') return send(404, {});
      return send(200, {
        premiumPercent: 18, bidCount: ['1024', '1025'].includes(m[1]) ? 0 : 4, bidIncrement: 5, auctionStartDate: '2029-12-20T09:00:00',
        requirements: m[1] === '1003' ? 'Restricted to registered business entities only' : '',
      });
    }
    m = req.url.match(/^\/assets\/(\d+)\/(\d+)\/assetadditionalfees$/);
    if (m) { calls.fees += 1; return send(200, { adminFeePercent: 0, adminFeeAmount: 0, additionalFees: [], totalFeeSumAmount: 0 }); }
    return send(404, {});
  });
});

await new Promise((r) => server.listen(0, r));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

const log = createLogger('test', false);
async function runOnce(extra = {}, shared = {}) {
  resetRunStats();
  initializeRunContext({ actorRunId: 'run', inputFingerprint: 'fp', sourceName: 'govdeals' });
  const stateKv = shared.stateKv ?? new MemKV();
  const dataset = shared.dataset ?? new MemDataset();
  const dedupeManager = new DedupeManager(stateKv, { log: createLogger('dedupe', false) });
  await dedupeManager.initialize();
  const seen = new Set();
  const crawler = createGovDealsCrawler({
    apiKey: KEY, subscriptionKey: SUB, apiBaseUrl: baseUrl, requestDelayMs: 0, displayRows: 10, maxConcurrency: 3,
    dataset, dedupeManager, seenExternalIds: seen, stateKvStore: stateKv, fixtureStore: new MemKV(),
    log, sleep: async () => {}, ...extra,
  });
  let error = null; let stats = null;
  try { stats = await crawler.run(); } catch (e) { error = e; }
  await dedupeManager.persist();
  return { stats: stats ?? crawler.govdealsStats, error, dataset, stateKv, seen };
}
const reset = () => { calls.search = 0; calls.detail = 0; calls.bidbox = 0; calls.fees = 0; };

// 1) First run: everything is new
let r1 = await runOnce();
assert.equal(r1.error, null, `first run error: ${r1.error}`);
assert.equal(r1.stats.health_status, 'DEGRADED');
assert.ok(r1.stats.health_warnings.includes('records_rejected:1'));
assert.equal(r1.stats.records_discovered, 25, 'cross-listed duplicate must be deduped');
assert.equal(r1.stats.duplicates_in_run, 1);
assert.equal(r1.dataset.items.length, 24);
assert.equal(calls.search, 3, '26 rows / 10 per page = 3 pages');
assert.equal(calls.detail, 25); assert.equal(calls.bidbox, 25); assert.equal(calls.fees, 0, 'fees endpoint (returned 0) is no longer used');
const rec = r1.dataset.items.find((x) => x.external_id === 'govdeals-77-1003');
assert.ok(rec, 'external_id format govdeals-{accountId}-{assetId}');
assert.equal(rec.listing_url, 'https://www.govdeals.com/en/asset/1003/77');
assert.equal(rec.current_price, 30);
assert.equal(rec.attributes.price_type, 'current_bid');
assert.equal(rec.attributes.bid_count, 4);
assert.equal(rec.buyers_premium, 5.4, 'premium = 18% of $30 bid');
assert.equal(rec.buyers_premium_source, 'GOVDEALS_BIDBOX_API');
assert.equal(rec.auction_end_time, '2030-01-01T12:00:00.000Z');
assert.ok(rec.image_urls.every((u) => u.startsWith('https://files.lqdt1.com/photos/77/')), 'photos are https://files.lqdt1.com/photos/{accountId}/{file}');
assert.equal(rec.image_urls.length, 2, 'search thumbnail is not mixed in when detail photos exist');
assert.equal(rec.primary_image_url, 'https://files.lqdt1.com/photos/77/1003-b.jpg', 'primary image = first detail photo, valid path');
// bidder restriction from bid box requirements
assert.equal(rec.requires_account_review, true);
assert.equal(rec.bidding_eligibility, 'BUSINESS_ENTITY_ONLY');
assert.match(rec.bidding_restriction_message, /registered business entities only/);
const unrestricted = r1.dataset.items.find((x) => x.external_id === 'govdeals-77-1004');
assert.equal(unrestricted.requires_account_review, false);
assert.equal(unrestricted.bidding_eligibility, 'UNKNOWN');
// bid box fields
assert.equal(rec.bid_count, 4); assert.equal(rec.bid_increment, 5);
assert.equal(rec.auction_start_time, '2029-12-20T09:00:00.000Z');
assert.equal(rec.attributes.auction_start_time_source, 'govdeals_bidbox_api');
assert.equal(rec.shipping_method, 'pickup_only');
assert.deepEqual(rec.source_record.search, lots[2], 'complete original search row is attached');
assert.equal(rec.source_record.detail.assetLongDesc, '<p>Working unit. <b>Pickup only</b>, inspection by appointment.</p>');
assert.equal(rec.source_record.bidbox.bidCount, 4);
// brand/model: from specs when the search row is empty (lot 1004), top-level on the record
assert.equal(unrestricted.brand, 'Acme Labs'); assert.equal(unrestricted.model, 'X-1');
assert.equal(rec.brand, 'Acme');
assert.match(rec.description, /Working unit\. Pickup only/);
assert.equal(rec.attributes?.trusted?.specs?.Color, 'Blue');
assert.equal(rec.source, 'govdeals');
assert.ok(/^[a-f0-9]{64}$/.test(rec.content_hash));
const noBidOpening = r1.dataset.items.find((x) => x.external_id === 'govdeals-77-1025');
assert.equal(noBidOpening.current_price, 7.5);
assert.equal(noBidOpening.attributes.price_type, 'starting_bid');
assert.equal(noBidOpening.attributes.bid_count, 0);
const noBidBuyNow = r1.dataset.items.find((x) => x.external_id === 'govdeals-77-1024');
assert.equal(noBidBuyNow.current_price, 30);
assert.equal(noBidBuyNow.attributes.price_type, 'buy_now');
assert.equal(noBidBuyNow.estimated_shipping, 0);
assert.equal(noBidBuyNow.shipping_method, 'free_shipping');
// headers: keys sent, unique correlation id per request, same session id per run
const hs = calls.headersSeen;
assert.equal(new Set(hs.map((h) => h['x-api-correlation-id'])).size, hs.length, 'correlation id unique per request');
assert.equal(new Set(hs.map((h) => h['x-ecom-session-id'])).size, 1, 'one session id per run');
assert.equal(hs[0]['x-user-id'], '-1');
assert.equal(hs[0]['x-referer'], 'https://www.govdeals.com/');
assert.equal(calls.bad, 0);
console.log('PASS 1  first run: 25 lots, 3 search pages, 25 detail + 25 bid box, premium/photos/primary image/eligibility/brand/model mapped');

// 2) Second run, nothing changed: search only, zero detail/fees, health still PASS
reset();
let r2 = await runOnce({}, { stateKv: r1.stateKv, dataset: new MemDataset() });
assert.equal(r2.error, null, `second run error: ${r2.error}`);
assert.equal(calls.search, 3); assert.equal(calls.detail, 0); assert.equal(calls.bidbox, 0);
assert.equal(r2.stats.unchanged_search_skipped, 25);
assert.equal(r2.stats.health_status, 'PASS');
assert.equal(r2.seen.size, 25, 'all ids reported for the touch path');
console.log('PASS 2  repeat run: 3 search requests, 0 detail, 0 bid box, health PASS, 25 ids touched');

// Targeted recheck refetches the exact lot and bypasses both search-index freshness and dedupe.
reset();
let rRecheck = await runOnce({ recheckLots: ['govdeals-77-1004'] }, { stateKv: r1.stateKv, dataset: new MemDataset() });
assert.equal(rRecheck.error, null, `targeted recheck error: ${rRecheck.error}`);
assert.equal(calls.search, 1); assert.equal(calls.detail, 1); assert.equal(calls.bidbox, 1);
assert.equal(rRecheck.stats.recheck_targets, 1); assert.equal(rRecheck.stats.records_saved, 1);
assert.equal(rRecheck.dataset.items[0].external_id, 'govdeals-77-1004');
assert.equal(rRecheck.stats.unchanged_search_skipped, 0);
console.log('PASS 2a recheckLots refetches one specified lot and bypasses existing dedupe state');

// 3) Price change on 2 lots: only those are re-fetched
lots[0].currentBid = 999; lots[6].currentBid = 888;
reset();
let r3 = await runOnce({}, { stateKv: r1.stateKv, dataset: new MemDataset() });
assert.equal(r3.error, null, `third run error: ${r3.error}`);
assert.equal(calls.detail, 2); assert.equal(calls.bidbox, 2);
assert.equal(r3.dataset.items.length, 2);
assert.deepEqual(r3.dataset.items.map((x) => x.current_price).sort((a, b) => a - b), [888, 999]);
console.log('PASS 3  2 lots changed price: exactly 2 detail + 2 bid box fetched, 2 records saved');

// 4) Canary shape: maxPages 1, maxItemsPerRun 5 on a fresh store
reset();
let r4 = await runOnce({ maxPages: 1, maxItemsPerRun: 5 });
assert.equal(r4.error, null, `canary error: ${r4.error}`);
assert.equal(calls.search, 1); assert.equal(calls.detail, 5); assert.equal(calls.bidbox, 5);
assert.equal(r4.dataset.items.length, 5);
assert.equal(r4.stats.records_discovered, 10);
console.log('PASS 4  canary shape: 1 search page, detail + bid box for first 5 only');

// 5) 429 then success (retry with backoff)
reset(); rateLeft = 2;
let r5 = await runOnce({ maxPages: 1, maxItemsPerRun: 1 });
assert.equal(r5.error, null, `retry run error: ${r5.error}`);
assert.ok(r5.stats.rate_limit_events >= 2 && r5.dataset.items.length === 1);
console.log('PASS 5  two 429s retried, run still succeeded');

// 6) Bid box failure is non-fatal to the run, but lots without all raw API objects are not saved.
reset(); mode = 'bidboxfail';
let r6 = await runOnce({ maxPages: 1, maxItemsPerRun: 3 });
mode = 'ok';
assert.match(r6.error?.message ?? '', /GOVDEALS_HEALTH_FAIL: queued_records_saved_zero/);
assert.equal(r6.stats.bidbox_failures, 3);
assert.equal(r6.dataset.items.length, 0);
assert.equal(r6.stats.validation_failures, 3);
assert.equal(r6.stats.records_rejected, 3);
console.log('PASS 6  bid box failure prevents saving lots with incomplete source_record evidence');

// 7) 401 is fatal and never leaks keys
reset(); mode = 'auth';
let r7 = await runOnce({ maxPages: 1 });
mode = 'ok';
assert.ok(r7.error, 'auth failure must fail the run');
assert.match(r7.error.message, /GOVDEALS_API_AUTH_FAILED/);
assert.ok(!r7.error.message.includes(KEY) && !r7.error.message.includes(SUB), 'keys never in errors');
assert.equal(r7.stats.access_denied_events >= 1, true);
console.log('PASS 7  401 fails the run with GOVDEALS_API_AUTH_FAILED, keys not leaked');

// 8) wrong key rejected too (mock returns 401 echoing the key header: must not surface)
reset();
let r8 = await runOnce({ apiKey: 'wrong-key-999', maxPages: 1 });
assert.ok(r8.error && /AUTH_FAILED/.test(r8.error.message) && !r8.error.message.includes('wrong-key-999'));
console.log('PASS 8  wrong key fails fast and is not echoed');

// 9) missing keys
let r9 = null;
try { createGovDealsCrawler({ dataset: new MemDataset(), dedupeManager: new DedupeManager(new MemKV(), { log }), log }).run().catch((e) => { r9 = e; }); } catch (e) { r9 = e; }
await new Promise((r) => setTimeout(r, 50));
assert.ok(r9 && /KEYS_MISSING/.test(r9.message));
console.log('PASS 9  missing keys fail with GOVDEALS_API_KEYS_MISSING');

// 10) Bid box is a GET, detail/search are POST
assert.ok(calls.methods.some((m) => m.startsWith('GET /bids/bidbox/GD/')), 'bid box uses GET');
assert.ok(calls.methods.some((m) => m.startsWith('POST /assets/')), 'detail uses POST');
console.log('PASS 10 bid box is GET, search/detail are POST');

// 11) content_hash is stable for unchanged lots across two independent runs (time_remaining must not be in the hash)
const a = await runOnce({ maxPages: 1, maxItemsPerRun: 10 });
await new Promise((r) => setTimeout(r, 1200)); // let observed time / time_remaining move
const b = await runOnce({ maxPages: 1, maxItemsPerRun: 10 });
assert.equal(a.dataset.items.length, 10); assert.equal(b.dataset.items.length, 10);
for (const ra of a.dataset.items) {
  const rb = b.dataset.items.find((x) => x.external_id === ra.external_id);
  assert.ok(rb, `lot ${ra.external_id} present in both runs`);
  assert.equal(ra.content_hash, rb.content_hash, `content_hash stable for ${ra.external_id}`);
}
assert.notEqual(a.dataset.items[0].observed_at ?? a.dataset.items[0].scraped_at, undefined);
console.log('PASS 11 content_hash identical for 10 unchanged lots across two runs');

server.close();
console.log('\nALL API MOCK TESTS PASSED');