// Run: node certification-tests/unit/fieldRules.test.mjs  (no dependencies)
import assert from 'node:assert/strict';
import { isItemPhotoUrl, filterItemPhotos, normalizeCondition, applyNoBidRules, classifyPublicSurplusShipping, normalizeBlockText, redactContacts, cityStateZip, nullifyEmptyStrings, computeContentHash, validationShim } from '../../src/publicsurplus/fieldRules.js';

// Photos: the live canary returned only language-flag icons
const flags = ['en', 'es', 'fr'].map((l) => `https://www.publicsurplus.com/sms/20260805/images/ps/${l}.png`);
assert.deepEqual(filterItemPhotos(flags), [], 'language flags are not item photos');
assert.equal(isItemPhotoUrl('https://www.publicsurplus.com/sms/images/logo.png'), false);
assert.equal(isItemPhotoUrl('https://www.publicsurplus.com/img/facebook.png'), false);
assert.equal(isItemPhotoUrl('https://cdn.example.com/items/4100983/photo1.jpg'), true);
assert.deepEqual(filterItemPhotos([...flags, 'https://cdn.example.com/a.jpg', 'https://cdn.example.com/a.jpg']), ['https://cdn.example.com/a.jpg']);
assert.equal(isItemPhotoUrl('data:image/png;base64,AAAA'), false);

// Condition: keep the label, never the description
assert.equal(normalizeCondition('SEE DESCRIPTION Dell Laptop Bag LOT Q'), 'SEE DESCRIPTION');
assert.equal(normalizeCondition('GOOD Polycom VS4000 High Quality'), 'GOOD');
assert.equal(normalizeCondition('Like New with box'), 'LIKE NEW');
assert.equal(normalizeCondition(''), 'UNKNOWN');
assert.equal(normalizeCondition('Used'), 'USED');
assert.ok(normalizeCondition('Some unusual long free text condition that goes on and on').length <= 30);

// No-bid lot: the published minimum bid is its opening amount when no bids exist.
const noBid = () => ({ listing_type: 'AUCTION', current_price: null, minimum_bid: 25, bid_increment: 1, bid_count: 0,
  buyers_premium: null, buyers_premium_pct: 10, buyers_premium_source: 'DERIVED_FROM_PUBLISHED_PERCENTAGE', buyers_premium_confidence: 0.98,
  source_meta: { bid_increment: 1 } });
let r = applyNoBidRules(noBid());
assert.equal(r.current_price, 25, 'opening amount is used when no bids exist');
assert.equal(r.price_type, 'starting_bid');
assert.equal(r.bid_count, 0); assert.equal(r.minimum_bid, 25); assert.equal(r.buyers_premium, 2.5);
assert.equal(r.source_meta.price.source, 'publicsurplus_minimum_bid_no_bids'); assert.equal(r.source_meta.bid_count_inferred, undefined);
assert.equal(r.source_meta.bid_increment, 1, 'existing source_meta preserved');

// A displayed zero is not sent when a positive opening amount is available.
r = applyNoBidRules({ ...noBid(), current_price: 0 });
assert.equal(r.current_price, 25); assert.equal(r.price_type, 'starting_bid');
r = applyNoBidRules({ listing_type: 'AUCTION', current_price: null, minimum_bid: null, bid_count: 0, buy_now_price: 40, source_meta: {} });
assert.equal(r.current_price, 40); assert.equal(r.price_type, 'buy_now');
r = applyNoBidRules({ listing_type: 'AUCTION', current_price: null, minimum_bid: null, bid_count: 0, source_meta: {} });
assert.equal(r.current_price, null, 'missing all published prices remains unavailable and is rejected downstream');

// Lot with bids is untouched (canary lot 4098728: $162.50, 4 bids)
const bid = { listing_type: 'AUCTION', current_price: 162.5, minimum_bid: 165, bid_count: 4, buyers_premium: 16.25, buyers_premium_pct: 10, source_meta: {} };
applyNoBidRules(bid);
assert.equal(bid.price_type, 'current_bid'); assert.equal(bid.current_price, 162.5);

// Non-auction without price stays null (rejected downstream)
const fixed = { listing_type: 'FIXED_PRICE', current_price: null, minimum_bid: null, source_meta: {} };
const fixedWithBuyNow = applyNoBidRules({ ...fixed, buy_now_price: 75 });
assert.equal(fixedWithBuyNow.current_price, 75); assert.equal(fixedWithBuyNow.price_type, 'buy_now');

// Shipping evidence must distinguish free, priced, quote, and pickup; negatives win.
assert.deepEqual(classifyPublicSurplusShipping({ title: 'Lot - FREE SHIPPING', pickupText: 'Building A' }), {
  shipping_method: 'free_shipping', estimated_shipping: 0, shipping_evidence: 'Lot - FREE SHIPPING',
});
assert.deepEqual(classifyPublicSurplusShipping({ shippingText: 'Shipping: $15.00 standard, $8.00 economy' }), {
  shipping_method: 'shipping', estimated_shipping: 8, shipping_evidence: 'Shipping: $15.00 standard, $8.00 economy',
});
assert.equal(classifyPublicSurplusShipping({ description: 'Shipping is available; contact seller for quote.' }).shipping_method, 'shipping_quote');
assert.equal(classifyPublicSurplusShipping({ description: 'Shipping available. Buyer must pick up item at location.' }).shipping_method, 'pickup_only');
assert.deepEqual(classifyPublicSurplusShipping({ title: 'Free shipping USA only', description: 'No shipping outside USA.' }), {
  shipping_method: 'free_shipping', estimated_shipping: 0, shipping_evidence: 'Free shipping USA only',
}, 'geographic exclusions do not cancel a valid shipping offer');
assert.equal(classifyPublicSurplusShipping({ description: 'Ship loose items in the container.' }).shipping_method, 'pickup_only', 'bare ship wording is not a shipping offer');
assert.equal(classifyPublicSurplusShipping({ pickupText: '100 Main Street' }).shipping_evidence, 'Pick-up Location: 100 Main Street');

// Premium % missing (canary lot 4099621): price filled, premium stays null
const noPct = { ...noBid(), buyers_premium_pct: null, buyers_premium_source: null, buyers_premium_confidence: null };
r = applyNoBidRules(noPct);
assert.equal(r.current_price, 25); assert.equal(r.buyers_premium, null);

// ── Intake-guide helpers ──
assert.equal(normalizeBlockText('Line one  \r\n\r\n\r\n\r\n  Line   two\n- item'), 'Line one\n\nLine two\n- item', 'paragraph breaks kept, spaces collapsed');
assert.ok(!normalizeBlockText('a\n\n\n\nb').includes('\n\n\n'));

const dirty = 'Pickup by appt. Call (480) 555-0187 or 602-555-0112 ext. 4, email jane.doe@srp.net. Payment $4,000.00 limit. HP EliteBook 840 G3, 16GB.';
const clean = redactContacts(dirty);
assert.ok(!/555|@/.test(clean), 'phones and emails removed');
assert.ok(clean.includes('$4,000.00') && clean.includes('840 G3') && clean.includes('16GB'), 'prices and model numbers kept');
assert.equal(redactContacts(null), null);

assert.equal(cityStateZip('Salt River Project [7005 S. Kyrene Rd. Tempe, AZ 85283] 7005 S. Kyrene Rd. Tempe, AZ 85283'), 'Tempe, AZ 85283');
assert.equal(cityStateZip('County of Sonoma - Surplus Warehouse [2300 Professional Drive Santa Rosa, CA 95403]'), 'Santa Rosa, CA 95403');
assert.equal(cityStateZip('no address here'), null);

const o = { a: '', b: ' ', c: 'x', d: 0, e: null, attributes: { f: '', g: 1 }, arr: [''] };
nullifyEmptyStrings(o);
assert.deepEqual(o, { a: null, b: null, c: 'x', d: 0, e: null, attributes: { f: null, g: 1 }, arr: [''] });

const base = { source: 'publicsurplus', external_id: 'publicsurplus-1', title: 'T', current_price: null, auction_end_time: '2026-10-10T18:00:00.000Z', auction_status: 'ACTIVE', condition: 'GOOD', buyers_premium: 10, location: 'Tempe, AZ 85283', minimum_bid: 25 };
const h1 = computeContentHash(base);
assert.match(h1, /^[a-f0-9]{64}$/);
assert.equal(computeContentHash({ ...base, time_remaining_seconds: 1234, scraped_at: 'x', observed_at: 'y', actor_run_id: 'z' }), h1, 'run-specific fields are not in the hash');
assert.notEqual(computeContentHash({ ...base, current_price: 30 }), h1, 'price change changes the hash');
assert.notEqual(computeContentHash({ ...base, auction_status: 'ENDED' }), h1, 'status change changes the hash');
assert.equal(computeContentHash({ ...base }), h1, 'stable across calls');

// Real item photos (extensionless CloudFront URLs) are accepted; flags/logos still rejected
const thumb = 'https://d37qv0n5b4mbzm.cloudfront.net/sms/docviewer/cdnmainaucdoc/thumb-b/4098728/68492513';
assert.equal(isItemPhotoUrl(thumb), true, 'cloudfront item photo without extension');
const legacyThumb = 'https://d37qv0n5b4mbzm.cloudfront.net/sms/docviewer/cdnaucdoc/thumb-b/4094908/72081635';
assert.equal(isItemPhotoUrl(legacyThumb), true, 'observed Public Surplus gallery path without the main segment');
assert.equal(isItemPhotoUrl('https://d37qv0n5b4mbzm.cloudfront.net/sms/docviewer/logo/14348/226994'), false, 'seller logo is not an item photo');
assert.equal(filterItemPhotos([legacyThumb, legacyThumb]).length, 1, 'gallery photo URLs deduplicated');
assert.deepEqual(filterItemPhotos([...flags, thumb, legacyThumb, 'https://www.publicsurplus.com/sms/20260805/images/pslogo.svg']), [thumb, legacyThumb]);
assert.equal(isItemPhotoUrl('https://www.publicsurplus.com/sms/20260805/images/ps/img_indexcompu.jpg'), false);

// validation shim: nulls (guide) become legacy placeholders only for validation
const sh = validationShim({ current_price: null, category: null, subcategory: null, description: null, actor_task_id: null, location: 'x' });
assert.equal(sh.current_price, 0); assert.equal(sh.category, ''); assert.equal(sh.actor_task_id, ''); assert.equal(sh.location, 'x');
const orig = { current_price: null, category: null }; validationShim(orig);
assert.equal(orig.current_price, null, 'original record is not mutated');
console.log('ALL fieldRules TESTS PASSED');