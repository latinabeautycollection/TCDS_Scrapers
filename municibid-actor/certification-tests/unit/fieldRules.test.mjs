// Run: node certification-tests/unit/fieldRules.test.mjs  (no dependencies)
import assert from 'node:assert/strict';
import { normalizeBlockText, redactContacts, cityState, nullifyEmptyStrings, computeContentHash, validationShim, applyNoBidRules } from '../../src/municibid/fieldRules.js';

// Line breaks kept, spaces collapsed
assert.equal(normalizeBlockText('Line one  \r\n\r\n\r\n\r\n  Line   two\n- item'), 'Line one\n\nLine two\n- item');

// Personal data out, prices and model numbers kept
const clean = redactContacts('Call (413) 555-0187 or 413-555-0112 ext. 4, email dpw@town.gov. Fee 10%. Ford F-250, 6.7L, $4,000.00');
assert.ok(!/555|@/.test(clean) && clean.includes('F-250') && clean.includes('$4,000.00'));
assert.equal(redactContacts(null), null);

// Municibid shows "City, ST" (no ZIP); ZIP kept when present
assert.equal(cityState('Springfield, MA'), 'Springfield, MA');
assert.equal(cityState('Salt Lake City, UT 84115'), 'Salt Lake City, UT 84115');
assert.equal(cityState('nothing here'), null);

// Empty strings -> null
const o = { a: '', b: ' ', c: 'x', d: 0, attributes: { f: '', g: 1 }, arr: [''] };
nullifyEmptyStrings(o);
assert.deepEqual(o, { a: null, b: null, c: 'x', d: 0, attributes: { f: null, g: 1 }, arr: [''] });

// Hash: stable, excludes run-specific fields, changes with price/status
const base = { source: 'municibid', external_id: 'municibid-1', title: 'T', current_price: null, auction_end_time: '2026-10-15T18:31:00.000Z', auction_status: 'ACTIVE', condition: 'USED', buyers_premium: 10, location: 'Springfield, MA', minimum_bid: 25 };
const h1 = computeContentHash(base);
assert.match(h1, /^[a-f0-9]{64}$/);
assert.equal(computeContentHash({ ...base, time_remaining_seconds: 99, scraped_at: 'x', observed_at: 'y', actor_run_id: 'z' }), h1);
assert.notEqual(computeContentHash({ ...base, current_price: 30 }), h1);
assert.notEqual(computeContentHash({ ...base, auction_status: 'ENDED' }), h1);

// Validation shim does not mutate the record
const orig = { current_price: null, category: null, description: null, actor_task_id: null };
const sh = validationShim(orig);
assert.equal(sh.current_price, 0); assert.equal(sh.category, ''); assert.equal(sh.actor_task_id, '');
assert.equal(orig.current_price, null);

// No-bid rules
let r = applyNoBidRules({ current_price: 0, bid_count: 0, starting_price: 25, minimum_bid: null, source_meta: {} });
assert.equal(r.current_price, 25, 'no bids uses the published opening bid');
assert.equal(r.minimum_bid, 25); assert.equal(r.bid_count, 0); assert.equal(r.source_meta.price.no_bids, true);
r = applyNoBidRules({ current_price: null, bid_count: null, starting_price: 10, source_meta: {} });
assert.equal(r.bid_count, null); assert.equal(r.source_meta.bid_count_inferred, undefined); assert.equal(r.minimum_bid, undefined);
r = applyNoBidRules({ current_price: 150, bid_count: 4, starting_price: 10, source_meta: {} });
assert.equal(r.current_price, 150, 'lot with bids untouched'); assert.equal(r.minimum_bid ?? null, null);
r = applyNoBidRules({ current_price: null, bid_count: 3, source_meta: {} });
assert.equal(r.current_price, null); assert.equal(r.bid_count, 3, 'null price with bids is not treated as no-bid (rejected later)');
// Real data: no-bid lots show their starting bid as "Current Bid" (e.g. lot 82864369: $1,000, 0 bids)
r = applyNoBidRules({ current_price: 1000, bid_count: 0, starting_price: null, source_meta: {} });
assert.equal(r.current_price, 1000, 'no bids keeps the displayed opening bid');
assert.equal(r.minimum_bid, 1000, 'the displayed starting bid becomes minimum_bid');
console.log('ALL municibid fieldRules TESTS PASSED');