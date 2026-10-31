let evaluateRunHealth;
beforeAll(async () => ({ evaluateRunHealth } = await import('../../src/govdeals/health.js')));

function healthyStats() {
  return {
    schema_drift_events: 0,
    records_discovered: 100,
    detail_pages_attempted: 100,
    detail_pages_parsed: 100,
    records_saved: 100,
    filtered_records: 0,
    duplicates_skipped: 0,
    completeness_total: 100,
    completeness: { external_id:100,title:100,listing_url:100,current_price:100,auction_end_time:100,location:100,seller_name:100,condition:100 },
  };
}

test('healthy run passes', () => {
  expect(evaluateRunHealth(healthyStats()).status).toBe('PASS');
});

test('systemic parser collapse fails', () => {
  const s = healthyStats(); s.detail_pages_parsed = 0; s.records_saved = 0;
  const h = evaluateRunHealth(s);
  expect(h.status).toBe('FAIL');
  expect(h.reasons.join(' ')).toMatch(/systemic_detail_parse_failure/);
});

test('critical field completeness below threshold fails', () => {
  const s = healthyStats(); s.completeness.seller_name = 97;
  const h = evaluateRunHealth(s);
  expect(h.status).toBe('FAIL');
  expect(h.reasons.join(' ')).toMatch(/seller_name/);
});

test('one rejected lot degrades a run with healthy emitted records instead of failing the integration event', () => {
  const s = healthyStats();
  s.records_discovered = 20;
  s.records_queued = 20;
  s.records_saved = 19;
  s.records_rejected = 1;
  s.completeness_total = 19;
  for (const field of Object.keys(s.completeness)) s.completeness[field] = 19;
  const h = evaluateRunHealth(s);
  expect(h.status).toBe('DEGRADED');
  expect(h.reasons).toEqual([]);
  expect(h.warnings).toContain('records_rejected:1');
});

test('a run with queued but zero usable records still fails', () => {
  const s = healthyStats();
  s.records_queued = 10;
  s.records_saved = 0;
  s.records_rejected = 10;
  s.completeness_total = 0;
  const h = evaluateRunHealth(s);
  expect(h.status).toBe('FAIL');
  expect(h.reasons.join(' ')).toMatch(/queued_records_saved_zero/);
});
