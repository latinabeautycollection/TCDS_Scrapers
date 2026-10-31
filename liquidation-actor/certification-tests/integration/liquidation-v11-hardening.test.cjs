const fs=require('fs'), path=require('path');
const root=path.resolve(__dirname,'../..');
const load=async(p)=>import(path.join(root,p));
const fixture=n=>fs.readFileSync(path.join(root,'certification-tests/fixtures',n),'utf8');
describe('Liquidation V1.1 source hardening',()=>{
 test('parses Canadian C$ current/minimum bid',async()=>{const {parseDetailPage}=await load('src/liquidation/parser.js');const r=parseDetailPage(fixture('liquidation-cad.html'),'https://www.liquidation.com/auction/view?id=300001','2026-10-14T12:00:00Z');expect(r.current_price).toBe(100);expect(r.minimum_bid).toBe(100);expect(r.currency).toBe('CAD');expect(r.country).toBe('CA');});
 test('sealed bid with Buy Now instruction preserves both modes',async()=>{const {parseDetailPage}=await load('src/liquidation/parser.js');const r=parseDetailPage(fixture('liquidation-mixed-buy-now.html'),'https://www.liquidation.com/auction/view?id=300002','2026-10-14T12:00:00Z');expect(r.listing_type).toBe('SEALED_BID');expect(r.available_purchase_modes).toEqual(expect.arrayContaining(['SEALED_BID','BUY_NOW']));});
 test('manifest rows parse to SKU/UPC records',async()=>{const {parseManifestHtml}=await load('src/liquidation/parser.js');const rows=parseManifestHtml(fixture('liquidation-manifest.html'),'https://www.liquidation.com/aucimg/manifest.html',{auction_id:'300003',external_id:'liquidation-300003',currency:'USD'});expect(rows).toHaveLength(2);expect(rows[0].sku).toBe('SKU-1');expect(rows[0].quantity).toBe(5);expect(rows[1].retail_currency).toBe('CAD');});
});
