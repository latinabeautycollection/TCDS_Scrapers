import { preserveSource } from '../municibid/sourceArchive.js';
/**
 * Municibid acquisition crawler V1.3 Fortune-500 final-gate hardened.
 * Strict PropertyRoom framework alignment with Municibid-specific
 * exhaustive discovery, durable recovery, request DLQ, and coverage reconciliation.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { Actor } from 'apify';
import { CheerioCrawler } from 'crawlee';
import { normalizeRecord, validateRecord, addSupabaseAliases } from '../utils/normalize.js';
import { inferAuctionStatus, timeRemainingSeconds } from '../municibid/text.js';
import { restoreSourceIdentity, applyNoBidRules, redactContacts, cityState, nullifyEmptyStrings, computeContentHash, validationShim } from '../municibid/fieldRules.js';
import { incrementStat } from '../utils/logging.js';
import {
  buildKeywordUrl,
  canonicalizeMunicibidUrl,
  exhaustiveSeedRequests,
  isDetailUrl,
  looksLikeErrorPage,
  parseAuctionIdentity,
  parseDetailPage,
  parseSearchPage,
  publicSearchUrl,
} from '../municibid/index.js';
import { evaluateRunHealth } from '../municibid/health.js';
import { stripVolatileObservationFields } from '../municibid/fingerprint.js';
import { MunicibidRecoveryState } from '../municibid/recovery.js';
import { SourceCircuitBreaker } from '../municibid/circuitBreaker.js';
import { MunicibidRunLease } from '../municibid/lease.js';

const DEFAULT_SEARCH = publicSearchUrl();
const ALLOWED_MUNICIBID_HOST = /(^|\.)municibid\.com$/i;

function classifyHttpStatus(status) {
  if (status === 200) return 'SUCCESS';
  if (status === 204) return 'EMPTY';
  if (status === 400) return 'BAD_REQUEST';
  if (status === 401) return 'AUTH_REQUIRED';
  if (status === 403) return 'ACCESS_DENIED';
  if (status === 404) return 'NOT_FOUND';
  if (status === 408) return 'TIMEOUT';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'UPSTREAM_FAILURE';
  return `HTTP_${status}`;
}

function hasValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function completenessFields(record) {
  return {
    external_id: record.external_id,
    title: record.title,
    listing_url: record.listing_url,
    current_price: record.current_price,
    auction_end_time: record.auction_end_time,
    location: record.location,
    seller_name: record.seller_name,
    condition: record.condition && record.condition !== 'UNKNOWN' ? record.condition : null,
  };
}

function updateCompleteness(stats, record, prefix) {
  const totalKey = `${prefix}_completeness_total`;
  const dataKey = `${prefix}_completeness`;
  const applicableKey = `${prefix}_completeness_applicable`;
  stats[totalKey] += 1;
  const fields = completenessFields(record);
  for (const [field, value] of Object.entries(fields)) {
    // A genuine no-bid auction has no current price yet (intake guide: null), so the price is not applicable there.
    const noBidAuction = record.current_price == null && Number(record.bid_count) === 0;
    const applicable = !(field === 'auction_end_time' && record.listing_type === 'FIXED_PRICE')
      && !(field === 'current_price' && noBidAuction);
    if (!applicable) continue;
    stats[applicableKey][field] += 1;
    if (hasValue(value)) stats[dataKey][field] += 1;
  }
}

function nextRetryIso(retryCount = 0) {
  const minutes = Math.min(60, 5 * (2 ** Math.min(4, Number(retryCount) || 0)));
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

export function retryDelayMs(status, retryCount, response, now = Date.now()) {
  if (status === 429) {
    const header = response?.headers?.['retry-after'] ?? response?.headers?.get?.('retry-after');
    if (header != null) {
      const raw = String(header).trim();
      const seconds = Number.parseInt(raw, 10);
      if (/^\d+$/.test(raw) && Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 120_000);
      const dateMs = Date.parse(raw);
      if (Number.isFinite(dateMs)) return Math.min(Math.max(0, dateMs - now), 120_000);
    }
  }
  const base = status === 429 ? 4000 : 2000;
  const jitter = Math.floor(Math.random() * 750);
  return Math.min(base * (2 ** Math.min(5, Number(retryCount) || 0)) + jitter, 120_000);
}

export function assertMunicibidUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (!/^https?:$/.test(url.protocol) || !ALLOWED_MUNICIBID_HOST.test(url.hostname)) {
    throw new Error(`Municibid start URL is outside approved host boundary: ${rawUrl}`);
  }
  return url.toString();
}

function targetedInitialRequests(startUrls, keywords) {
  const urls = [];
  for (const raw of startUrls || []) {
    const candidate = typeof raw === 'string' ? raw : raw?.url;
    if (!candidate) continue;
    assertMunicibidUrl(candidate);
    const url = canonicalizeMunicibidUrl(candidate);
    assertMunicibidUrl(url);
    urls.push({
      url,
      uniqueKey: `seed:${url}`,
      userData: { type: isDetailUrl(url) ? 'detail' : 'index', depth: 1, partition: 'operator_seed' },
    });
  }
  for (const kw of keywords || []) {
    const url = buildKeywordUrl(kw);
    assertMunicibidUrl(url);
    urls.push({ url, uniqueKey: `keyword:${String(kw).toLowerCase()}`, userData: { type: 'index', depth: 1, keyword: kw, partition: `keyword:${String(kw).toLowerCase()}` } });
  }
  if (!urls.length) urls.push({ url: DEFAULT_SEARCH, uniqueKey: 'default-search', userData: { type: 'index', depth: 1, partition: 'global_active' } });
  return urls;
}

function exhaustiveInitialRequests(startUrls, keywords, includeCompleted = false) {
  const map = new Map();
  for (const seed of exhaustiveSeedRequests({ includeCompleted })) {
    const url = canonicalizeMunicibidUrl(seed.url);
    map.set(url, { url, uniqueKey: `exhaustive:${seed.partition}:${url}`, userData: { type: 'index', depth: 1, partition: seed.partition } });
  }
  for (const req of targetedInitialRequests(startUrls, keywords)) map.set(req.url, req);
  return [...map.values()];
}

/** @param {object} opts */
export function createMunicibidCrawler(opts) {
  const {
    startUrls = [], keywords = [], recheckLots = [], discoveryMode = 'EXHAUSTIVE', includeSellerPartitions = true, includeCategoryPartitions = true, includeCompleted = false,
    maxPages = 0, maxDiscoveryRequests = 0, maxDetailRequests = 0, maxRuntimeMinutes = 0,
    maxConcurrency = 8, requestTimeoutSecs = 45, maxRequestRetries = 3,
    proxyEnabled = false, proxyGroups = [], proxyFallbackToDirect = false, debug = false,
    dataset, dedupeManager, webhookManager, seenExternalIds, stateKvStore,
    runContext = {}, sourceName = 'municibid', maxItemsPerRun = 0,
    dedupeFlushInterval = 500, recoveryPersistInterval = 100,
    circuitBreaker403Threshold = 10, circuitBreaker5xxThreshold = 20, circuitBreaker429Threshold = 30,
    singleWriterLeaseEnabled = true, runLeaseTtlMinutes = 30, completedEvidenceRetainEntries = 1000,
    onProgress, log, zeroResultsAlertThreshold = Number(process.env.ZERO_RESULTS_ALERT_THRESHOLD || 1),
    recordPages = false,
  } = opts;

  if (!stateKvStore) throw new Error('MUNICIBID_RECOVERY_STORE_REQUIRED');
  const exhaustive = recheckLots.length === 0 && String(discoveryMode).toUpperCase() === 'EXHAUSTIVE';
  const startedMs = Date.now();
  const partitionSets = new Map();
  const discoveredThisRun = new Set();
  const visitedIndexUrls = new Set();
  const recovery = new MunicibidRecoveryState(stateKvStore, { log, persistEvery: recoveryPersistInterval, completedEvidenceRetainEntries });
  const lease = new MunicibidRunLease(stateKvStore, {
    runId: runContext.actorRunId || `local-${process.pid}`,
    ttlMs: Math.max(1, Number(runLeaseTtlMinutes) || 30) * 60 * 1000,
    enabled: singleWriterLeaseEnabled,
    log,
    openLockQueue: async () => Actor.openRequestQueue('municibid-active-run-lock-v3'),
    verifyPriorRunTerminal: async (priorRunId) => {
      if (!priorRunId || String(priorRunId).startsWith('local-')) return { terminal: true, status: 'LOCAL_TEST_OWNER' };
      const run = await Actor.apifyClient.run(priorRunId).get();
      if (!run) return { terminal: false, status: 'RUN_NOT_FOUND' };
      const status = String(run.status || 'UNKNOWN').toUpperCase();
      const terminal = new Set(['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED']).has(status);
      return { terminal, status };
    },
  });
  const breaker = new SourceCircuitBreaker({
    maxConsecutive403: circuitBreaker403Threshold,
    maxConsecutive5xx: circuitBreaker5xxThreshold,
    maxRateLimited: circuitBreaker429Threshold,
  });

  const stats = {
    transport: 'municibid_html', discovery_mode: exhaustive ? 'EXHAUSTIVE' : 'TARGETED',
    requests_total: 0, requests_attempted: 0, requests_success: 0, requests_success_first_attempt: 0,
    requests_success_after_retry: 0, requests_failed: 0, requests_permanently_failed: 0, retry_attempts: 0,
    html_requests: 0, pages_processed: 0, index_pages_processed: 0, detail_pages_attempted: 0,
    detail_pages_parsed: 0, detail_parse_failures: 0, normalization_failures: 0, validation_failures: 0,
    records_discovered: 0, records_discovered_unique: 0, records_queued: 0, records_processed: 0,
    records_saved: 0, records_rejected: 0, duplicates_skipped: 0, zero_result_pages: 0,
    rate_limit_events: 0, access_denied_events: 0, auth_required_events: 0, schema_drift_events: 0, filtered_records: 0,
    http_401: 0, http_403: 0, http_404: 0, http_408: 0, http_429: 0, http_5xx: 0,
    discovery_requests: 0, detail_requests: 0, records_normalized: 0, records_validated: 0,
    capacity_skipped: 0, capacity_truncated: false, runtime_truncated: false, terminal_removed: 0, dlq_replayed: 0, checkpoint_resumed: false,
    discovery_partitions: {}, circuit_open_reason: null, lease_lost: false, lease_error: null,
    extraction_completeness_total: 0,
    extraction_completeness: { external_id: 0, title: 0, listing_url: 0, current_price: 0, auction_end_time: 0, location: 0, seller_name: 0, condition: 0 },
    normalized_completeness_total: 0,
    normalized_completeness: { external_id: 0, title: 0, listing_url: 0, current_price: 0, auction_end_time: 0, location: 0, seller_name: 0, condition: 0 },
    extraction_completeness_applicable: { external_id: 0, title: 0, listing_url: 0, current_price: 0, auction_end_time: 0, location: 0, seller_name: 0, condition: 0 },
    normalized_completeness_applicable: { external_id: 0, title: 0, listing_url: 0, current_price: 0, auction_end_time: 0, location: 0, seller_name: 0, condition: 0 },
  };

  let savedCount = 0;
  let discoveryRequestsQueued = 0;
  let detailRequestsQueued = 0;
  let fatalLeaseError = null;
  let fatalCircuitError = null;

  const triggerFatalLease = (err) => {
    if (fatalLeaseError) return;
    fatalLeaseError = err instanceof Error ? err : new Error(String(err));
    stats.lease_lost = true;
    stats.lease_error = fatalLeaseError.message;
    crawler?.autoscaledPool?.abort();
  };
  const triggerCircuitAbort = (reason) => {
    if (fatalCircuitError) return;
    fatalCircuitError = new Error(`MUNICIBID_CIRCUIT_OPEN:${reason}`);
    stats.circuit_open_reason = reason;
    crawler?.autoscaledPool?.abort();
  };

  const runtimeCheck = () => {
    if (fatalLeaseError) throw fatalLeaseError;
    if (fatalCircuitError) throw fatalCircuitError;
    if (maxRuntimeMinutes > 0 && Date.now() - startedMs >= maxRuntimeMinutes * 60 * 1000) {
      stats.runtime_truncated = true;
      stats.capacity_truncated = true;
      crawler.autoscaledPool?.abort();
      return false;
    }
    try { breaker.assertClosed(); } catch (err) { triggerCircuitAbort(err.message); throw err; }
    return true;
  };

  const notePartition = (partition, externalId) => {
    const key = partition || 'unknown';
    if (!partitionSets.has(key)) partitionSets.set(key, new Set());
    partitionSets.get(key).add(externalId);
  };

  const crawler = new CheerioCrawler({
    maxConcurrency: Math.max(1, Math.min(maxConcurrency, 20)),
    requestHandlerTimeoutSecs: Math.max(15, Math.min(requestTimeoutSecs, 300)),
    maxRequestRetries,
    preNavigationHooks: [async ({ request }) => {
      if (!runtimeCheck()) return;
      try { await lease.assertOwned(); } catch (err) { triggerFatalLease(err); throw err; }
      stats.requests_attempted += 1;
      stats.requests_total += 1;
      stats.html_requests += 1;
      if ((request.retryCount || 0) > 0) stats.retry_attempts += 1;
      const requestType = request.userData?.type ?? (isDetailUrl(request.url) ? 'detail' : 'index');
      if (requestType === 'detail') stats.detail_requests += 1; else stats.discovery_requests += 1;
      request.headers = {
        ...request.headers,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      };
    }],

    async requestHandler({ body, request, response }) {
      if (!runtimeCheck()) return;
      try { await lease.assertOwned(); } catch (err) { triggerFatalLease(err); throw err; }
      const status = response?.statusCode ?? 0;
      const statusClass = classifyHttpStatus(status);
      const type = request.userData?.type ?? (isDetailUrl(request.url) ? 'detail' : 'index');
      const identity = type === 'detail' ? parseAuctionIdentity(request.url) : null;
      const externalId = identity?.externalId || request.userData?.externalId || null;

      if (status >= 200 && status < 300) {
        stats.requests_success += 1;
        if ((request.retryCount || 0) > 0) stats.requests_success_after_retry += 1;
        else stats.requests_success_first_attempt += 1;
        breaker.note(status);
      }
      if (status === 401) { stats.http_401 += 1; stats.auth_required_events += 1; }
      if (status === 403) { stats.http_403 += 1; stats.access_denied_events += 1; }
      if (status === 404) stats.http_404 += 1;
      if (status === 408) stats.http_408 += 1;
      if (status === 429) { stats.http_429 += 1; stats.rate_limit_events += 1; }
      if (status >= 500) stats.http_5xx += 1;

      if (status === 404) {
        if (type === 'detail' && externalId) {
          stats.terminal_removed += 1;
          await recovery.disposition(externalId, 'REMOVED_CONFIRMED', { url: request.url, status });
          await recovery.resolveFailure(request.url, externalId);
          return;
        }
        request.noRetry = true;
        throw new Error(`Municibid NOT_FOUND for ${request.url}`);
      }

      if (status === 401 || status === 403) {
        request.noRetry = true;
        const reason = breaker.note(status);
        if (reason) triggerCircuitAbort(reason);
        if (type === 'detail' && externalId) {
          const disposition = status === 401 ? 'AUTH_REQUIRED' : 'ACCESS_RESTRICTED';
          await recovery.disposition(externalId, disposition, { url: request.url, status });
          await recovery.resolveFailure(request.url, externalId, disposition);
        }
        throw new Error(`Municibid ${statusClass} for ${request.url}`);
      }

      if (status === 429 || status >= 500 || status === 408) {
        const reason = breaker.note(status);
        if (reason) {
          triggerCircuitAbort(reason);
          request.noRetry = true;
          throw new Error(`MUNICIBID_CIRCUIT_OPEN:${reason}`);
        }
        await sleep(retryDelayMs(status, request.retryCount || 0, response));
        throw new Error(`Municibid ${statusClass} for ${request.url}`);
      }

      const html = Buffer.isBuffer(body) ? body.toString('utf8') : String(body ?? '');
      if (recordPages && (globalThis.__municibidRecorded = (globalThis.__municibidRecorded || 0) + 1) <= 4) {
        // Diagnostic: save real page HTML (no keys/headers) so fixtures can replace the synthetic ones.
        try {
          const kind = isDetailUrl(request.url) ? 'detail' : 'index';
          const store = await Actor.openKeyValueStore();
          await store.setValue(`FIXTURE_html_${kind}_${globalThis.__municibidRecorded}`, html, { contentType: 'text/html; charset=utf-8' });
        } catch (err) { log.warning(`Could not record page HTML: ${err.message}`); }
      }
      if (!html.trim()) throw new Error(`Municibid EMPTY_BODY for ${request.url}`);
      if (looksLikeErrorPage(html)) {
        stats.schema_drift_events += 1;
        throw new Error(`Municibid ERROR_PAGE_DETECTED for ${request.url}`);
      }

      stats.pages_processed += 1;
      incrementStat('pagesVisited');

      if (type === 'index') {
        stats.index_pages_processed += 1;
        const parsed = parseSearchPage(html, request.url, { includeSellerPartitions, includeCategoryPartitions, includeCompleted });
        const depth = request.userData?.depth ?? 1;
        const partition = request.userData?.partition || 'index';
        if (parsed.items.length === 0 && /\/(?:browse|map|auctions)(?:\/|$)/i.test(new URL(request.url).pathname)) {
          stats.zero_result_pages += 1;
          log.warning('Municibid search page returned zero asset links', { url: request.url, depth, partition });
          if (stats.zero_result_pages >= zeroResultsAlertThreshold) stats.schema_drift_events += 1;
        }

        stats.records_discovered += parsed.items.length;
        incrementStat('itemsFound', parsed.items.length);
        for (const item of parsed.items) {
          discoveredThisRun.add(item.externalId);
          notePartition(partition, item.externalId);
          if (seenExternalIds) seenExternalIds.add(item.externalId);
          await recovery.noteDiscovered(item.externalId, partition);

          const keyword = request.userData?.keyword ? String(request.userData.keyword).trim().toLowerCase() : '';
          if (keyword && !String(`${item.title || ''} ${item.indexText || ''}`).toLowerCase().includes(keyword)) {
            stats.filtered_records += 1;
            await recovery.disposition(item.externalId, 'FILTERED_GOVERNED', { reason: 'keyword_mismatch', keyword, url: item.listingUrl });
            continue;
          }

          if (maxDetailRequests > 0 && detailRequestsQueued >= maxDetailRequests) {
            stats.capacity_skipped += 1;
            stats.capacity_truncated = true;
            await recovery.queueDetail(item.externalId, { url: item.listingUrl, indexObservation: item, partition });
            continue;
          }
          if (dedupeManager.isQueued(item.externalId)) continue;
          dedupeManager.markQueued(item.externalId);
          await recovery.queueDetail(item.externalId, { url: item.listingUrl, indexObservation: item, partition });
          await crawler.addRequests([{
            url: item.listingUrl,
            uniqueKey: item.externalId,
            userData: { type: 'detail', externalId: item.externalId, indexObservation: item, partition },
          }]);
          stats.records_queued += 1;
          detailRequestsQueued += 1;
        }

        const nextLinks = [...parsed.pagination];
        if (exhaustive) nextLinks.push(...(parsed.discoveryLinks || []).map((x) => x.url));
        const discoveryMeta = new Map((parsed.discoveryLinks || []).map((x) => [canonicalizeMunicibidUrl(x.url), x]));
        for (const next of nextLinks) {
          if (!next) continue;
          const normalized = canonicalizeMunicibidUrl(next);
          assertMunicibidUrl(normalized);
          if (visitedIndexUrls.has(normalized)) continue;
          if (maxDiscoveryRequests > 0 && discoveryRequestsQueued >= maxDiscoveryRequests) {
            stats.capacity_skipped += 1;
            stats.capacity_truncated = true;
            await recovery.queueIndex(normalized, { partition: discoveryMeta.get(normalized)?.partition || partition, depth: depth + 1 });
            continue;
          }
          if (maxPages > 0 && depth >= maxPages && /[?&]page=\d+/i.test(normalized)) {
            stats.capacity_skipped += 1;
            stats.capacity_truncated = true;
            await recovery.queueIndex(normalized, { partition: discoveryMeta.get(normalized)?.partition || partition, depth: depth + 1, truncation_reason: 'maxPages' });
            continue;
          }
          visitedIndexUrls.add(normalized);
          const meta = discoveryMeta.get(normalized);
          const childPartition = meta?.partition || (/[?&]page=/i.test(normalized) ? partition : `linked:${partition}`);
          await recovery.queueIndex(normalized, { partition: childPartition, depth: depth + 1 });
          await crawler.addRequests([{
            url: normalized,
            uniqueKey: `index:${normalized}`,
            userData: { type: 'index', depth: depth + 1, partition: childPartition },
          }]);
          discoveryRequestsQueued += 1;
        }
        await recovery.completeIndex(request.url, { partition, depth, items: parsed.items.length });
        await recovery.resolveFailure(request.url);
        return;
      }

      stats.detail_pages_attempted += 1;
      const observedAt = new Date().toISOString();
      let raw;
      try {
        raw = parseDetailPage(html, request.url, observedAt);
        const indexObs = request.userData?.indexObservation || {};
        if (!raw.auction_end_time && indexObs.auctionEndTime) raw.auction_end_time = indexObs.auctionEndTime;
        if (!raw.location && indexObs.location) raw.location = indexObs.location;
        if (!raw.lot_number && indexObs.lotNumber) raw.lot_number = indexObs.lotNumber;
        if (indexObs.eventId) raw.source_meta.event_id = indexObs.eventId;
        // ── Real listing data from the embedded payload (via the index page) ─────────
        if (indexObs.agencyName) { raw.seller_name = indexObs.agencyName; raw.seller_agency = indexObs.agencyName; }
        if (indexObs.sellerUserName) raw.source_meta.seller_user_name = indexObs.sellerUserName;
        if (indexObs.payloadLocation) raw.location = indexObs.payloadLocation; // parsed header text was unreliable
        if (raw.bid_count == null && indexObs.payloadBidCount != null) raw.bid_count = indexObs.payloadBidCount;
        if (raw.current_price == null && indexObs.payloadCurrentPrice != null && Number(indexObs.payloadBidCount) > 0) raw.current_price = indexObs.payloadCurrentPrice;
        if (raw.starting_price == null && indexObs.payloadBidCount === 0 && indexObs.payloadCurrentPrice != null) raw.starting_price = indexObs.payloadCurrentPrice;
        if ((!Array.isArray(raw.images) || raw.images.length === 0) && indexObs.primaryImageUrl) raw.images = [indexObs.primaryImageUrl];
        if (raw.auction_end_time) {
          raw.auction_status = inferAuctionStatus('', raw.auction_end_time, new Date(raw.observed_at || Date.now()));
          raw.time_remaining_seconds = timeRemainingSeconds(raw.auction_end_time, raw.observed_at);
        } else {
          log.warning('Municibid end time missing after payload fallbacks', { id: raw.external_id });
        }
        // Intake guide: a lot with no bids has a null price (the "Current Bid" shown is the starting bid). Search-page text prices are never used.
        // Preserve every fetched detail response and original parsed record, before normalization.
        // Default run KV store: never the shared recovery store. Failure prevents silent evidence loss.
        if (!includeCompleted && (['ENDED', 'CANCELLED'].includes(raw.auction_status) || Date.parse(raw.auction_end_time) <= Date.parse(observedAt))) {
          stats.filtered_records += 1;
          await recovery.disposition(raw.external_id, 'FILTERED_GOVERNED', { reason: 'closed_auction', url: request.url });
          await recovery.resolveFailure(request.url, raw.external_id);
          log.info('Skipping closed Municibid lot', { id: raw.external_id, end: raw.auction_end_time });
          return;
        }
        const evidenceStore = await Actor.openKeyValueStore();
        raw.source_meta.original_record = await preserveSource(evidenceStore, html, raw, indexObs, request.url, observedAt);
        raw.source_record = { ...(raw.source_record || {}), archive: raw.source_meta.original_record };
        applyNoBidRules(raw);
        stripVolatileObservationFields(raw);
        stats.detail_pages_parsed += 1;
        updateCompleteness(stats, raw, 'extraction');
      } catch (err) {
        stats.detail_parse_failures += 1;
        incrementStat('errors');
        log.warning('Municibid detail extraction failed; allowing governed Crawlee retry', {
          url: request.url,
          retryCount: request.retryCount || 0,
          error: err.message,
        });
        // Do not commit a terminal disposition or source-DLQ record here. Throwing
        // lets Crawlee perform the configured automatic retries. The permanent
        // failedRequestHandler records RETRY_PENDING only after retry exhaustion.
        throw err;
      }

      if (raw.current_price == null) {
        stats.records_rejected += 1;
        await recovery.disposition(raw.external_id, 'VALIDATION_FAILED', { phase: 'source_validation', reason: 'current_price_unavailable', url: request.url });
        log.warning('Municibid record rejected: current price unavailable', { id: raw.external_id, url: request.url });
        return;
      }
      if (!raw.auction_end_time) raw.normalization_status = 'valid_with_warnings';

      let record;
      try {
        record = normalizeRecord({
          ...raw,
          record_lineage: {
            source: 'municibid', transport: 'municibid_html',
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
        await recovery.disposition(raw.external_id, 'NORMALIZATION_FAILED', { phase: 'normalization', error: err.message, url: request.url });
        log.error('Municibid normalization failed', { url: request.url, error: err.message });
        return;
      }

      if (raw.total_estimated_cost == null && (raw.buyers_premium == null || raw.estimated_shipping == null || raw.tax_estimate == null)) record.total_estimated_cost = null;
      Object.assign(record, {
        listing_type: raw.listing_type ?? 'UNKNOWN', asset_id: raw.asset_id ?? null,
        category: raw.category ?? record.category ?? null, subcategory: raw.subcategory ?? record.subcategory ?? null,
        year: raw.year ?? null, make: raw.make ?? null, manufacturer: raw.manufacturer ?? null, model: raw.model ?? null,
        model_number: raw.model_number ?? null, vin: raw.vin ?? null, mileage: raw.mileage ?? null, hours: raw.hours ?? null,
        serial_number: raw.serial_number ?? null, custom_id: raw.custom_id ?? null,
        auction_id: raw.auction_id ?? raw.source_meta?.event_id ?? null, lot_number: raw.lot_number ?? null,
        canonical_url: raw.canonical_url ?? record.listing_url, raw_condition: raw.raw_condition ?? null,
        minimum_bid: raw.minimum_bid ?? null, starting_price: raw.starting_price ?? null, bid_increment: raw.bid_increment ?? null, bid_count: raw.bid_count ?? null,
        reserve_status: raw.reserve_status ?? null, reserve_met: raw.reserve_met ?? null,
        buyers_premium_pct: raw.buyers_premium_pct ?? null, buyers_premium_source: raw.buyers_premium_source ?? null,
        buyers_premium_confidence: raw.buyers_premium_confidence ?? null, estimated_shipping: raw.estimated_shipping ?? null, shipping_available: raw.shipping_available ?? null,
        pickup_required: raw.pickup_required ?? null, pickup_location: raw.pickup_location ?? null,
        seller_name: raw.seller_name ?? null, seller_agency: raw.seller_agency ?? null, seller_type: raw.seller_type ?? null,
        auction_start_time: raw.auction_start_time ?? null, auction_start_time_source: raw.auction_start_time_source ?? 'not_published_by_site',
        auction_end_time: raw.auction_end_time ?? null, auction_extension_possible: raw.auction_extension_possible ?? null,
        price_type: raw.price_type ?? null, shipping_method: raw.shipping_method ?? null, source_record: raw.source_record ?? null,
        bid_deposit: raw.bid_deposit ?? null, auction_status: raw.auction_status ?? 'UNKNOWN',
        time_remaining_seconds: raw.time_remaining_seconds ?? null, inspection_available: raw.inspection_available ?? null,
        inspection_details: raw.inspection_details ?? null, payment_terms: raw.payment_terms ?? null,
        removal_requirements: raw.removal_requirements ?? null, documents: raw.documents ?? [],
        bidding_allowed: raw.bidding_allowed ?? null, bidding_eligibility: raw.bidding_eligibility ?? 'UNKNOWN',
        bidding_restriction_message: raw.bidding_restriction_message ?? null, requires_account_review: raw.requires_account_review ?? false,
      });

      // ── Intake-guide alignment (done here, not in the shared normalizer) ───
      record.current_price = raw.current_price ?? null;
      record.mpn = raw.mpn ?? null;
      record.shipping_evidence = raw.shipping_evidence ?? null;
      record.condition_evidence = raw.condition_evidence ?? null;
      record.condition = raw.raw_condition || null;
      record.condition_text = raw.raw_condition || null;
      record.buyers_premium = raw.buyers_premium_pct ?? null; // percent (guide), not dollars
      record.description = redactContacts(raw.description) || null;
      for (const f of ['inspection_details', 'payment_terms', 'removal_requirements', 'special_instructions']) {
        if (record[f] != null) record[f] = redactContacts(record[f]) || null;
      }
      // Preserve an extracted location if its formatting cannot be safely reduced to City, ST.
      // A strict parser previously discarded one of eleven genuine source values and failed health.
      const originalLocation = [raw.location, raw.pickup_location, record.location]
        .find(value => typeof value === 'string' && value.trim().length > 0);
      const standardizedLocation = cityState(raw.location) || cityState(raw.pickup_location) || cityState(record.location);
      record.location = standardizedLocation || originalLocation?.trim() || null;
      const locationNeedsReview = Boolean(record.location && !standardizedLocation);
      // The shared normalizer can leave '' here, and ?? does not replace '', so use ||.
      restoreSourceIdentity(record, raw);
      if (Array.isArray(raw.images) && raw.images.length) record.image_urls = raw.images;
      record.primary_image_url = (Array.isArray(record.image_urls) && record.image_urls[0]) || null; // first photo, not alphabetical
      record.attributes = {
        ...(record.attributes && typeof record.attributes === 'object' ? record.attributes : {}),
        original_record: raw.source_meta?.original_record ?? null,
        location_original: raw.location ?? null, location_format_needs_review: locationNeedsReview,
        bid_count: raw.bid_count ?? null, minimum_bid: raw.minimum_bid ?? null, starting_price: raw.starting_price ?? null,
        buyers_premium_source: raw.buyers_premium_pct != null ? 'municibid_listing_page' : null,
        seller: raw.seller_name ?? null, lot_number: raw.custom_id ?? raw.lot_number ?? null, listing_id: raw.asset_id ?? null,
        vin: raw.vin ?? null, year: raw.year ?? null, make: raw.make ?? null, mileage: raw.mileage ?? null, hours: raw.hours ?? null,
        serial_number: raw.serial_number ?? null, reserve_status: raw.reserve_status ?? null,
        condition_source: raw.condition_source ?? 'not_published_by_site',
        condition_evidence: raw.condition_evidence ?? null, shipping_evidence: raw.shipping_evidence ?? null,
        auction_extension_possible: raw.auction_extension_possible ?? null, pickup_location: raw.pickup_location ?? null,
        payment_details: raw.source_meta?.payment_details ?? null, seller_terms: raw.source_meta?.seller_terms ?? null,
        removal_requirements: record.removal_requirements ?? null, inspection_details: record.inspection_details ?? null,
        auction_start_time: raw.auction_start_time ?? null, auction_start_time_source: raw.auction_start_time_source ?? 'not_published_by_site', auction_end_time: raw.auction_end_time ?? null,
        price_type: raw.price_type ?? null, shipping_method: raw.shipping_method ?? null,
        source_record: raw.source_record ?? null,
        shipping_available: raw.shipping_available ?? null, estimated_shipping: raw.estimated_shipping ?? null,
        shipping_cost_source: raw.source_meta?.shipping_cost_source ?? null, pickup_required: raw.pickup_required ?? null,
        bid_count_inferred: raw.source_meta?.bid_count_inferred ?? false,
        price_status: raw.bid_count === 0 ? 'starting_bid' : raw.price_type === 'buy_now' ? 'buy_now' : raw.current_price == null ? 'unavailable' : 'active_bid',
      };
      nullifyEmptyStrings(record);
      record.category = raw.category ?? null;
      record.content_hash = computeContentHash(record);

      stats.records_normalized += 1;
      // validateRecord needs strings/number; the guide wants null. Validate a shim, keep null on the record.
      const validation = validateRecord(validationShim(record));
      if (!validation.valid) {
        stats.validation_failures += 1;
        stats.records_rejected += 1;
        await recovery.disposition(record.external_id, 'VALIDATION_FAILED', { phase: 'unified_schema', errors: validation.errors, url: request.url });
        log.error('Municibid unified schema validation failed', { id: record.external_id, errors: validation.errors });
        return;
      }

      stats.records_processed += 1;
      stats.records_validated += 1;
      updateCompleteness(stats, record, 'normalized');
      const knownBefore = dedupeManager.isDuplicate(record.external_id);
      const shouldIngest = request.userData?.recheck === true || await dedupeManager.shouldProcess(record.external_id, record.content_hash);
      if (!shouldIngest) {
        stats.duplicates_skipped += 1;
        incrementStat('itemsSkipped');
        await recovery.disposition(record.external_id, 'SKIPPED_UNCHANGED', { url: request.url });
        await recovery.resolveFailure(request.url, record.external_id);
        return;
      }

      if (maxItemsPerRun > 0 && savedCount >= maxItemsPerRun) {
        stats.capacity_skipped += 1;
        stats.capacity_truncated = true;
        await recovery.queueDetail(record.external_id, { url: request.url, indexObservation: request.userData?.indexObservation || {}, partition: request.userData?.partition || 'detail' });
        crawler.autoscaledPool?.abort();
        return;
      }

      addSupabaseAliases(record);
      // Alias enrichment must not overwrite the verified source identity fields.
      restoreSourceIdentity(record, raw);
      // Legacy aliases re-introduce '' values, a category slug and a dollar "fees" alias. Re-align with the guide:
      // site's own category name (slug kept in attributes), premium is a percent.
      record.attributes = { ...(record.attributes || {}), category_key: record.category_key ?? null };
      record.category = raw.category ?? null;
      record.inbound_fees_usd = null;
      nullifyEmptyStrings(record);
      try { await lease.assertOwned(); } catch (err) { triggerFatalLease(err); throw err; }
      await dataset.pushData(record);
      savedCount += 1;
      stats.records_saved += 1;
      incrementStat('itemsSaved');
      if (webhookManager) await webhookManager.add(record);

      try { await lease.assertOwned(); } catch (err) { triggerFatalLease(err); throw err; }
      await dedupeManager.markSeenWithFingerprint(record.external_id, record.content_hash, { price: record.current_price });
      await recovery.disposition(record.external_id, knownBefore ? 'SAVED_CHANGED' : 'SAVED_NEW', { url: request.url, content_hash: record.content_hash });
      await recovery.resolveFailure(request.url, record.external_id);

      if (onProgress && savedCount % Math.max(1, dedupeFlushInterval) === 0) await onProgress({ recordsSaved: savedCount });
      log.info('Saved Municibid asset', { id: record.external_id, listingType: record.listing_type, price: record.current_price, end: record.auction_end_time, title: record.title.slice(0, 80) });
    },

    async failedRequestHandler({ request, error, response }) {
      try { await lease.assertOwned(); } catch (leaseErr) { triggerFatalLease(leaseErr); return; }
      stats.requests_failed += 1;
      stats.requests_permanently_failed += 1;
      const status = response?.statusCode ?? null;
      const type = request.userData?.type ?? (isDetailUrl(request.url) ? 'detail' : 'index');
      const identity = type === 'detail' ? parseAuctionIdentity(request.url) : null;
      const externalId = identity?.externalId || request.userData?.externalId || null;
      incrementStat('errors');

      if (status === 401 || status === 403) {
        if (externalId) {
          const disposition = status === 401 ? 'AUTH_REQUIRED' : 'ACCESS_RESTRICTED';
          await recovery.disposition(externalId, disposition, { url: request.url, status });
          await recovery.resolveFailure(request.url, externalId, disposition);
        }
      } else {
        await recovery.addFailure({
          url: request.url, externalId, requestType: type, partition: request.userData?.partition || null, retryCount: request?.retryCount ?? 0,
          status, error: error?.message, errorClass: classifyHttpStatus(status || 0), sourceRunId: runContext.actorRunId, nextRetryAfter: nextRetryIso(request?.retryCount),
        });
      }
      log.error('Municibid request failed after retries', { url: request.url, status, retries: request?.retryCount ?? 0, error: error?.message?.slice(0, 300) });
    },
  });

  const originalRun = crawler.run.bind(crawler);
  crawler.run = async function runMunicibid() {
    if (proxyEnabled) {
      try {
        const proxyConfig = await Actor.createProxyConfiguration({ groups: proxyGroups?.length ? proxyGroups : ['DATACENTER'], countryCode: 'US' });
        crawler.proxyConfiguration = proxyConfig;
      } catch (err) {
        if (!proxyFallbackToDirect) throw new Error(`MUNICIBID_PROXY_CONFIGURATION_FAILED: ${err.message}`);
        log.warning('Municibid proxy setup failed; explicit proxyFallbackToDirect=true permits direct transport', { error: err.message });
      }
    }

    await lease.acquire();
    let init;
    try {
      init = await recovery.initialize(runContext.inputFingerprint || 'no-input-fingerprint');
    } catch (err) {
      await lease.release();
      throw err;
    }
    stats.checkpoint_resumed = init.resume;
    const persistRecovery = async () => {
      try {
        await recovery.persist(true);
        await lease.renew();
      } catch (err) {
        log.error('Municibid recovery/lease persist failed; lease ownership is fatal', { error: err.message });
        if (/LEASE_LOST|ATOMIC_LOCK_LOST|LEASE_RACE|ATOMIC_LOCK_OWNERSHIP/.test(err.message)) triggerFatalLease(err);
        else throw err;
      }
    };
    Actor.on('aborting', persistRecovery);
    Actor.on('migrating', persistRecovery);
    Actor.on('persistState', persistRecovery);
    const leaseRenewTimer = singleWriterLeaseEnabled ? setInterval(() => {
      lease.renew().catch((err) => {
        log.error('Municibid periodic lease renewal failed; aborting source crawl', { error: err.message });
        triggerFatalLease(err);
      });
    }, Math.max(20_000, Math.floor(Math.max(1, Number(runLeaseTtlMinutes) || 30) * 60 * 1000 / 3))) : null;
    leaseRenewTimer?.unref?.();

    let initial = [];
    if (init.resume) {
      for (const item of recovery.pendingIndexRequests()) {
        initial.push({ url: item.url, uniqueKey: `resume:index:${item.url}`, userData: { type: 'index', depth: item.depth || 1, partition: item.partition || 'resume' } });
      }
      for (const item of recovery.pendingDetailRequests()) {
        initial.push({ url: item.url, uniqueKey: `resume:detail:${item.external_id}`, userData: { type: 'detail', externalId: item.external_id, indexObservation: item.indexObservation || {}, partition: item.partition || 'resume' } });
      }
    }

    for (const item of recovery.replayRequests()) {
      initial.push({
        url: item.url,
        uniqueKey: `dlq:${item.external_id || item.url}`,
        userData: { type: item.request_type || 'detail', externalId: item.external_id || undefined, partition: 'dlq_replay' },
      });
      stats.dlq_replayed += 1;
    }

    // Resume/DLQ sources can overlap (especially failed index pages). Collapse by
    // governed source identity/URL before handing requests to Crawlee.
    if (initial.length) {
      const unique = new Map();
      for (const req of initial) {
        const key = req.userData?.externalId ? `detail:${req.userData.externalId}` : `${req.userData?.type || 'index'}:${canonicalizeMunicibidUrl(req.url)}`;
        if (!unique.has(key) || req.userData?.partition === 'dlq_replay') unique.set(key, req);
      }
      initial = [...unique.values()];
    }

    if (!initial.length) initial = exhaustive ? exhaustiveInitialRequests(startUrls, keywords, includeCompleted) : targetedInitialRequests(startUrls, keywords);
    if (recheckLots.length) {
      initial = targetedInitialRequests(recheckLots, []).map(req => ({ ...req, uniqueKey: `recheck:${runContext.actorRunId}:${req.url}`, userData: { ...req.userData, recheck: true } }));
    }
    for (const req of initial) {
      assertMunicibidUrl(req.url);
      if (req.userData.type === 'index') {
        visitedIndexUrls.add(req.url);
        await recovery.queueIndex(req.url, { partition: req.userData.partition || 'seed', depth: req.userData.depth || 1 });
        discoveryRequestsQueued += 1;
      } else if (req.userData.externalId) {
        dedupeManager.markQueued(req.userData.externalId);
        detailRequestsQueued += 1;
      }
    }

    try {
      await originalRun(initial);
      if (fatalLeaseError) throw fatalLeaseError;
      if (fatalCircuitError) throw fatalCircuitError;
      await lease.assertOwned();
    } catch (err) {
      if (leaseRenewTimer) clearInterval(leaseRenewTimer);
      await recovery.persist(true);
      await lease.release();
      throw err;
    }
    if (leaseRenewTimer) clearInterval(leaseRenewTimer);

    stats.records_discovered_unique = recovery.reconciliation().discovered_unique;
    stats.discovery_partitions = Object.fromEntries([...partitionSets.entries()].map(([k, v]) => [k, v.size]));
    let reconciliation = recovery.reconciliation();
    stats.reconciliation = reconciliation;
    stats.discovery_partitions_total = reconciliation.discovery_partitions_total;
    stats.discovery_partitions_completed = reconciliation.discovery_partitions_completed;
    const health = evaluateRunHealth(stats, { discoveryMode: exhaustive ? 'EXHAUSTIVE' : 'TARGETED', reconciliation });
    stats.health_status = health.status;
    stats.health_reasons = health.reasons;
    stats.health_incomplete_reasons = health.incomplete_reasons;
    stats.health_warnings = health.warnings;
    stats.detail_success_ratio = health.detail_success_ratio;
    stats.normalization_success_ratio = health.normalization_success_ratio;
    stats.validation_success_ratio = health.validation_success_ratio;
    stats.completeness_rates = health.completeness;
    stats.extraction_completeness_rates = health.extraction_completeness;
    stats.circuit_state = { ...breaker.snapshot?.() };
    stats.lock_state = lease.snapshot();

    const completionManifest = {
      source: 'municibid',
      run_id: runContext.actorRunId ?? null,
      actor_build_id: runContext.actorBuildId ?? null,
      release_version: runContext.releaseVersion ?? null,
      build_tag: runContext.buildTag ?? null,
      input_fingerprint: runContext.inputFingerprint ?? null,
      discovery_mode: exhaustive ? 'EXHAUSTIVE' : 'TARGETED',
      run_status: health.status,
      discovery_partitions_total: reconciliation.discovery_partitions_total,
      discovery_partitions_completed: reconciliation.discovery_partitions_completed,
      reconciliation,
      dlq_pending: reconciliation.retry_pending,
      circuit_state: stats.circuit_state,
      lock_state: stats.lock_state,
      started_at: new Date(startedMs).toISOString(),
      completed_at: new Date().toISOString(),
    };

    if (health.status === 'FAIL') {
      await recovery.markFailed({ manifest: completionManifest });
      await lease.release();
      throw new Error(`MUNICIBID_HEALTH_FAIL: ${health.reasons.join('; ')}`);
    }
    if (health.status === 'INCOMPLETE') {
      await recovery.persist(true);
      log.warning('Municibid run incomplete and resumable', { reasons: health.incomplete_reasons });
      return stats;
    }
    if (health.status === 'DEGRADED') log.warning('Municibid run health degraded', { warnings: health.warnings });
    await recovery.persist(true);
    return stats;
  };

  crawler.municibidStats = stats;
  crawler.municibidRecovery = recovery;
  crawler.municibidLease = lease;
  return crawler;
}

export { classifyHttpStatus, targetedInitialRequests as makeInitialRequests, parseAuctionIdentity };