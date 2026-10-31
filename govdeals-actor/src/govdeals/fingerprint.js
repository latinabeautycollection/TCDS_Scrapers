/**
 * Remove observation-only fields that must never participate in durable content identity.
 * Source-specific GovDeals adapter helper; does not change the shared PropertyRoom normalizer.
 */
export function stripVolatileObservationFields(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  if (raw.source_meta && typeof raw.source_meta === 'object') {
    delete raw.source_meta.time_remaining_seconds;
    delete raw.source_meta.scraped_at;
    delete raw.source_meta.observed_at;
    delete raw.source_meta.actor_run_id;
  }
  return raw;
}