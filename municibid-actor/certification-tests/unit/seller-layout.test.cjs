let parseDetailPage;
beforeAll(async()=>({parseDetailPage}=await import('../../src/municibid/parser.js')));
test('seller link wins over concatenated header Follow text',()=>{
const html=`<html><body><h1>Set of 6 tires</h1>
<div>Listing #86313813 Titusville, PA USTitusville Area School DistrictFollow</div>
<a href="/browse?seller=TASD">Titusville Area School District</a>
<div>Current highest bid $100.00 No Reserve Bids: 0 Buyer’s Fee: 9%</div>
<div>Auction Details Starting Bid $100.00 Current Price $100.00 Reserve Price No Reserve Buyer’s Fee 9%
Start Date Thursday, October 8, 2026 9:00 AM ET
End Date Thursday, October 22, 2026 10:40 AM ET Bid History 0 Bid(s)</div>
<h2>Item Description</h2><div>Set of tires</div>
</body></html>`;
const r=parseDetailPage(html,'https://municibid.com/listing/86313813/set-of-6-tires','2026-10-09T12:00:00.000Z');
expect(r.seller_name).toBe('Titusville Area School District');
});
