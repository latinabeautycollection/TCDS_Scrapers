let buildSqlIngestCall; beforeAll(async()=>({buildSqlIngestCall}=await import('../../src/utils/sqlExport.js')));
test('SQL source follows record source',()=>expect(buildSqlIngestCall({source:'municibid',external_id:'municibid-1',title:'X'})).toContain("'municibid'"));
test('PropertyRoom SQL source regression',()=>expect(buildSqlIngestCall({source:'propertyroom',external_id:'propertyroom-1',title:'X'})).toContain("'propertyroom'"));
