const fs=require('fs');
const path=require('path');
let parseSearchPage, parseDetailPage;
beforeAll(async () => ({ parseSearchPage, parseDetailPage } = await import('../../src/govdeals/parser.js')));
const fixture=(n)=>fs.readFileSync(path.join(__dirname,'../fixtures',n),'utf8');

test('search fixture discovers stable GovDeals identity and pagination', () => {
  const r=parseSearchPage(fixture('govdeals-search.html'),'https://prod-seo.govdeals.com/en/search');
  expect(r.items).toHaveLength(1);
  expect(r.items[0].externalId).toBe('govdeals-782-41319');
  expect(r.items[0].currentPrice).toBe(250);
  expect(r.pagination.some(x=>x.includes('page=2'))).toBe(true);
});

test('detail fixture extracts required auction intelligence', () => {
  const r=parseDetailPage(fixture('govdeals-detail.html'),'https://prod-seo.govdeals.com/en/asset/41319/782','2026-10-07T20:00:00.000Z');
  expect(r.external_id).toBe('govdeals-782-41319');
  expect(r.current_price).toBe(250);
  expect(r.bid_count).toBe(4);
  expect(r.bid_increment).toBe(25);
  expect(r.condition).toBe('USED');
  expect(r.seller_name).toMatch(/Fairfax County/);
  expect(r.pickup_required).toBe(true);
  expect(r.auction_end_time).toBeTruthy();
});
