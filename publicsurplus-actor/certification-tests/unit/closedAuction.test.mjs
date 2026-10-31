import assert from 'node:assert/strict';
import { parseDetailPage } from '../../src/publicsurplus/parser.js';

const html = '<html><body><div class="content-subheading"><div class="nav-sub-head"><span class="text-wrap">Auction #4046000 - HARD DRIVE REMOVED ~ LAPTOP ~ JN-26-16 (R16D)</span></div><span>Auction Extended</span><span>(Reserve has been met)</span><span>Closed</span></div><a>[View Harris County Purchasing Auctions]</a><button>[View Terms and Conditions]</button><div>Auction Started Oct 12, 2026 07:48 AM MDT</div><div>Auction Ended Oct 19, 2026 09:03 AM MDT</div><div class="justify-content-end border-end"># of Bids</div><div><span id="noOfBids">10</span></div><div class="justify-content-end border-end">Final Price</div><div><strong id="val_4046000">$61.00</strong></div><div>Increment: $1.00</div><div>Minimum bid: $62.00</div><div><div class="auctitle">Shipping</div><div>Buyer must pickup item(s)</div></div><div>Auction Results</div><h3>Description</h3><div>Pickup required.</div></body></html>';
const record = parseDetailPage(
  html,
  'https://www.publicsurplus.com/sms/auction/view?auc=4046000',
  '2026-10-25T12:12:23.000Z',
);

assert.equal(record.title, 'HARD DRIVE REMOVED ~ LAPTOP ~ JN-26-16 (R16D)', 'title excludes auction status and adjacent seller links');
assert.equal(record.current_price, 61, 'closed lots expose Final Price rather than Current Price');
assert.equal(record.price_type, 'current_bid');
assert.equal(record.attributes.price_type, 'current_bid');
assert.equal(record.bid_count, 10);
assert.equal(record.auction_end_time, '2026-10-19T15:03:00.000Z', 'MDT is converted to UTC');
assert.equal(record.source_meta.price.raw, 'Final Price $61.00');
assert.equal(record.source_meta.auction_end_time.raw, 'Oct 19, 2026 09:03 AM MDT');
assert.equal(record.shipping_method, 'pickup_only');
assert.equal(record.shipping_evidence, 'Buyer must pickup item(s)', 'shipping evidence excludes the following Auction Results heading');
assert.equal(record.source_record.shipping_options.section_text, 'Buyer must pickup item(s)');
assert.equal(record.source_record.original_html, html);
console.log('ALL closed auction TESTS PASSED');