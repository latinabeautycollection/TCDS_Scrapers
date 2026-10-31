let stripVolatileObservationFields, normalizeRecord;
beforeAll(async () => {
  ({ stripVolatileObservationFields } = await import('../../src/govdeals/fingerprint.js'));
  ({ normalizeRecord } = await import('../../src/utils/normalize.js'));
});

function raw(seconds) {
  return {
    source:'govdeals', record_type:'auction_listing', external_id:'govdeals-782-41319',
    listing_url:'https://prod-seo.govdeals.com/en/asset/41319/782', title:'Phone', condition:'USED',
    current_price:250, currency:'USD', auction_end_time:'2026-10-08T20:00:00.000Z', location:'Fairfax, Virginia, USA',
    image_urls:[], attributes:{trusted:{},mined:{}}, source_meta:{transport:'govdeals_html',time_remaining_seconds:seconds},
    scraped_at:'2026-10-07T20:00:00.000Z', observed_at:'2026-10-07T20:00:00.000Z'
  };
}

test('countdown does not affect durable content hash', () => {
  const a=raw(14400), b=raw(12600);
  stripVolatileObservationFields(a); stripVolatileObservationFields(b);
  const na=normalizeRecord(a,'govdeals'), nb=normalizeRecord(b,'govdeals');
  expect(na.content_hash).toBe(nb.content_hash);
});

test('authoritative end-time change changes hash', () => {
  const a=raw(14400), b=raw(14400); b.auction_end_time='2026-10-08T20:15:00.000Z';
  stripVolatileObservationFields(a); stripVolatileObservationFields(b);
  expect(normalizeRecord(a,'govdeals').content_hash).not.toBe(normalizeRecord(b,'govdeals').content_hash);
});
