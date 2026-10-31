import {createHash} from 'node:crypto';
export async function archiveSource(store, html, raw) {
  const sha256 = createHash('sha256').update(html).digest('hex');
  const prefix = `SOURCE_${raw.external_id}_${sha256.slice(0,16)}`;
  await store.setValue(`${prefix}_HTML`, html, {contentType: 'text/html; charset=utf-8'});
  await store.setValue(`${prefix}_JSON`, raw);
  return {html_key:`${prefix}_HTML`, json_key:`${prefix}_JSON`, html_sha256:sha256, storage:'run_default_key_value_store'};
}