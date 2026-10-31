import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseDetailPage } from '../../src/municibid/parser.js';
import { applyNoBidRules, computeContentHash } from '../../src/municibid/fieldRules.js';
import { findPayloadListing } from '../../src/municibid/payload.js';
import { extractLogisticsSignals } from '../../src/municibid/logistics.js';
import { preserveSource } from '../../src/municibid/sourceArchive.js';
const url='https://municibid.com/listing/12345678/test';
const page = body => `<html><body><h1>Test item</h1><div>Listing #12345678 Boston, MA US</div>${body}</body></html>`;
const parse = body => parseDetailPage(page(body),url,'2026-10-17T12:00:00Z');
const cases=[];
function test(name,fn){fn();cases.push(name);}
test('unknown price and count do not imply zero bids',()=>{
  const r=applyNoBidRules({bid_count:null,current_price:null,starting_price:25});
  assert.equal(r.bid_count,null); assert.equal(r.minimum_bid,undefined);
});
test('explicit no bids use published opening bid as listing price',()=>{
  const r=applyNoBidRules(parse('<div>Bids: 0</div><div>Starting Bid $50</div><div>Current Bid $50</div><div>Buyer’s Fee: 9%</div>'));
  assert.equal(r.current_price,50);assert.equal(r.minimum_bid,50);assert.equal(r.price_type,'starting_bid');assert.equal(r.buyers_premium_pct,9);
});
test('active bid is not overwritten by starting bid',()=>{
  const r=applyNoBidRules(parse('<div>Bids: 7</div><div>Starting Bid $100</div><div>Current Bid $3150</div>'));
  assert.equal(r.current_price,3150);assert.equal(r.starting_price,100);
});
test('bounded published condition remains original text',()=>{
  const r=parse('<dl><dt>Condition</dt><dd>Like new - tested</dd></dl><h2>Item Description</h2><p>Sold as is.</p>');
  assert.equal(r.condition,'Like new - tested');assert.equal(parse('<p>Unknown condition described here.</p>').condition,null);
});
test('start date is UTC and never inferred from end date',()=>{
  assert.equal(parse('<dl><dt>Start Date</dt><dd>October 7, 2026 4:47 PM ET</dd></dl>').auction_start_time,'2026-10-07T20:47:00.000Z');
  assert.equal(parse('<div>End Date October 20, 2026 12:00 PM ET</div>').auction_start_time,null);
});
test('published shipping cost includes explicit zero, pickup has no invented cost',()=>{
  assert.equal(parse('<div>Shipping Cost: $25.00</div>').estimated_shipping,25);
  assert.equal(parse('<div>Shipping Cost: $0.00</div>').estimated_shipping,0);
  const r=parse('<div>Pickup only</div>');assert.equal(r.estimated_shipping,null);assert.equal(r.pickup_required,true);
  assert.equal(r.shipping_method,'pickup_only');
  assert.equal(extractLogisticsSignals('Shipping not available').shipping_available,false);
});
test('descriptions preserve short text and block boundaries',()=>{
  assert.equal(parse('<h2>Item Description</h2><p>Works.</p><h2>Payment Details</h2><p>Cash</p>').description,'Works.');
  assert.match(parse('<h2>Item Description</h2><p>First line.</p><p>Second line.</p>').description,/First line\.\n+Second line\./);
});
test('payload identity and nested JSON protect descriptions and dates',()=>{
  const payload={title:'Test',description:'<p>Correct item.</p>',id:12345678,startsAtUtc:'2026-10-01T12:00:00',endsAtUtc:'2026-10-20T12:00:00',extra:{keep:'all'}};
  const html=page(`<script>self.__next_f.push([1,${JSON.stringify(JSON.stringify(payload))}])</script>`);
  assert.equal(findPayloadListing(html,'12345678').extra.keep,'all');
  assert.equal(findPayloadListing(html,'99999999'),null);
  const r=parseDetailPage(html,url);assert.equal(r.description,'Correct item.');assert.equal(r.auction_start_time,'2026-10-01T12:00:00.000Z');
});
test('live detail auction state supplies current bid, bid count and end timestamp',()=>{
  const state={listingId:12345678,initial:{currentPrice:3651,bidCount:9,endsAtUtc:'2026-10-19T16:59:00',status:'Unsuccessful'}};
  const html=page(`<div>Starting Bid: $100.00</div><script>self.__next_f.push([1,${JSON.stringify(JSON.stringify(state))}])</script>`);
  const r=parseDetailPage(html,url,'2026-10-22T23:47:00Z');
  assert.equal(r.current_price,3651);assert.equal(r.starting_price,100);assert.equal(r.bid_count,9);
  assert.equal(r.price_type,'current_bid');assert.equal(r.auction_end_time,'2026-10-19T16:59:00.000Z');
});
test('related listing images and descriptions are excluded',()=>{
  const r=parse('<h2>Item Description</h2><p>Own description.</p><img src="https://storagemunicibidpro.blob.core.windows.net/own.jpg"><h2>Related Auctions You Might Be Interested In</h2><p>Other item.</p><img src="https://storagemunicibidpro.blob.core.windows.net/other_largesize.jpg">');
  assert.equal(r.description,'Own description.');assert.deepEqual(r.images,['https://storagemunicibidpro.blob.core.windows.net/own.jpg']);
});
test('structured source record preserves labels, description, shipping and page variables',()=>{
  const r=parse('<dl><dt>Start Date</dt><dd>October 7, 2026 4:47 PM ET</dd><dt>Will you ship this item?</dt><dd>No</dd></dl><h2>Item Description</h2><p>Original text.</p><script>window.auction={"currentPrice":50,"endsAtUtc":"2026-10-20T12:00:00Z"}</script>');
  assert.ok(r.source_record);assert.ok(r.source_record.label_values.some(x=>/Start Date/.test(x.label)));
  assert.equal(r.source_record.full_description,'Original text.');assert.ok(r.source_record.shipping_options.some(x=>/ship/i.test(x)));
  assert.ok(r.source_record.page_variables.some(x=>/currentPrice/.test(x.content)));
});
test('meaningful corrections update hash but observation metadata does not',()=>{
  const r={external_id:'municibid-1',description:'Original',image_urls:['a']};const h=computeContentHash(r);
  assert.notEqual(h,computeContentHash({...r,description:'Corrected'}));assert.notEqual(h,computeContentHash({...r,image_urls:['b']}));
  assert.equal(h,computeContentHash({...r,scraped_at:'tomorrow',source_meta:{original_record:{store_id:'new'}}}));
});
console.log(JSON.stringify({status:'PASS',count:cases.length,cases},null,2));
const saved=new Map();
const store={id:'offline-store',async setValue(k,v){saved.set(k,v);}};
const original={external_id:'municibid-12345678',description:'Full original contact: public@example.org',current_price:50,bid_count:0};
const reference=await preserveSource(store,'<html>exact source</html>',original,{untouched:'index'},url,'2026-10-17T12:00:00Z');
applyNoBidRules(original);
assert.equal(saved.get(reference.html_key),'<html>exact source</html>');
assert.equal(saved.get(reference.json_key).parsed.current_price,50);
assert.equal(saved.get(reference.json_key).parsed.description,'Full original contact: public@example.org');
await assert.rejects(()=>preserveSource({async setValue(){throw Error('storage failed');}},'html',original,{},url,'now'),/storage failed/);
console.log('PASS: original source preservation and storage failure propagation');