// Plain-node offline test (no dependencies): node certification-tests/unit/fieldRules.test.mjs
import assert from 'node:assert/strict';
import { applyIndexObservations, applyNoBidPolicy, cleanDescription, computeContentHash, applyIntakeFields, reapplyAfterAliases, validationShim, nullifyEmptyStrings, isNoBidLot, normalizeNoBidPolicy } from '../../src/liquidation/fieldRules.js';

// Search-card bid data is unsafe for sealed lots; preserve unknown detail fields.
const sealed = applyIndexObservations({ listing_type: 'SEALED_BID', bid_count: null, minimum_bid: null }, { bidCount: 64, currentPrice: 999 });
assert.equal(sealed.bid_count, null);
assert.equal(sealed.minimum_bid, null);
// Standard auctions still benefit from search-card observations.
const standard = applyIndexObservations({ listing_type: 'STANDARD_AUCTION', bid_count: null, minimum_bid: null }, { bidCount: 0, currentPrice: 100 });
assert.equal(standard.bid_count, 0);
assert.equal(standard.minimum_bid, 100);

// no-bid standard auction -> opening/minimum bid remains current_price
let r = applyNoBidPolicy({ listing_type: 'STANDARD_AUCTION', bid_count: 0, current_price: 100, minimum_bid: null }, 'NULL');
assert.equal(r.current_price, 100); assert.equal(r.minimum_bid, 100); assert.equal(r.starting_price, 100); assert.equal(r.price_type, 'starting_bid'); assert.equal(r.price_status, 'NO_BIDS_YET');
assert.equal(normalizeNoBidPolicy('NULL'), 'MINIMUM_BID');
// with bids: untouched
r = applyNoBidPolicy({ listing_type: 'STANDARD_AUCTION', bid_count: 3, current_price: 120 }, 'NULL');
assert.equal(r.current_price, 120);
// unknown bid count: untouched (never guess)
r = applyNoBidPolicy({ listing_type: 'STANDARD_AUCTION', bid_count: null, current_price: 120 }, 'NULL');
assert.equal(r.current_price, 120);
// legacy policy keeps the displayed amount
r = applyNoBidPolicy({ listing_type: 'STANDARD_AUCTION', bid_count: 0, current_price: 100 }, 'MINIMUM_BID');
assert.equal(r.current_price, 100);
// sealed bid is untouched
r = applyNoBidPolicy({ listing_type: 'SEALED_BID', bid_count: 0, current_price: null }, 'NULL');
assert.equal(r.current_price, null);

// description: line breaks kept, tags/entities cleaned, never the title, null when empty
assert.equal(cleanDescription('Line one<br>Line two &amp; three\n\n\nLine four', 'T'), 'Line one\nLine two & three\n\nLine four');
assert.equal(cleanDescription('Same Title', 'same title'), null);
assert.equal(cleanDescription('  \n View Manifest \n', 'x'), null);
assert.equal(cleanDescription(null, 'x'), null);

// intake overrides
const raw = {
  title: 'Mixed Lot', description: 'A\nB', buyers_premium_pct: 11, current_price: 100, buy_now_price: 550, price_type: 'starting_bid', price_status: 'NO_BIDS_YET', minimum_bid: 100, bid_count: 0,
  listing_type: 'STANDARD_AUCTION', location: '', images: ['https://x/z.jpg', 'https://x/a.jpg'], category: null, currency: 'USD',
  source_meta: { shipping_terms: 'We ship', manifest_html_url: 'https://www.liquidation.com/aucimg/1/m1.html' }, seller_name: 'acme',
};
const rec = { title: 'Mixed Lot', buyers_premium: 11 / 100 * 1, current_price: 0, location: 'REGO PARK, NY', category: 'slug', condition: 'RETURNS', auction_end_time: '2026-09-15T20:30:00.000Z', auction_status: 'ACTIVE', currency: 'USD', listing_url: 'https://www.liquidation.com/auction/view?id=1', brand: '', model: '' };
applyIntakeFields(rec, raw);
assert.equal(rec.buyers_premium, 11);                 // percent, not 0.11 / dollars
assert.equal(rec.current_price, 100);                 // published opening price is retained
assert.equal(rec.buy_now_price, 550);                 // separately published Buy Now amount is retained
assert.equal(rec.source_record, null);
assert.equal(rec.location, null);                     // empty -> null
assert.equal(rec.primary_image_url, 'https://x/z.jpg'); // first photo, not alphabetical
assert.equal(rec.brand, null);
assert.equal(rec.attributes.buyers_premium_source, 'published_percentage');
assert.equal(rec.attributes.manifest_html_url, 'https://www.liquidation.com/aucimg/1/m1.html');
assert.match(rec.content_hash, /^[0-9a-f]{64}$/);
assert.equal(isNoBidLot({ price_status: 'NO_BIDS_YET', current_price: null }), true);

// hash ignores run-specific fields and is stable
const a = { ...rec, scraped_at: '2026-10-15T00:00:00Z', actor_run_id: 'r1', time_remaining_seconds: 500 };
const b = { ...rec, scraped_at: '2026-10-16T00:00:00Z', actor_run_id: 'r2', time_remaining_seconds: 10 };
assert.equal(computeContentHash(a), computeContentHash(b));
assert.notEqual(computeContentHash({ ...rec, current_price: 50 }), computeContentHash(rec));
assert.notEqual(computeContentHash({ ...rec, buyers_premium: 12 }), computeContentHash(rec));

// aliases re-apply: site category kept as text, inbound fees null, nulls not ''
const after = { ...rec, category: 'general-merchandise', inbound_fees_usd: 11, description: '', image_urls: [] };
reapplyAfterAliases(after, { ...raw, category_name: 'General Merchandise' });
assert.equal(after.category, 'General Merchandise'); assert.equal(after.inbound_fees_usd, null); assert.equal(after.buy_now_price, 550);
assert.equal(after.description, 'A\nB'); assert.equal(after.image_urls.length, 2);

// validation shim: placeholders only on the copy
const shim = validationShim({ ...rec, description: null, condition: null });
assert.equal(shim.description, ''); assert.equal(rec.description, 'A\nB');
const o = nullifyEmptyStrings({ a: '', b: { c: ' ' }, d: 'x' }); assert.deepEqual(o, { a: null, b: { c: null }, d: 'x' });
// V1.1.2: shim gives the shared validator its attributes.trusted / attributes.mined buckets (copy only)
const shim2 = validationShim({ ...rec, attributes: { bid_count: 0 } });
assert.deepEqual(shim2.attributes.trusted, {}); assert.deepEqual(shim2.attributes.mined, {});
assert.equal(rec.attributes.trusted, undefined);           // stored record stays flat
assert.deepEqual(validationShim({ ...rec, attributes: undefined }).attributes, { trusted: {}, mined: {} });
// description: seller text often starts by repeating the title -> dropped, rest kept with line breaks
assert.equal(cleanDescription('New Bulk Lot of 100 Backpacks MSRP $5,000\nMixed colors\nDescription:\nWaterproof', 'New Bulk Lot of 100 Backpacks MSRP $5,000'), 'Mixed colors\nDescription:\nWaterproof');
// categories come from the site's breadcrumb
const rec2 = { title: 't', category: 'slug' }; applyIntakeFields(rec2, { ...raw, category: 'General Merchandise', subcategory: 'Office & School Supplies' });
assert.equal(rec2.category, 'General Merchandise'); assert.equal(rec2.subcategory, 'Office & School Supplies');
console.log('fieldRules tests: all passed');