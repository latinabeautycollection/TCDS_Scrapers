import { createHash } from 'node:crypto';

export async function preserveSource(store, html, raw, indexObservation, url, observedAt) {
  const digest = createHash('sha256').update(html).digest('hex');
  const key = `SOURCE_${raw.external_id}_${digest.slice(0,16)}`;
  await store.setValue(`${key}_HTML`, html, { contentType: 'text/html; charset=utf-8' });
  await store.setValue(`${key}_JSON`, { listing_url:url, observed_at:observedAt, parsed:structuredClone(raw), index_observation:structuredClone(indexObservation) });
  return { store_id:store.id, html_key:`${key}_HTML`, json_key:`${key}_JSON`, html_sha256:digest };
}