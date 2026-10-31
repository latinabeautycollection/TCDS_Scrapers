let buildSqlIngestCall; beforeAll(async()=>({buildSqlIngestCall}=await import('../../src/utils/sqlExport.js')));
test('SQL source follows record source',()=>expect(buildSqlIngestCall({source:'publicsurplus',external_id:'publicsurplus-1',title:'X'})).toContain("'publicsurplus'"));
test('PropertyRoom SQL source regression',()=>expect(buildSqlIngestCall({source:'propertyroom',external_id:'propertyroom-1',title:'X'})).toContain("'propertyroom'"));
