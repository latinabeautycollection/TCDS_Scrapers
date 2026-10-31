let normalizeRecord, validateRecord;
beforeAll(async()=>({normalizeRecord,validateRecord}=await import('../../src/utils/normalize.js')));
test('Municibid normalizes into unified auction contract',()=>{
 const r=normalizeRecord({source:'municibid',record_type:'auction_listing',external_id:'municibid-86306602',listing_url:'https://municibid.com/listing/86306602/lot-various-equipment',title:'LOT Various Equipment',condition:'FAIR',current_price:1000,currency:'USD',auction_end_time:'2026-10-15T12:00:00.000Z',location:'Chicago, IL',image_urls:[],attributes:{trusted:{},mined:{}},source_meta:{transport:'municibid_html'}},'municibid');
 expect(r.source).toBe('municibid'); expect(r.record_type).toBe('auction_listing'); expect(r.dedupe_key).toBe('municibid:municibid-86306602'); expect(validateRecord(r).valid).toBe(true);
});
test('PropertyRoom normalization remains recognized',()=>{
 const r=normalizeRecord({source:'propertyroom',record_type:'auction_listing',external_id:'propertyroom-1',listing_url:'https://www.propertyroom.com/x',title:'X',condition:'USED',current_price:1,currency:'USD',auction_end_time:'2026-10-15T12:00:00.000Z',location:'VA',image_urls:[],attributes:{trusted:{},mined:{}},source_meta:{}},'propertyroom'); expect(r.source).toBe('propertyroom'); expect(r.record_type).toBe('auction_listing');
});
