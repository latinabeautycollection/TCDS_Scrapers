import assert from 'node:assert/strict';
import { updateCompleteness } from '../../src/liquidation/completeness.js';

const stats = {
  extraction_completeness: {},
  extraction_completeness_applicable: {},
};
updateCompleteness(stats, {
  external_id: 'liquidation-1', title: 'Lot', listing_url: 'https://example.test/1', current_price: 125,
  attributes: { price_type: 'starting_bid', auction_start_time_source: 'not_published_by_site' },
  estimated_shipping: 40.25, shipping_method: 'shipping', source_meta: { minimum_shipping_fee: 40.25 },
  auction_end_time: '2026-10-24T17:00:00.000Z', location: 'Town', seller_name: 'Seller', condition: 'USED',
}, 'extraction');
assert.equal(stats.extraction_completeness_total, 1);
for (const field of ['price_type', 'estimated_shipping', 'shipping_method', 'auction_start_time_source']) {
  assert.equal(stats.extraction_completeness[field], 1, `${field} should have a finite populated count`);
  assert.equal(stats.extraction_completeness_applicable[field], 1, `${field} should have a finite applicability count`);
}

const pickupStats = { extraction_completeness: {}, extraction_completeness_applicable: {} };
updateCompleteness(pickupStats, {
  current_price: 25, attributes: { price_type: 'starting_bid', auction_start_time_source: 'not_published_by_site' },
  estimated_shipping: null, shipping_method: 'pickup_only',
}, 'extraction');
assert.equal(pickupStats.extraction_completeness_applicable.estimated_shipping, 0);
assert.equal(pickupStats.extraction_completeness_applicable.shipping_method, 1);
assert.equal(Number.isFinite(pickupStats.extraction_completeness.estimated_shipping), true);
console.log('completeness tests: all passed');