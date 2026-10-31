let buildSqlIngestCall;
beforeAll(async () => ({ buildSqlIngestCall } = await import('../../src/utils/sqlExport.js')));
const base={external_id:'x',title:'X',condition:'USED',current_price:1,auction_end_time:'2026-10-08T20:00:00Z',location:'VA',image_urls:[],attributes:{trusted:{},mined:{}},source_meta:{}};

test('SQL export uses GovDeals record source', () => {
  expect(buildSqlIngestCall({...base,source:'govdeals'})).toMatch(/'govdeals'/);
});

test('SQL export preserves PropertyRoom source', () => {
  expect(buildSqlIngestCall({...base,source:'propertyroom'})).toMatch(/'propertyroom'/);
});
