let normalizeRecord, validateRecord;
beforeAll(async () => ({ normalizeRecord, validateRecord } = await import('../../src/utils/normalize.js')));

test('GovDeals normalizes into unified auction contract with mandatory source fields', () => {
  const r=normalizeRecord({source:'govdeals',record_type:'auction_listing',external_id:'govdeals-782-41319',listing_url:'https://prod-seo.govdeals.com/en/asset/41319/782',title:'Phone',condition:'USED',current_price:250,currency:'USD',auction_start_time:'2026-10-01T12:00:00.000Z',auction_end_time:'2026-10-08T20:00:00.000Z',location:'Fairfax, Virginia, USA',shipping_method:'shipping',source_record:{search:{assetId:41319},detail:{assetId:41319},bidbox:{bidCount:1}},image_urls:[],attributes:{price_type:'current_bid',bid_count:1,auction_start_time_source:'govdeals_bidbox_api',trusted:{},mined:{}},source_meta:{transport:'govdeals_html'}},'govdeals');
  expect(r.source).toBe('govdeals');
  expect(r.record_type).toBe('auction_listing');
  expect(r.shipping_method).toBe('shipping');
  expect(r.auction_start_time).toBe('2026-10-01T12:00:00.000Z');
  expect(r.source_record.search.assetId).toBe(41319);
  expect(r.attributes.price_type).toBe('current_bid');
  expect(r.dedupe_key).toBe('govdeals:govdeals-782-41319');
  expect(validateRecord(r).valid).toBe(true);
});

test('PropertyRoom normalization behavior remains recognized', () => {
  const r=normalizeRecord({source:'propertyroom',record_type:'auction_listing',external_id:'propertyroom-1',listing_url:'https://www.propertyroom.com/x',title:'X',condition:'USED',current_price:1,currency:'USD',auction_end_time:'2026-10-08T20:00:00.000Z',location:'VA',image_urls:[],attributes:{trusted:{},mined:{}},source_meta:{}},'propertyroom');
  expect(r.source).toBe('propertyroom');
  expect(r.record_type).toBe('auction_listing');
});
