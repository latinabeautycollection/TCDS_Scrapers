import fs from 'node:fs';
import path from 'node:path';
import { normalizeRecord, validateRecord } from '../src/utils/normalize.js';
import { DedupeManager } from '../src/utils/dedupe.js';
import { buildSqlIngestCall } from '../src/utils/sqlExport.js';
import { stripVolatileObservationFields } from '../src/municibid/fingerprint.js';
import { evaluateRunHealth } from '../src/municibid/health.js';
import { MunicibidRecoveryState, RECOVERY_KEY, DLQ_KEY, COMPLETION_MANIFEST_KEY } from '../src/municibid/recovery.js';
import { MunicibidRunLease } from '../src/municibid/lease.js';
import { buildMunicibidInputFingerprint } from '../src/municibid/inputFingerprint.js';

const root = path.resolve('.');
const checks = [];
const ok = (name, pass, detail = '') => checks.push({ name, pass: !!pass, detail });
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const json = (p) => JSON.parse(read(p));

const raw = {
  source: 'municibid', record_type: 'auction_listing', external_id: 'municibid-86306602',
  listing_url: 'https://municibid.com/listing/86306602/lot-various-equipment', title: 'LOT Various Equipment',
  condition: 'FAIR', current_price: 910, currency: 'USD', auction_end_time: '2026-10-15T12:00:00.000Z',
  location: 'Chicago, IL', image_urls: [], attributes: { trusted: {}, mined: {} },
  source_meta: { transport: 'municibid_html' }, scraped_at: '2026-10-08T20:00:00.000Z', observed_at: '2026-10-08T20:00:00.000Z',
};
const n = normalizeRecord(raw, 'municibid');
ok('municibid_normalizes_as_source', n.source === 'municibid', n.source);
ok('municibid_infers_auction_listing', n.record_type === 'auction_listing', n.record_type);
ok('unified_record_validates', validateRecord(n).valid, JSON.stringify(validateRecord(n).errors || []));
const pr = normalizeRecord({ ...raw, source: 'propertyroom', external_id: 'propertyroom-1', listing_url: 'https://www.propertyroom.com/x' }, 'propertyroom');
ok('propertyroom_source_regression', pr.source === 'propertyroom' && pr.record_type === 'auction_listing', `${pr.source}/${pr.record_type}`);

const a = { ...raw, source_meta: { transport: 'municibid_html', time_remaining_seconds: 1000 } };
const b = { ...raw, source_meta: { transport: 'municibid_html', time_remaining_seconds: 500 } };
stripVolatileObservationFields(a); stripVolatileObservationFields(b);
ok('countdown_excluded_from_hash', normalizeRecord(a, 'municibid').content_hash === normalizeRecord(b, 'municibid').content_hash);
const c = { ...b, auction_end_time: '2026-10-15T12:15:00.000Z' };
ok('end_time_mutation_changes_hash', normalizeRecord(a, 'municibid').content_hash !== normalizeRecord(c, 'municibid').content_hash);

const kv = { value: null, async getValue() { return this.value; }, async setValue(_k, v) { this.value = v; } };
const opts = { enableFingerprintRefresh: true, enableStaleRefresh: false, log: { info() {}, warning() {} } };
const d1 = new DedupeManager(kv, opts); await d1.initialize();
const first = await d1.shouldProcess('municibid-86306602', 'aaa');
await d1.markSeenWithFingerprint('municibid-86306602', 'aaa', { price: 910 }); await d1.persist();
const d2 = new DedupeManager(kv, opts); await d2.initialize(); const same = await d2.shouldProcess('municibid-86306602', 'aaa');
const d3 = new DedupeManager(kv, opts); await d3.initialize(); const changed = await d3.shouldProcess('municibid-86306602', 'bbb');
ok('dedupe_new_processes', first === true); ok('dedupe_same_skips', same === false); ok('dedupe_changed_reprocesses', changed === true);
ok('dedupe_source_is_municibid', kv.value?.entries?.['municibid-86306602']?.source === 'municibid');
ok('sql_export_source_municibid', buildSqlIngestCall({ ...raw, source: 'municibid' }).includes("'municibid'"));
ok('sql_export_propertyroom_regression', buildSqlIngestCall({ ...raw, source: 'propertyroom', external_id: 'propertyroom-1' }).includes("'propertyroom'"));

const healthy = {
  schema_drift_events: 0, records_discovered_unique: 100, detail_pages_attempted: 100, detail_pages_parsed: 100,
  records_normalized: 100, records_validated: 100, records_processed: 100, records_saved: 50, duplicates_skipped: 50,
  requests_permanently_failed: 0, normalized_completeness_total: 100,
  normalized_completeness: { external_id: 100, title: 100, listing_url: 100, current_price: 100, auction_end_time: 100, location: 100, seller_name: 100, condition: 90 },
  normalized_completeness_applicable: { external_id: 100, title: 100, listing_url: 100, current_price: 100, auction_end_time: 100, location: 100, seller_name: 100, condition: 100 },
  extraction_completeness_total: 100,
  extraction_completeness: { external_id: 100, title: 100, listing_url: 100, current_price: 100, auction_end_time: 100, location: 100, seller_name: 100, condition: 90 },
  extraction_completeness_applicable: { external_id: 100, title: 100, listing_url: 100, current_price: 100, auction_end_time: 100, location: 100, seller_name: 100, condition: 100 },
};
const goodRecon = { unaccounted_count: 0, retry_pending: 0, pending_detail: 0, pending_index: 0, discovery_partitions_total: 5, discovery_partitions_completed: 5, disposition_counts: { SAVED_NEW: 50, SKIPPED_UNCHANGED: 50 } };
ok('healthy_exhaustive_health_pass', evaluateRunHealth(healthy, { discoveryMode: 'EXHAUSTIVE', reconciliation: goodRecon }).status === 'PASS');
const pendingRecon = { ...goodRecon, retry_pending: 1, pending_detail: 1, disposition_counts: { ...goodRecon.disposition_counts, RETRY_PENDING: 1 } };
ok('pending_exhaustive_health_incomplete', evaluateRunHealth(healthy, { discoveryMode: 'EXHAUSTIVE', reconciliation: pendingRecon }).status === 'INCOMPLETE');
const broken = structuredClone(healthy); broken.detail_pages_parsed = 0; broken.records_normalized = 0; broken.records_validated = 0; broken.records_processed = 0; broken.records_saved = 0; broken.duplicates_skipped = 0;
ok('parser_collapse_fails', evaluateRunHealth(broken, { discoveryMode: 'TARGETED' }).status === 'FAIL');

function memKv(seed = {}) {
  const d = { ...seed };
  return { d, async getValue(k) { return d[k] ?? null; }, async setValue(k, v) { if (v === null) delete d[k]; else d[k] = structuredClone(v); } };
}
const corruptRecoveryStore = memKv({ [RECOVERY_KEY]: [] });
const corruptRecovery = new MunicibidRecoveryState(corruptRecoveryStore);
let corruptRecoveryRejected = false;
try { await corruptRecovery.initialize('x'); } catch (err) { corruptRecoveryRejected = /RECOVERY_STATE_INVALID/.test(err.message); }
ok('corrupt_recovery_rejected_and_preserved', corruptRecoveryRejected && Object.keys(corruptRecoveryStore.d).some((k) => k.startsWith('MUNICIBID_CORRUPT_RECOVERY_')));
const validState = { version: 2, status: 'RUNNING', input_fingerprint: 'x', started_at: new Date().toISOString(), updated_at: new Date().toISOString(), pending_index: {}, pending_detail: {}, completed_index: {}, discovered: {}, dispositions: {}, summary: null };
const corruptDlqStore = memKv({ [RECOVERY_KEY]: validState, [DLQ_KEY]: [] });
const corruptDlq = new MunicibidRecoveryState(corruptDlqStore);
let corruptDlqRejected = false;
try { await corruptDlq.initialize('x'); } catch (err) { corruptDlqRejected = /SOURCE_DLQ_INVALID/.test(err.message); }
ok('corrupt_source_dlq_rejected_and_preserved', corruptDlqRejected && Object.keys(corruptDlqStore.d).some((k) => k.startsWith('MUNICIBID_CORRUPT_SOURCE_DLQ_')));

const fpA = buildMunicibidInputFingerprint({ discoveryMode: 'EXHAUSTIVE', keywords: ['phone'], webhookAuthToken: 'one', ebayClientSecret: 'a' });
const fpB = buildMunicibidInputFingerprint({ discoveryMode: 'EXHAUSTIVE', keywords: ['phone'], webhookAuthToken: 'two', ebayClientSecret: 'b' });
const fpC = buildMunicibidInputFingerprint({ discoveryMode: 'EXHAUSTIVE', keywords: ['tablet'], webhookAuthToken: 'two', ebayClientSecret: 'b' });
ok('input_fingerprint_excludes_secrets', fpA === fpB);
ok('input_fingerprint_tracks_discovery_policy', fpA !== fpC);

const leaseStore = memKv();
const leaseQueueFactory = (() => { let entries = new Map(); let seq = 0; return async () => ({
  async addRequest(req) { const prior=[...entries.values()].find((x)=>x.uniqueKey===req.uniqueKey); if(prior) return {requestId:prior.id,wasAlreadyPresent:true,wasAlreadyHandled:false}; const item={...req,id:`r${++seq}`}; entries.set(item.id,item); return {requestId:item.id,wasAlreadyPresent:false,wasAlreadyHandled:false}; },
  async getRequest(id) { return entries.get(id) || null; },
  async drop() { entries = new Map(); },
}); })();
const leaseA = new MunicibidRunLease(leaseStore, { runId: 'a', ttlMs: 60000, openLockQueue: leaseQueueFactory, verifyPriorRunTerminal: async () => ({ terminal: false, status: 'RUNNING' }) });
const leaseB = new MunicibidRunLease(leaseStore, { runId: 'b', ttlMs: 60000, openLockQueue: leaseQueueFactory, verifyPriorRunTerminal: async () => ({ terminal: false, status: 'RUNNING' }) });
await leaseA.acquire(); let leaseBlocked = false;
try { await leaseB.acquire(); } catch (err) { leaseBlocked = /ACTIVE_RUN_LEASE_HELD|OWNER_NOT_TERMINAL/.test(err.message); }
ok('atomic_single_writer_lease_blocks_concurrent_state_writer', leaseBlocked);
await leaseA.release();

const source = read('src/extractors/municibid.js');
const write = source.indexOf('await dataset.pushData(record)');
const commit = source.indexOf('await dedupeManager.markSeenWithFingerprint(record.external_id');
ok('dataset_write_precedes_dedupe_commit', write >= 0 && commit > write, `${write}/${commit}`);
ok('no_price_only_early_skip_call', !/shouldEarlySkip\s*\(/.test(source));
ok('proxy_fail_closed_with_explicit_override_only', /proxyFallbackToDirect/.test(source) && /MUNICIBID_PROXY_CONFIGURATION_FAILED/.test(source));
ok('automatic_parse_retry_via_throw', /allowing governed Crawlee retry/.test(source) && /throw err;/.test(source));
ok('401_and_403_have_distinct_dispositions', /AUTH_REQUIRED/.test(source) && /ACCESS_RESTRICTED/.test(source));
ok('retry_after_http_date_supported', /Date\.parse\(raw\)/.test(source));
ok('capacity_truncation_checkpointed', /truncation_reason: 'maxPages'/.test(source) && /capacity_truncated/.test(source));
ok('run_lease_wired', /MunicibidRunLease/.test(source));
ok('lease_fencing_before_navigation', /preNavigationHooks: \[async/.test(source) && /await lease\.assertOwned\(\)/.test(source));
ok('lease_fencing_before_dataset_write', source.lastIndexOf('await lease.assertOwned()', write) >= 0);
ok('stale_lock_requires_prior_run_terminal_verification', /verifyPriorRunTerminal/.test(source) && /Actor\.apifyClient\.run\(priorRunId\)\.get\(\)/.test(source));

const discovery = read('src/municibid/discovery.js');
ok('option_navigation_discovery_wired', /option\[value\]/.test(discovery));
ok('form_navigation_discovery_wired', /form\[action\]/.test(discovery));
const main = read('main.js');
ok('empty_input_exhaustive_wired', /input\.discoveryMode === 'EXHAUSTIVE'/.test(main));
ok('targeted_empty_input_rejected', /MUNICIBID_TARGETED_REQUIRES_STARTURL_OR_KEYWORD/.test(main));
ok('completion_manifest_wired', /MUNICIBID_RUN_COMPLETION_MANIFEST|writeCompletionManifest|markComplete/.test(main));
ok('required_webhook_fail_closed', /REQUIRED_WEBHOOK_DELIVERY_FAILED/.test(main));
ok('release_version_v1313_in_main', /releaseVersion: '1\.3\.13'/.test(main));

const pkg = json('package.json'); const lock = json('package-lock.json'); const actor = json('.actor/actor.json');
ok('release_version_integrity', pkg.version === '1.3.13' && lock.version === '1.3.13' && lock.packages?.['']?.version === '1.3.13' && actor.version === '1.3.13' && actor.buildTag === 'release-1.3.13', `${pkg.version}/${lock.version}/${actor.version}/${actor.buildTag}`);
const actorFields = actor.storages.dataset.views.municibid_listings.transformation.fields;
ok('required_qa_fields_in_apify_view', ['current_price','price_type','bid_count','estimated_shipping','shipping_method','auction_start_time','auction_start_time_source','auction_end_time','source_record'].every((f) => actorFields.includes(f)));
const rules = read('src/municibid/fieldRules.js');
ok('opening_bid_retained_when_no_bids', /raw\.current_price = raw\.minimum_bid/.test(rules));
const parser = read('src/municibid/parser.js');
ok('source_record_and_shipping_method_extracted', /source_record:sourceRecord/.test(parser) && /classifyShipping\(/.test(parser) && /auction_start_time_source:evidence\.startSource/.test(parser));
const payloadParser = read('src/municibid/payload.js');
ok('live_detail_auction_state_parsed', /listingId.*initial/.test(payloadParser) && /currentPrice/.test(parser) && /pl\?\.endsAtUtc/.test(parser));
const input = json('INPUT_SCHEMA.json');
for (const field of ['discoveryMode','maxPages','maxDiscoveryRequests','maxDetailRequests','maxRuntimeMinutes','proxyFallbackToDirect','singleWriterLeaseEnabled','runLeaseTtlMinutes','completedEvidenceRetainEntries']) {
  ok(`input_schema_contains_${field}`, Object.hasOwn(input.properties, field));
}

const prodFiles = [...fs.readdirSync(path.join(root, 'src/municibid')).map((f) => `src/municibid/${f}`), 'src/extractors/municibid.js', 'main.js'];
const prodText = prodFiles.filter((f) => fs.statSync(path.join(root, f)).isFile()).map(read).join('\n');
ok('no_production_todo_fixme', !/\b(?:TODO|FIXME)\b/.test(prodText));
ok('no_direct_listings_write', !/\b(?:INSERT\s+INTO\s+Listings|listings\.push|write.*Listings)\b/i.test(prodText));
ok('completion_manifest_key_defined', COMPLETION_MANIFEST_KEY === 'MUNICIBID_RUN_COMPLETION_MANIFEST');

const allPass = checks.every((c) => c.pass);
const report = { generated_at: new Date().toISOString(), status: allPass ? 'PASS' : 'FAIL', checks };
fs.mkdirSync(path.join(root, 'release'), { recursive: true });
fs.writeFileSync(path.join(root, 'release', 'STATIC_CERTIFICATION_REPORT.json'), JSON.stringify(report, null, 2) + '\n');
for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'} ${c.name}${c.detail ? ` :: ${c.detail}` : ''}`);
if (!allPass) process.exit(1);