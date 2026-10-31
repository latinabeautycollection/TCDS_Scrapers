let normalizeRecord, validateRecord;
beforeAll(async()=>({normalizeRecord,validateRecord}=await import('../../src/utils/normalize.js')));
test('Public Surplus normalizes into unified auction contract',()=>{
 const r=normalizeRecord({source:'publicsurplus',record_type:'auction_listing',external_id:'publicsurplus-4098818',listing_url:'https://www.publicsurplus.com/sms/auction/view?auc=4098818',title:'2004 F250',condition:'FAIR',current_price:910,currency:'USD',auction_end_time:'2026-10-15T12:00:00.000Z',auction_start_time:null,shipping_method:'pickup_only',location:'Culpeper, VA',image_urls:[],attributes:{price_type:'current_bid',bid_count:20,auction_start_time_source:'not_published_by_site',shipping_evidence:'Buyer must pickup item(s).',trusted:{},mined:{}},source_record:{original_html:'<html></html>',label_values:[],full_description:'',shipping_options:{},page_variables:[]},source_meta:{transport:'publicsurplus_html'}},'publicsurplus');
 expect(r.source).toBe('publicsurplus'); expect(r.record_type).toBe('auction_listing'); expect(r.dedupe_key).toBe('publicsurplus:publicsurplus-4098818'); expect(validateRecord(r).valid).toBe(true);
 expect(r.shipping_method).toBe('pickup_only'); expect(r.attributes.price_type).toBe('current_bid'); expect(r.source_record.original_html).toBe('<html></html>');
});
test('PropertyRoom normalization remains recognized',()=>{
 const r=normalizeRecord({source:'propertyroom',record_type:'auction_listing',external_id:'propertyroom-1',listing_url:'https://www.propertyroom.com/x',title:'X',condition:'USED',current_price:1,currency:'USD',auction_end_time:'2026-10-15T12:00:00.000Z',location:'VA',image_urls:[],attributes:{trusted:{},mined:{}},source_meta:{}},'propertyroom'); expect(r.source).toBe('propertyroom'); expect(r.record_type).toBe('auction_listing');
});
