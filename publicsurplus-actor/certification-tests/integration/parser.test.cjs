const fs=require('fs'); const path=require('path');
let parseSearchPage, parseDetailPage, applyNoBidRules;
beforeAll(async()=>{
 ({parseSearchPage,parseDetailPage}=await import('../../src/publicsurplus/parser.js'));
 ({applyNoBidRules}=await import('../../src/publicsurplus/fieldRules.js'));
});
const fixture=n=>fs.readFileSync(path.join(__dirname,'../fixtures',n),'utf8');
test('search fixture discovers stable Public Surplus identity and pagination',()=>{
 const r=parseSearchPage(fixture('publicsurplus-search.html'),'https://www.publicsurplus.com/sms/browse/search?posting=y');
 expect(r.items).toHaveLength(1); expect(r.items[0].externalId).toBe('publicsurplus-4098818'); expect(r.items[0].currentPrice).toBe(910); expect(r.pagination.some(x=>x.includes('page=2'))).toBe(true);
});
test('detail fixture extracts Public Surplus auction intelligence',()=>{
 const r=parseDetailPage(fixture('publicsurplus-detail.html'),'https://www.publicsurplus.com/sms/auction/view?auc=4098818','2026-10-08T12:00:00.000Z');
 expect(r.external_id).toBe('publicsurplus-4098818'); expect(r.current_price).toBe(910); expect(r.price_type).toBe('current_bid'); expect(r.attributes.price_type).toBe('current_bid'); expect(r.bid_count).toBe(20); expect(r.attributes.bid_count).toBe(20); expect(r.bid_increment).toBe(10); expect(r.minimum_bid).toBe(920); expect(r.condition).toBe('FAIR'); expect(r.seller_name).toMatch(/Culpeper County Public Schools/); expect(r.pickup_required).toBe(true); expect(r.shipping_available).toBe(false); expect(r.shipping_method).toBe('pickup_only'); expect(r.estimated_shipping).toBeNull(); expect(r.buyers_premium_pct).toBe(9.5); expect(r.buyers_premium).toBe(86.45); expect(r.auction_extension_possible).toBe(true); expect(r.auction_end_time).toBe('2026-10-15T12:00:00.000Z');
 expect(r.auction_start_time).toBeNull(); expect(r.attributes.auction_start_time_source).toBe('not_published_by_site');
 expect(r.source_record.original_html).toBe(fixture('publicsurplus-detail.html'));
 expect(r.source_record.full_description).toContain('Condition: FAIR');
 expect(r.source_record.label_values.some(x=>x.label==='# of Bids' && x.value==='20')).toBe(true);
 expect(r.source_record.shipping_options.section_text).toContain('Buyer must pickup item(s)');
});
test('closed auction extracts final bid and exact ended timestamp',()=>{
 const html='<html><body><h1>Auction #4046000 - HARD DRIVE REMOVED ~ LAPTOP</h1><div>Auction Started Oct 12, 2026 07:48 AM MDT</div><div>Auction Ended Oct 19, 2026 09:03 AM MDT</div><div class="justify-content-end border-end"># of Bids</div><div><span id="noOfBids">10</span></div><div class="justify-content-end border-end">Final Price</div><div><strong id="val_4046000">$61.00</strong></div><div>Increment: $1.00</div><div>Minimum bid: $62.00</div><h3>Description</h3><div>Pickup required.</div></body></html>';
 const r=parseDetailPage(html,'https://www.publicsurplus.com/sms/auction/view?auc=4046000','2026-10-25T12:12:23.000Z');
 expect(r.current_price).toBe(61); expect(r.price_type).toBe('current_bid'); expect(r.attributes.price_type).toBe('current_bid'); expect(r.bid_count).toBe(10);
 expect(r.auction_end_time).toBe('2026-10-19T15:03:00.000Z'); expect(r.source_meta.price.raw).toBe('Final Price $61.00'); expect(r.source_meta.auction_end_time.raw).toBe('Oct 19, 2026 09:03 AM MDT');
 expect(r.source_record.original_html).toBe(html);
});
test('no-bid auction uses the published opening amount and preserves all original page evidence',()=>{
 const html='<html><body><h1>Auction #1234567 - Lot</h1><div>Auction Starts Oct 8, 2026 1:00 PM EDT</div><div>Auction Ends Oct 9, 2026 1:00 PM EDT</div><div># of Bids 0</div><div>Minimum bid: $25.00</div><div>Increment: $1.00</div><div>Shipping Shipping price estimator: $12.00 standard, $8.00 economy</div><h3>Description</h3><div>Full original description</div><script>window.auctionEndDate="Oct 9, 2026"; window.minimumBid=25;</script></body></html>';
 const r=parseDetailPage(html,'https://www.publicsurplus.com/sms/auction/view?auc=1234567','2026-10-08T12:00:00.000Z'); applyNoBidRules(r);
 expect(r.current_price).toBe(25); expect(r.price_type).toBe('starting_bid'); expect(r.bid_count).toBe(0); expect(r.auction_start_time).toBe('2026-10-08T17:00:00.000Z'); expect(r.attributes.auction_start_time_source).toBe('publicsurplus_detail_html');
 expect(r.estimated_shipping).toBe(8); expect(r.shipping_method).toBe('shipping'); expect(r.attributes.shipping_evidence).toContain('Shipping price estimator'); expect(r.source_record.original_html).toBe(html); expect(r.source_record.full_description).toContain('Full original description'); expect(r.source_record.page_variables[0].content).toContain('minimumBid=25');
});
test('fixed price is classified as buy now and free shipping is zero only when not contradicted by pickup-only terms',()=>{
 const fixed='<html><body><h1>Auction #1234568 - Fixed Price lot</h1><div>Fixed Price</div><div>Current Price: $40.00</div><div>Buy Now: $40.00</div><div>Shipping Free shipping</div><h3>Description</h3><div>Item details</div></body></html>';
 const a=parseDetailPage(fixed,'https://www.publicsurplus.com/sms/auction/view?auc=1234568');
 expect(a.price_type).toBe('buy_now'); expect(a.estimated_shipping).toBe(0); expect(a.shipping_method).toBe('free_shipping'); expect(a.attributes.shipping_evidence).toMatch(/free shipping/i);
 const conflict=fixed.replace('Shipping Free shipping','Shipping Buyer must pickup item(s)');
 const b=parseDetailPage(conflict,'https://www.publicsurplus.com/sms/auction/view?auc=1234568');
 expect(b.shipping_method).toBe('pickup_only'); expect(b.estimated_shipping).toBeNull();
});
test('free shipping takes precedence over unrelated payment limits in page text',()=>{
 const html='<html><body><h1>Auction #1234569 - Laptop - Free Shipping!</h1><div>Auction Ends Oct 19, 2026 1:00 PM MDT</div><div># of Bids 2</div><div>Current Bid: $243.50</div><div>Payment Visa, MasterCard, Online CC Payment Less than or equal to $4,000.00 Wire Transfer</div><div>Shipping Contact agency for shipping</div><h3>Description</h3><div>This item will be SHIPPED FOR FREE via FEDEX Ground to the buyer.</div></body></html>';
 const r=parseDetailPage(html,'https://www.publicsurplus.com/sms/auction/view?auc=1234569');
 expect(r.shipping_method).toBe('free_shipping'); expect(r.shipping_available).toBe(true); expect(r.estimated_shipping).toBe(0); expect(r.attributes.shipping_evidence).toMatch(/free shipping/i);
 expect(r.source_meta.shipping.source).toBe('publicsurplus_free_shipping_text');
});
test('shipping quote language is preserved with sentence evidence and no fabricated price',()=>{
 const html='<html><body><h1>Auction #1234570 - Office Chair</h1><div>Auction Ends Oct 19, 2026 1:00 PM MDT</div><div># of Bids 0</div><div>Minimum bid: $25.00</div><div>Shipping Shipping is available. Contact seller for a quote.</div><h3>Description</h3><div>Good condition.</div></body></html>';
 const r=parseDetailPage(html,'https://www.publicsurplus.com/sms/auction/view?auc=1234570');
 expect(r.shipping_method).toBe('shipping_quote'); expect(r.estimated_shipping).toBeNull(); expect(r.attributes.shipping_evidence).toMatch(/Shipping is available/);
});
test('model codes populate both model and MPN without using serial numbers',()=>{
 const html='<html><body><h1>Auction #1234571 - Device</h1><div>Auction Ends Oct 19, 2026 1:00 PM MDT</div><div># of Bids 0</div><div>Minimum bid: $25.00</div><div>Pick-up Location: 1 Main St</div><h3>Description</h3><div>Model: SC-W60A-AV Serial Number: SERIAL123</div></body></html>';
 const r=parseDetailPage(html,'https://www.publicsurplus.com/sms/auction/view?auc=1234571');
 expect(r.model).toBe('SC-W60A-AV'); expect(r.attributes.trusted.MPN).toBe('SC-W60A-AV'); expect(r.attributes.trusted.MPN).not.toContain('SERIAL');
});
test('explicit part number labels take precedence over model and serial fields',()=>{
 const html='<html><body><h1>Auction #1234572 - Device</h1><div>Auction Ends Oct 19, 2026 1:00 PM MDT</div><div># of Bids 1</div><div>Current Price: $50.00</div><table><tr><th>MPN</th><td>P-123</td></tr><tr><th>Serial Number</th><td>SERIAL-999</td></tr></table><h3>Description</h3><div>Brand: Dell Model: Device Name</div></body></html>';
 const r=parseDetailPage(html,'https://www.publicsurplus.com/sms/auction/view?auc=1234572');
 expect(r.attributes.trusted.MPN).toBe('P-123'); expect(r.attributes.trusted.Model).toBe('Device Name');
});
