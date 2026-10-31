/**
 * GovDeals acquisition crawler V1.4 (JSON API transport).
 *
 * Replaces the V1.3 CheerioCrawler/HTML transport: GovDeals pages are an empty Angular shell,
 * so all data comes from the maestro JSON API (search -> detail -> fees).
 * Unchanged: normalizeRecord/validateRecord, DedupeManager, content hash, eligibility, health,
 * and the govdeals-{accountId}-{assetId} external_id.
 *
 * Economy rules:
 *  - SEARCH runs for all lots on every run (500 per page, ~51 requests for ~25k lots).
 *  - DETAIL + FEES are fetched only for lots that are new, whose search-row fingerprint changed,
 *    or whose last detail fetch is older than detailRefreshHours.
 *  - ~1s delay per request, low concurrency, no proxy.
 */
import { normalizeRecord, validateRecord, addSupabaseAliases } from '../utils/normalize.js';
import { incrementStat } from '../utils/logging.js';
import { evaluateRunHealth } from '../govdeals/health.js';
import { stripVolatileObservationFields } from '../govdeals/fingerprint.js';
import { GovDealsApiClient, GovDealsApiError, DEFAULT_API_BASE } from '../govdeals/api.js';
import { assetIdentity, buildRawRecord, searchFingerprint } from '../govdeals/apiParser.js';
import { parseAssetIdentity, parseRecheckIdentity } from '../govdeals/url.js';

const SEARCH_INDEX_KEY = 'GOVDEALS_SEARCH_INDEX';

export function classifyHttpStatus(status) {
  if (status === 200) return 'SUCCESS';
  if (status === 400) return 'BAD_REQUEST';
  if (status === 401) return 'AUTH_REQUIRED';
  if (status === 403) return 'ACCESS_DENIED';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'UPSTREAM_FAILURE';
  return `HTTP_${status}`;
}

function hasValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function updateCompleteness(stats, record) {
  stats.completeness_total += 1;
  const fields = {
    external_id: record.external_id, title: record.title, listing_url: record.listing_url,
    current_price: record.current_price, auction_end_time: record.auction_end_time,
    location: record.location, seller_name: record.seller_name,
    condition: record.condition && record.condition !== 'UNKNOWN' ? record.condition : null,
  };
  for (const [field, value] of Object.entries(fields)) if (hasValue(value)) stats.completeness[field] += 1;
}

/** @param {object} opts */
export function createGovDealsCrawler(opts) {
  const {
    keywords = [], maxPages = 0, maxConcurrency = 2, requestTimeoutSecs = 60, maxRequestRetries = 3,
    debug = false, dataset, dedupeManager, webhookManager, seenExternalIds,
    runContext = {}, sourceName = 'govdeals', maxItemsPerRun = 0, dedupeFlushInterval = 500, onProgress, log,
    apiKey, subscriptionKey, apiBaseUrl = DEFAULT_API_BASE, businessId = 'GD', displayRows = 500,
    requestDelayMs = 1000, detailRefreshHours = 24, includeBidBox = true, recheckLots = [],
    stateKvStore = null, fixtureStore = null, recordFixtures = false, proxyEnabled = false,
    fetchImpl, sleep,
  } = opts;

  const stats = {
    transport: 'govdeals_api',
    requests_total: 0, requests_attempted: 0, requests_success: 0, requests_failed: 0,
    requests_permanently_failed: 0, requests_retried: 0, api_requests: 0,
    search_pages: 0, pages_processed: 0,
    detail_pages_attempted: 0, detail_pages_parsed: 0, detail_parse_failures: 0,
    bidbox_requests: 0, bidbox_failures: 0,
    normalization_failures: 0, validation_failures: 0,
    records_discovered: 0, records_queued: 0, records_processed: 0, records_saved: 0, records_rejected: 0,
    duplicates_skipped: 0, duplicates_in_run: 0, unchanged_search_skipped: 0,
    recheck_targets: 0, recheck_not_found: 0, recheck_invalid: 0,
    zero_result_pages: 0, rate_limit_events: 0, access_denied_events: 0, schema_drift_events: 0,
    filtered_records: 0, capacity_skipped: 0, total_count_header: null,
    completeness_total: 0,
    completeness: { external_id: 0, title: 0, listing_url: 0, current_price: 0, auction_end_time: 0, location: 0, seller_name: 0, condition: 0 },
  };

  let savedCount = 0;
  let queuedCount = 0;
  let fatal = null;
  let fixtureDetail = 0;
  let fixtureBidbox = 0;
  const searchIndex = new Map(); // externalId -> { fp, at }
  const seenThisRun = new Set();
  const detailRefreshMs = Math.max(0, detailRefreshHours) * 3_600_000;

  async function loadSearchIndex() {
    if (!stateKvStore) return;
    try {
      const stored = await stateKvStore.getValue(SEARCH_INDEX_KEY);
      for (const [id, e] of Object.entries(stored?.entries || {})) searchIndex.set(id, e);
      log.info('GovDeals search index loaded', { entries: searchIndex.size });
    } catch (err) {
      log.warning(`Could not load GovDeals search index: ${err.message}`);
    }
  }

  async function saveSearchIndex() {
    if (!stateKvStore) return;
    try {
      await stateKvStore.setValue(SEARCH_INDEX_KEY, { version: 1, updated_at: new Date().toISOString(), entries: Object.fromEntries(searchIndex) });
    } catch (err) {
      log.warning(`Could not persist GovDeals search index: ${err.message}`);
    }
  }

  function needsDetail(id, fp, now) {
    const prev = searchIndex.get(id);
    if (!prev) return true;                           // new lot
    if (prev.fp !== fp) return true;                  // search-row fingerprint changed (price, end time, ...)
    if (now - (prev.at || 0) >= detailRefreshMs) return true; // periodic refresh
    if (!dedupeManager.getEntry(id)) return true;     // never saved downstream
    return false;
  }

  async function processLot(client, row, ident, fp, { forceRecheck = false } = {}) {
    stats.detail_pages_attempted += 1;
    incrementStat('detailPagesVisited');
    const observedAt = new Date().toISOString();

    let detail;
    try {
      detail = await client.detail(ident.assetId, ident.sellerAccountId, { businessId: row.businessId || businessId });
      if (recordFixtures && fixtureStore && fixtureDetail < 3) {
        fixtureDetail += 1;
        await fixtureStore.setValue(`FIXTURE_detail_${fixtureDetail}`, detail);
      }
    } catch (err) {
      if (err.fatal) throw err;
      stats.detail_parse_failures += 1;
      stats.records_rejected += 1;
      incrementStat('errors');
      log.error('GovDeals detail request failed', { id: ident.externalId, error: err.message });
      return;
    }

    // Bid box (needs auctionId from detail): premium %, bidder requirements, bid count, increment, start time.
    let bidbox = null;
    if (includeBidBox && detail.auctionId != null) {
      stats.bidbox_requests += 1;
      try {
        bidbox = await client.bidbox(ident.assetId, ident.sellerAccountId, detail.auctionId, { businessId: row.businessId || businessId });
        if (recordFixtures && fixtureStore && fixtureBidbox < 3) {
          fixtureBidbox += 1;
          await fixtureStore.setValue(`FIXTURE_bidbox_${fixtureBidbox}`, bidbox);
        }
      } catch (err) {
        if (err.fatal) throw err;
        stats.bidbox_failures += 1; // non-fatal: record kept with buyers_premium = null and eligibility UNKNOWN
        log.warning('GovDeals bid box request failed', { id: ident.externalId, error: err.message });
      }
    }

    let raw;
    try {
      raw = buildRawRecord({ row, detail, bidbox, observedAt });
      stripVolatileObservationFields(raw);
      stats.detail_pages_parsed += 1;
    } catch (err) {
      stats.detail_parse_failures += 1;
      stats.records_rejected += 1;
      incrementStat('errors');
      log.error('GovDeals record mapping failed', { id: ident.externalId, error: err.message });
      return;
    }

    if (raw.current_price == null) {
      stats.records_rejected += 1;
      log.warning('GovDeals record rejected: current price unavailable', { id: raw.external_id });
      return;
    }

    let record;
    try {
      record = normalizeRecord({
        ...raw,
        record_lineage: {
          source: 'govdeals', transport: 'govdeals_api',
          actor_run_id: runContext.actorRunId ?? '', actor_build_id: runContext.actorBuildId ?? '',
          actor_task_id: runContext.actorTaskId ?? '', input_fingerprint: runContext.inputFingerprint ?? '',
        },
        actor_run_id: runContext.actorRunId ?? '', actor_build_id: runContext.actorBuildId ?? '',
        actor_task_id: runContext.actorTaskId ?? '', input_fingerprint: runContext.inputFingerprint ?? '',
      }, sourceName);
    } catch (err) {
      stats.normalization_failures += 1;
      stats.records_rejected += 1;
      incrementStat('errors');
      log.error('GovDeals normalization failed', { id: raw.external_id, error: err.message });
      return;
    }

    if (raw.total_estimated_cost == null && (raw.buyers_premium == null || raw.estimated_shipping == null || raw.tax_estimate == null)) {
      record.total_estimated_cost = null;
    }

    Object.assign(record, {
      asset_id: raw.asset_id ?? null, seller_account_id: raw.seller_account_id ?? null,
      auction_id: raw.auction_id ?? null, lot_number: raw.lot_number ?? null,
      canonical_url: raw.canonical_url ?? record.listing_url, raw_condition: raw.raw_condition ?? null,
      starting_price: raw.starting_price ?? null, buy_now_price: raw.buy_now_price ?? null,
      shipping_method: raw.shipping_method, source_record: raw.source_record,
      bid_increment: raw.bid_increment ?? null, bid_count: raw.bid_count ?? null,
      reserve_status: raw.reserve_status ?? null, reserve_met: raw.reserve_met ?? null,
      buyers_premium_source: raw.buyers_premium_source ?? null, buyers_premium_confidence: raw.buyers_premium_confidence ?? null,
      shipping_available: raw.shipping_available ?? null, pickup_required: raw.pickup_required ?? null,
      pickup_location: raw.pickup_location ?? null, seller_name: raw.seller_name ?? null,
      seller_agency: raw.seller_agency ?? null, seller_type: raw.seller_type ?? null,
      auction_start_time: raw.auction_start_time ?? '', auction_status: raw.auction_status ?? 'UNKNOWN',
      time_remaining_seconds: raw.time_remaining_seconds ?? null, inspection_available: raw.inspection_available ?? null,
      inspection_details: raw.inspection_details ?? null, payment_terms: raw.payment_terms ?? null,
      removal_requirements: raw.removal_requirements ?? null, documents: raw.documents ?? [],
      bidding_allowed: raw.bidding_allowed ?? null, bidding_eligibility: raw.bidding_eligibility ?? 'UNKNOWN',
      bidding_restriction_message: raw.bidding_restriction_message ?? null,
      requires_account_review: raw.requires_account_review ?? false,
      account_restriction_detected: raw.account_restriction_detected ?? false,
      seller_restriction_detected: raw.seller_restriction_detected ?? false,
      buyers_premium_percent: raw.buyers_premium_percent ?? null,
      primary_image_url: raw.primary_image_url ?? record.primary_image_url ?? null,
    });
    // normalize.js leaves brand/model empty unless attributes.trusted has 'Brand'/'Model'; keep the mapped values as fallback
    record.brand = record.brand ?? raw.brand ?? null;
    record.model = record.model ?? raw.model ?? null;
    record.mpn = record.mpn ?? raw.mpn ?? null;

    const validation = validateRecord(record);
    if (!validation.valid) {
      stats.validation_failures += 1;
      stats.records_rejected += 1;
      log.error('GovDeals unified schema validation failed', { id: record.external_id, errors: validation.errors });
      return;
    }

    // Run quality completeness describes records eligible for emission. Bad individual
    // lots remain rejected and counted, but do not poison the denominator for valid lots.
    updateCompleteness(stats, raw);
    stats.records_processed += 1;
    searchIndex.set(ident.externalId, { fp, at: Date.now() }); // detail fetched OK: remember it
    const shouldIngest = forceRecheck || await dedupeManager.shouldProcess(record.external_id, record.content_hash);
    if (!shouldIngest) {
      stats.duplicates_skipped += 1;
      incrementStat('itemsSkipped');
      return;
    }

    addSupabaseAliases(record);
    await dataset.pushData(record);
    savedCount += 1;
    stats.records_saved += 1;
    incrementStat('itemsSaved');
    if (webhookManager) await webhookManager.add(record);
    await dedupeManager.markSeenWithFingerprint(record.external_id, record.content_hash, { price: record.current_price });

    if (onProgress && savedCount % Math.max(1, dedupeFlushInterval) === 0) {
      await onProgress({ recordsSaved: savedCount });
      await saveSearchIndex();
    }
    log.info('Saved GovDeals asset', { id: record.external_id, price: record.current_price, end: record.auction_end_time, title: record.title.slice(0, 80) });
  }

  async function runPool(client, work) {
    let next = 0;
    const worker = async () => {
      while (!fatal) {
        const idx = next; next += 1;
        if (idx >= work.length) return;
        const { row, ident, fp, forceRecheck = false } = work[idx];
        try {
          await processLot(client, row, ident, fp, { forceRecheck });
        } catch (err) {
          if (err.fatal) { fatal = err; return; }
          stats.detail_parse_failures += 1;
          stats.records_rejected += 1;
          log.error('GovDeals lot processing failed', { id: ident.externalId, error: String(err.message).slice(0, 200) });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(maxConcurrency, 6)) }, worker));
  }

  async function searchAll(client, searchText) {
    let page = 1;
    let totalPages = null;
    while (!fatal) {
      if (maxPages > 0 && page > maxPages) break;
      let result;
      try {
        result = await client.search({ page, displayRows, searchText, businessId });
      } catch (err) {
        if (err.code === 'GOVDEALS_API_SCHEMA_DRIFT') stats.schema_drift_events += 1;
        throw err;
      }
      stats.search_pages += 1;
      stats.pages_processed += 1;
      incrementStat('pagesVisited');
      if (page === 1) {
        stats.total_count_header = result.total;
        if (result.total != null) totalPages = Math.ceil(result.total / displayRows);
        if (recordFixtures && fixtureStore) {
          await fixtureStore.setValue('FIXTURE_search_page1', { x_total_count: result.total, assetSearchResults: result.rows.slice(0, 5) });
        }
      }
      if (result.rows.length === 0) {
        if (page === 1) {
          stats.zero_result_pages += 1;
          stats.schema_drift_events += 1; // an empty "*" search is not plausible
          log.warning('GovDeals search page 1 returned zero rows', { searchText });
        }
        break;
      }

      const now = Date.now();
      const work = [];
      for (const row of result.rows) {
        const ident = assetIdentity(row);
        if (!ident) { stats.records_rejected += 1; continue; }
        if (seenThisRun.has(ident.externalId)) { stats.duplicates_in_run += 1; continue; } // cross-listed (GI/NI/AD) or paging overlap
        seenThisRun.add(ident.externalId);
        stats.records_discovered += 1;
        incrementStat('itemsFound');
        if (seenExternalIds) seenExternalIds.add(ident.externalId);

        const fp = searchFingerprint(row);
        if (!needsDetail(ident.externalId, fp, now)) {
          stats.unchanged_search_skipped += 1;
          stats.duplicates_skipped += 1; // counts as dedupe evidence for the run-health check
          incrementStat('itemsSkipped');
          continue;
        }
        if (maxItemsPerRun > 0 && queuedCount >= maxItemsPerRun) { stats.capacity_skipped += 1; continue; }
        queuedCount += 1;
        stats.records_queued += 1;
        work.push({ row, ident, fp });
      }
      log.info('GovDeals search page processed', { page, rows: result.rows.length, needDetail: work.length, totalPages });

      await runPool(client, work);
      if (fatal) break;
      await saveSearchIndex();

      if (result.rows.length < displayRows) break;
      if (totalPages != null && page >= totalPages) break;
      page += 1;
    }
  }

  async function recheckSpecifiedLots(client) {
    const targets = new Map();
    for (const value of recheckLots) {
      const ident = parseRecheckIdentity(value);
      if (!ident) { stats.recheck_invalid += 1; log.warning('Invalid GovDeals recheckLots entry', { value: String(value).slice(0, 180) }); continue; }
      targets.set(ident.externalId, ident);
    }
    stats.recheck_targets = targets.size;
    if (stats.recheck_invalid) {
      throw new Error(`GOVDEALS_RECHECK_INPUT_INVALID: ${stats.recheck_invalid} recheckLots entries must be GovDeals detail URLs, govdeals-{accountId}-{assetId} IDs, or assetId/accountId pairs`);
    }
    if (!targets.size) throw new Error('GOVDEALS_RECHECK_INPUT_INVALID: recheckLots did not contain a valid target');
    for (const ident of targets.values()) {
      if (fatal) break;
      try {
        // Scope the search to this asset/account pair, then detail-fetch only the exact match.
        const result = await client.search({
          page: 1, displayRows: Math.min(displayRows, 500), searchText: ident.assetId,
          businessId, accountIds: [ident.sellerAccountId],
        });
        stats.search_pages += 1;
        stats.pages_processed += 1;
        incrementStat('pagesVisited');
        const row = result.rows.find((candidate) => assetIdentity(candidate)?.externalId === ident.externalId);
        if (!row) {
          stats.recheck_not_found += 1;
          log.warning('GovDeals recheck target not returned by targeted API search', { id: ident.externalId });
          continue;
        }
        if (seenExternalIds) seenExternalIds.add(ident.externalId);
        stats.records_discovered += 1;
        incrementStat('itemsFound');
        stats.records_queued += 1;
        await runPool(client, [{ row, ident, fp: searchFingerprint(row), forceRecheck: true }]);
      } catch (err) {
        if (err.fatal) { fatal = err; break; }
        stats.recheck_not_found += 1;
        stats.detail_parse_failures += 1;
        log.error('GovDeals targeted lot recheck failed', { id: ident.externalId, error: String(err.message).slice(0, 180) });
      }
    }
    if (stats.recheck_not_found) {
      throw new Error(`GOVDEALS_RECHECK_TARGETS_NOT_FOUND: ${stats.recheck_not_found} specified lot(s) were not returned by the targeted API search`);
    }
  }

  const crawler = {
    async run() {
      if (proxyEnabled) {
        throw new Error('GOVDEALS_PROXY_CONFIGURATION_FAILED: GovDeals API transport does not support proxy mode; set proxyEnabled=false');
      }
      const client = new GovDealsApiClient({
        apiKey, subscriptionKey, baseUrl: apiBaseUrl, requestTimeoutMs: requestTimeoutSecs * 1000,
        maxRetries: maxRequestRetries, requestDelayMs, stats, log, fetchImpl, sleep,
      });
      await loadSearchIndex();

      try {
        if (recheckLots.length) {
          await recheckSpecifiedLots(client); // explicitly targeted QA runs never search unrelated lots
        } else {
          const queries = keywords.length ? keywords : ['*']; // first scrape collects everything
          for (const q of queries) {
            if (fatal) break;
            await searchAll(client, q);
          }
        }
      } finally {
        await saveSearchIndex();
      }
      if (fatal) throw fatal;

      const health = evaluateRunHealth(stats);
      stats.health_status = health.status;
      stats.health_reasons = health.reasons;
      stats.health_warnings = health.warnings;
      stats.detail_success_ratio = health.detail_success_ratio;
      stats.completeness_rates = health.completeness;
      if (health.status === 'FAIL') throw new Error(`GOVDEALS_HEALTH_FAIL: ${health.reasons.join('; ')}`);
      if (health.status === 'DEGRADED') log.warning('GovDeals run health degraded', { warnings: health.warnings });
      return stats;
    },
    govdealsStats: stats,
  };
  return crawler;
}

export { parseAssetIdentity, GovDealsApiError };