/**
 * Liquidation acquisition crawler V1.1 Fortune-500 final-gate hardened.
 * Strict PropertyRoom framework alignment with Liquidation-specific
 * exhaustive discovery, durable recovery, request DLQ, and coverage reconciliation.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { Actor } from 'apify';
import { CheerioCrawler } from 'crawlee';
import { normalizeRecord, validateRecord, addSupabaseAliases } from '../utils/normalize.js';
import { incrementStat } from '../utils/logging.js';
import { emptyGlobalCategoryFallback } from '../liquidation/discovery.js';
import {
  buildKeywordUrl,
  canonicalizeLiquidationUrl,
  exhaustiveSeedRequests,
  isDetailUrl,
  looksLikeErrorPage,
  parseAuctionIdentity,
  parseDetailPage,
  parseManifestHtml,
  parseSearchPage,
  publicSearchUrl,
} from '../liquidation/index.js';
import { evaluateRunHealth } from '../liquidation/health.js';
import { updateCompleteness } from '../liquidation/completeness.js';
import { stripVolatileObservationFields } from '../liquidation/fingerprint.js';
import { LiquidationRecoveryState } from '../liquidation/recovery.js';
import { SourceCircuitBreaker } from '../liquidation/circuitBreaker.js';
import { LiquidationRunLease } from '../liquidation/lease.js';
import { applyIndexObservations, applyIntakeFields, applyNoBidPolicy, isNoBidLot, isClosedLot, normalizeNoBidPolicy, reapplyAfterAliases, validationShim } from '../liquidation/fieldRules.js';

const DEFAULT_SEARCH = publicSearchUrl();
const ALLOWED_LIQUIDATION_HOST = /(^|\.)liquidation\.com$/i;

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

export function assertLiquidationUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (!/^https?:$/.test(url.protocol) || !ALLOWED_LIQUIDATION_HOST.test(url.hostname)) {
    throw new Error(`Liquidation start URL is outside approved host boundary: ${rawUrl}`);
  }
  return url.toString();
}

function targetedInitialRequests(startUrls, keywords) {
  const urls = [];
  for (const raw of startUrls || []) {
    const candidate = typeof raw === 'string' ? raw : raw?.url;
    if (!candidate) continue;
    assertLiquidationUrl(candidate);
    const url = canonicalizeLiquidationUrl(candidate);
    assertLiquidationUrl(url);
    urls.push({
      url,
      uniqueKey: `seed:${url}`,
      userData: { type: isDetailUrl(url) ? 'detail' : 'index', depth: 1, partition: 'operator_seed' },
    });
  }
  for (const kw of keywords || []) {
    const url = buildKeywordUrl(kw);
    assertLiquidationUrl(url);
    urls.push({ url, uniqueKey: `keyword:${String(kw).toLowerCase()}`, userData: { type: 'index', depth: 1, keyword: kw, partition: `keyword:${String(kw).toLowerCase()}` } });
  }
  if (!urls.length) urls.push({ url: DEFAULT_SEARCH, uniqueKey: 'default-search', userData: { type: 'index', depth: 1, partition: 'global_active' } });
  return urls;
}

function exhaustiveInitialRequests(startUrls, keywords, includeCompleted = false) {
  const map = new Map();
  for (const seed of exhaustiveSeedRequests({ includeCompleted })) {
    const url = canonicalizeLiquidationUrl(seed.url);
    map.set(url, { url, uniqueKey: `exhaustive:${seed.partition}:${url}`, userData: { type: 'index', depth: 1, partition: seed.partition } });
  }
  for (const req of targetedInitialRequests(startUrls, keywords)) map.set(req.url, req);
  return [...map.values()];
}

/** @param {object} opts */
export function createLiquidationCrawler(opts) {
  const {
    startUrls = [], keywords = [], recheckLots = [], discoveryMode = 'EXHAUSTIVE', includeSellerPartitions = true, includeCategoryPartitions = true, includeCompleted = false, includeManifestItems = false, recordPages = false, noBidPricePolicy = 'NULL',
    maxPages = 0, maxDiscoveryRequests = 0, maxDetailRequests = 0, maxRuntimeMinutes = 0,
    maxConcurrency = 8, requestTimeoutSecs = 45, maxRequestRetries = 3,
    proxyEnabled = false, proxyGroups = [], proxyFallbackToDirect = false, debug = false,
    dataset, dedupeManager, webhookManager, seenExternalIds, stateKvStore,
    runContext = {}, sourceName = 'liquidation', maxItemsPerRun = 0,
    dedupeFlushInterval = 500, recoveryPersistInterval = 100,
    circuitBreaker403Threshold = 10, circuitBreaker5xxThreshold = 20, circuitBreaker429Threshold = 30,
    singleWriterLeaseEnabled = true, runLeaseTtlMinutes = 30, completedEvidenceRetainEntries = 1000,
    onProgress, log, zeroResultsAlertThreshold = Number(process.env.ZERO_RESULTS_ALERT_THRESHOLD || 1),
  } = opts;

  if (!stateKvStore) throw new Error('LIQUIDATION_RECOVERY_STORE_REQUIRED');
  const exhaustive = recheckLots.length === 0 && String(discoveryMode).toUpperCase() === 'EXHAUSTIVE';
  const startedMs = Date.now();
  const partitionSets = new Map();
  const discoveredThisRun = new Set();
  const visitedIndexUrls = new Set();
  let usedEmptyGlobalFallback = false;
  const recovery = new LiquidationRecoveryState(stateKvStore, { log, persistEvery: recoveryPersistInterval, completedEvidenceRetainEntries });
  const lease = new LiquidationRunLease(stateKvStore, {
    runId: runContext.actorRunId || `local-${process.pid}`,
    ttlMs: Math.max(1, Number(runLeaseTtlMinutes) || 30) * 60 * 1000,
    enabled: singleWriterLeaseEnabled,
    log,
    openLockQueue: async () => Actor.openRequestQueue('liquidation-active-run-lock-v3'),
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

  const fixtureCounts = {};
  const fixtureLog = [];
  const noBidPolicy = normalizeNoBidPolicy(noBidPricePolicy);
  const stats = {
    transport: 'liquidation_html', discovery_mode: exhaustive ? 'EXHAUSTIVE' : 'TARGETED',
    requests_total: 0, requests_attempted: 0, requests_success: 0, requests_success_first_attempt: 0,
    requests_success_after_retry: 0, requests_failed: 0, requests_permanently_failed: 0, retry_attempts: 0,
    html_requests: 0, pages_processed: 0, index_pages_processed: 0, detail_pages_attempted: 0,
    detail_pages_parsed: 0, detail_parse_failures: 0, manifest_requests: 0, manifest_pages_parsed: 0, manifest_items_saved: 0, manifest_failures: 0, normalization_failures: 0, validation_failures: 0,
    records_discovered: 0, records_discovered_unique: 0, records_queued: 0, records_processed: 0,
    records_saved: 0, records_rejected: 0, duplicates_skipped: 0, zero_result_pages: 0,
    rate_limit_events: 0, access_denied_events: 0, auth_required_events: 0, schema_drift_events: 0, filtered_records: 0,
    http_401: 0, http_403: 0, http_404: 0, http_408: 0, http_429: 0, http_5xx: 0,
    discovery_requests: 0, detail_requests: 0, records_normalized: 0, records_validated: 0,
    capacity_skipped: 0, capacity_truncated: false, runtime_truncated: false, terminal_removed: 0, dlq_replayed: 0, checkpoint_resumed: false,
    discovery_partitions: {}, circuit_open_reason: null, lease_lost: false, lease_error: null,
    extraction_completeness_total: 0,
    extraction_completeness: { external_id: 0, title: 0, listing_url: 0, current_price: 0, price_type: 0, estimated_shipping: 0, shipping_method: 0, auction_start_time_source: 0, auction_end_time: 0, location: 0, seller_name: 0, condition: 0 },
    normalized_completeness_total: 0,
    normalized_completeness: { external_id: 0, title: 0, listing_url: 0, current_price: 0, price_type: 0, estimated_shipping: 0, shipping_method: 0, auction_start_time_source: 0, auction_end_time: 0, location: 0, seller_name: 0, condition: 0 },
    extraction_completeness_applicable: { external_id: 0, title: 0, listing_url: 0, current_price: 0, price_type: 0, estimated_shipping: 0, shipping_method: 0, auction_start_time_source: 0, auction_end_time: 0, location: 0, seller_name: 0, condition: 0 },
    normalized_completeness_applicable: { external_id: 0, title: 0, listing_url: 0, current_price: 0, price_type: 0, estimated_shipping: 0, shipping_method: 0, auction_start_time_source: 0, auction_end_time: 0, location: 0, seller_name: 0, condition: 0 },
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
    fatalCircuitError = new Error(`LIQUIDATION_CIRCUIT_OPEN:${reason}`);
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
      if (requestType === 'detail') stats.detail_requests += 1; else if (requestType === 'manifest') stats.manifest_requests += 1; else stats.discovery_requests += 1;
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
        throw new Error(`Liquidation NOT_FOUND for ${request.url}`);
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
        throw new Error(`Liquidation ${statusClass} for ${request.url}`);
      }

      if (status === 429 || status >= 500 || status === 408) {
        const reason = breaker.note(status);
        if (reason) {
          triggerCircuitAbort(reason);
          request.noRetry = true;
          throw new Error(`LIQUIDATION_CIRCUIT_OPEN:${reason}`);
        }
        await sleep(retryDelayMs(status, request.retryCount || 0, response));
        throw new Error(`Liquidation ${statusClass} for ${request.url}`);
      }

      const html = Buffer.isBuffer(body) ? body.toString('utf8') : String(body ?? '');
      if (!html.trim()) throw new Error(`Liquidation EMPTY_BODY for ${request.url}`);
      if (recordPages) {
        const kind = request.userData?.type === 'detail' || isDetailUrl(request.url) ? 'detail' : (request.userData?.type === 'manifest' ? 'manifest' : 'index');
        const limit = kind === 'detail' ? 3 : (kind === 'manifest' ? 1 : 2);
        fixtureCounts[kind] = (fixtureCounts[kind] || 0);
        if (fixtureCounts[kind] < limit) {
          fixtureCounts[kind] += 1;
          const key = `FIXTURE_html_${kind}_${fixtureCounts[kind]}`;
          try {
            await Actor.setValue(key, html, { contentType: 'text/html; charset=utf-8' });
            fixtureLog.push({ key, url: request.url, bytes: html.length });
            await Actor.setValue('FIXTURE_urls', fixtureLog);
          } catch (fixtureErr) { log.warning('Fixture recording failed', { key, error: fixtureErr.message }); }
        }
      }
      if (looksLikeErrorPage(html)) {
        stats.schema_drift_events += 1;
        throw new Error(`Liquidation ERROR_PAGE_DETECTED for ${request.url}`);
      }
      if (status >= 200 && status < 300) {
        stats.requests_success += 1;
        if ((request.retryCount || 0) > 0) stats.requests_success_after_retry += 1;
        else stats.requests_success_first_attempt += 1;
        breaker.note(status);
      }

      stats.pages_processed += 1;
      incrementStat('pagesVisited');

      if (type === 'manifest') {
        const parent = request.userData?.parent || {};
        const manifestItems = parseManifestHtml(html, request.url, parent);
        if (!manifestItems.length) {
          stats.manifest_failures += 1;
          throw new Error(`LIQUIDATION_MANIFEST_PARSE_EMPTY:${request.url}`);
        }
        stats.manifest_pages_parsed += 1;
        for (const item of manifestItems) {
          const lineKey = item.sku || item.upc || `line-${item.line_no}`;
          const externalId = `liquidation-${item.auction_id || parent.auction_id}-manifest-${String(lineKey).replace(/[^a-zA-Z0-9._-]+/g,'-')}-${item.line_no}`;
          const rawManifest = {
            source: 'liquidation', source_type: 'wholesale_liquidation_manifest', record_type: 'manifest_item', external_id: externalId,
            listing_url: item.manifest_url || parent.manifest_url || parent.listing_url || '',
            title: item.description || item.sku || item.upc || `Manifest line ${item.line_no}`,
            category: parent.category || null, condition: parent.condition || 'UNKNOWN', description: item.description || '', current_price: null,
            currency: item.retail_currency || parent.currency || 'UNKNOWN', auction_end_time: parent.auction_end_time || null, location: parent.location || '',
            scraped_at: new Date().toISOString(), observed_at: new Date().toISOString(),
            source_meta: {
              parent_external_id: item.parent_external_id || parent.external_id || null, auction_id: item.auction_id || parent.auction_id || null, manifest_line_no: item.line_no,
              sku: item.sku, upc: item.upc, quantity: item.quantity, retail_price: item.retail_price, retail_currency: item.retail_currency, manifest_notes: item.notes, manifest_url: item.manifest_url, raw_manifest_fields: item.raw,
            },
            attributes: { trusted: { sku: item.sku, upc: item.upc, quantity: item.quantity, retail_price: item.retail_price, retail_currency: item.retail_currency, notes: item.notes } },
            record_lineage: { actor_run_id: runContext.actorRunId ?? '', actor_build_id: runContext.actorBuildId ?? '', actor_task_id: runContext.actorTaskId ?? '', input_fingerprint: runContext.inputFingerprint ?? '' },
          };
          const manifestRecord = normalizeRecord(rawManifest, sourceName);
          const validation = validateRecord(manifestRecord);
          if (!validation.valid) { stats.manifest_failures += 1; throw new Error(`LIQUIDATION_MANIFEST_VALIDATION_FAILED:${validation.errors.join('|')}`); }
          Object.assign(manifestRecord, { auction_id: rawManifest.source_meta.auction_id, parent_external_id: rawManifest.source_meta.parent_external_id, manifest_line_no: item.line_no, sku: item.sku, upc: item.upc, quantity: item.quantity, retail_price: item.retail_price, retail_currency: item.retail_currency, manifest_notes: item.notes });
          const shouldIngest = await dedupeManager.shouldProcess(manifestRecord.external_id, manifestRecord.content_hash);
          if (!shouldIngest) continue;
          try { await lease.assertOwned(); } catch (err) { triggerFatalLease(err); throw err; }
          await dataset.pushData(manifestRecord);
          if (webhookManager) await webhookManager.add(manifestRecord);
          try { await lease.assertOwned(); } catch (err) { triggerFatalLease(err); throw err; }
          await dedupeManager.markSeenWithFingerprint(manifestRecord.external_id, manifestRecord.content_hash, { price: null });
          stats.manifest_items_saved += 1;
        }
        await recovery.completeManifest(request.userData?.manifestKey || request.url);
        await recovery.resolveFailure(request.url, request.userData?.externalId || null);
        return;
      }

      if (type === 'index') {
        stats.index_pages_processed += 1;
        const parsed = parseSearchPage(html, request.url, { includeSellerPartitions, includeCategoryPartitions, includeCompleted });
        const depth = request.userData?.depth ?? 1;
        const partition = request.userData?.partition || 'index';
        if (parsed.items.length === 0) {
          stats.zero_result_pages += 1;
          log.warning('Liquidation search page returned zero asset links', { url: request.url, depth, partition, explicitEmpty: parsed.explicitEmpty, resultCount: parsed.resultCount });
          if (!parsed.explicitEmpty && parsed.pagination.length === 0 && (parsed.discoveryLinks || []).length === 0 && stats.zero_result_pages >= zeroResultsAlertThreshold) stats.schema_drift_events += 1;
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
        if (!exhaustive && !usedEmptyGlobalFallback && parsed.items.length === 0) {
          const fallback = emptyGlobalCategoryFallback(parsed, request.url, request.userData?.keyword);
          if (fallback.length) {
            usedEmptyGlobalFallback = true;
            nextLinks.push(...fallback);
            log.info('Empty global search: following observed category routes', { url: request.url, categoryUrls: fallback });
          }
        }
        if (exhaustive) nextLinks.push(...(parsed.discoveryLinks || []).map((x) => x.url));
        const discoveryMeta = new Map((parsed.discoveryLinks || []).map((x) => [canonicalizeLiquidationUrl(x.url), x]));
        for (const next of nextLinks) {
          if (!next) continue;
          const normalized = canonicalizeLiquidationUrl(next);
          assertLiquidationUrl(normalized);
          if (visitedIndexUrls.has(normalized)) continue;
          if (maxDiscoveryRequests > 0 && discoveryRequestsQueued >= maxDiscoveryRequests) {
            stats.capacity_skipped += 1;
            stats.capacity_truncated = true;
            await recovery.queueIndex(normalized, { partition: discoveryMeta.get(normalized)?.partition || partition, depth: depth + 1 });
            continue;
          }
          if (maxPages > 0 && depth >= maxPages && /[?&]_page=\d+/i.test(normalized)) {
            stats.capacity_skipped += 1;
            stats.capacity_truncated = true;
            await recovery.queueIndex(normalized, { partition: discoveryMeta.get(normalized)?.partition || partition, depth: depth + 1, truncation_reason: 'maxPages' });
            continue;
          }
          visitedIndexUrls.add(normalized);
          const meta = discoveryMeta.get(normalized);
          const childPartition = meta?.partition || (/[?&]_page=/i.test(normalized) ? partition : `linked:${partition}`);
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
        if (raw.current_price == null && indexObs.currentPrice != null) raw.current_price = indexObs.currentPrice;
        if (!raw.auction_end_time && indexObs.auctionEndTime) raw.auction_end_time = indexObs.auctionEndTime;
        if (!raw.location && indexObs.location) raw.location = indexObs.location;
        if (!raw.lot_number && indexObs.lotNumber) raw.lot_number = indexObs.lotNumber;
        if (indexObs.eventId) raw.source_meta.event_id = indexObs.eventId;
        applyIndexObservations(raw, indexObs);
        applyNoBidPolicy(raw, noBidPolicy);
        raw.source_meta.discovery_partition = request.userData?.partition || null;
        stripVolatileObservationFields(raw);
        stats.detail_pages_parsed += 1;
        if (!includeCompleted && isClosedLot(raw, observedAt)) {
          stats.filtered_records += 1;
          await recovery.disposition(raw.external_id, 'FILTERED_GOVERNED', { reason: 'closed_auction', url: request.url });
          await recovery.resolveFailure(request.url, raw.external_id);
          log.info('Skipping closed Liquidation lot', { id: raw.external_id, end: raw.auction_end_time });
          return;
        }
        updateCompleteness(stats, raw, 'extraction');
      } catch (err) {
        stats.detail_parse_failures += 1;
        incrementStat('errors');
        log.warning('Liquidation detail extraction failed; allowing governed Crawlee retry', {
          url: request.url,
          retryCount: request.retryCount || 0,
          error: err.message,
        });
        // Do not commit a terminal disposition or source-DLQ record here. Throwing
        // lets Crawlee perform the configured automatic retries. The permanent
        // failedRequestHandler records RETRY_PENDING only after retry exhaustion.
        throw err;
      }

      if (raw.current_price == null && !['SEALED_BID'].includes(raw.listing_type)) {
        stats.records_rejected += 1;
        await recovery.disposition(raw.external_id, 'VALIDATION_FAILED', { phase: 'source_validation', reason: 'current_price_unavailable', url: request.url });
        log.warning('Liquidation record rejected: current price unavailable', { id: raw.external_id, url: request.url, listing_type: raw.listing_type });
        return;
      }
      if (!raw.auction_end_time) raw.normalization_status = 'valid_with_warnings';

      let record;
      try {
        record = normalizeRecord({
          ...raw,
          record_lineage: {
            source: 'liquidation', transport: 'liquidation_html',
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
        log.error('Liquidation normalization failed', { url: request.url, error: err.message });
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
        minimum_bid: raw.minimum_bid ?? null, bid_increment: raw.bid_increment ?? null, bid_count: raw.bid_count ?? null,
        quantity: raw.quantity ?? null, unit_count: raw.unit_count ?? null, price_status: raw.price_status ?? null,
        available_purchase_modes: raw.available_purchase_modes ?? [],
        reserve_status: raw.reserve_status ?? null, reserve_met: raw.reserve_met ?? null,
        buyers_premium_pct: raw.buyers_premium_pct ?? null, buyers_premium_source: raw.buyers_premium_source ?? null,
        buyers_premium_confidence: raw.buyers_premium_confidence ?? null, shipping_available: raw.shipping_available ?? null,
        pickup_required: raw.pickup_required ?? null, pickup_location: raw.pickup_location ?? null,
        seller_name: raw.seller_name ?? null, seller_agency: raw.seller_agency ?? null, seller_type: raw.seller_type ?? null,
        auction_start_time: raw.auction_start_time ?? null, auction_extension_possible: raw.auction_extension_possible ?? null,
        bid_deposit: raw.bid_deposit ?? null, auction_status: raw.auction_status ?? 'UNKNOWN',
        time_remaining_seconds: raw.time_remaining_seconds ?? null, inspection_available: raw.inspection_available ?? null,
        inspection_details: raw.inspection_details ?? null, payment_terms: raw.payment_terms ?? null,
        removal_requirements: raw.removal_requirements ?? null, documents: raw.documents ?? [],
        bidding_allowed: raw.bidding_allowed ?? null, bidding_eligibility: raw.bidding_eligibility ?? 'UNKNOWN',
        bidding_restriction_message: raw.bidding_restriction_message ?? null, requires_account_review: raw.requires_account_review ?? false,
      });

      applyIntakeFields(record, raw);
      stats.records_normalized += 1;
      const validation = validateRecord(validationShim(record));
      if (!validation.valid) {
        stats.validation_failures += 1;
        stats.records_rejected += 1;
        await recovery.disposition(record.external_id, 'VALIDATION_FAILED', { phase: 'unified_schema', errors: validation.errors, url: request.url });
        log.error('Liquidation unified schema validation failed', { id: record.external_id, errors: validation.errors });
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
      reapplyAfterAliases(record, raw);
      try { await lease.assertOwned(); } catch (err) { triggerFatalLease(err); throw err; }
      await dataset.pushData(record);
      savedCount += 1;
      stats.records_saved += 1;
      incrementStat('itemsSaved');
      if (webhookManager) await webhookManager.add(record);

      try { await lease.assertOwned(); } catch (err) { triggerFatalLease(err); throw err; }
      await dedupeManager.markSeenWithFingerprint(record.external_id, record.content_hash, { price: record.current_price });
      await recovery.disposition(record.external_id, knownBefore ? 'SAVED_CHANGED' : 'SAVED_NEW', { url: request.url, content_hash: record.content_hash });
      if (includeManifestItems && raw.source_meta?.manifest_html_url) {
        const manifestUrl = raw.source_meta.manifest_html_url;
        const manifestKey = `${record.external_id}:${manifestUrl}`;
        const parent = { external_id: record.external_id, auction_id: raw.auction_id, listing_url: record.listing_url, manifest_url: manifestUrl, currency: record.currency, condition: record.condition, category: record.category, location: record.location, auction_end_time: record.auction_end_time };
        await recovery.queueManifest(manifestKey, { url: manifestUrl, external_id: record.external_id, partition: 'manifest', parent });
        await crawler.addRequests([{
          url: manifestUrl, uniqueKey: `manifest:${manifestKey}`,
          userData: { type: 'manifest', externalId: record.external_id, manifestKey, partition: 'manifest', parent },
        }]);
      }
      await recovery.resolveFailure(request.url, record.external_id);

      if (onProgress && savedCount % Math.max(1, dedupeFlushInterval) === 0) await onProgress({ recordsSaved: savedCount });
      log.info('Saved Liquidation asset', { id: record.external_id, listingType: record.listing_type, price: record.current_price, end: record.auction_end_time, title: record.title.slice(0, 80) });
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
      log.error('Liquidation request failed after retries', { url: request.url, status, retries: request?.retryCount ?? 0, error: error?.message?.slice(0, 300) });
    },
  });

  const originalRun = crawler.run.bind(crawler);
  crawler.run = async function runLiquidation() {
    if (proxyEnabled) {
      try {
        const proxyConfig = await Actor.createProxyConfiguration({ groups: proxyGroups?.length ? proxyGroups : ['DATACENTER'], countryCode: 'US' });
        crawler.proxyConfiguration = proxyConfig;
      } catch (err) {
        if (!proxyFallbackToDirect) throw new Error(`LIQUIDATION_PROXY_CONFIGURATION_FAILED: ${err.message}`);
        log.warning('Liquidation proxy setup failed; explicit proxyFallbackToDirect=true permits direct transport', { error: err.message });
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
        log.error('Liquidation recovery/lease persist failed; lease ownership is fatal', { error: err.message });
        if (/LEASE_LOST|ATOMIC_LOCK_LOST|LEASE_RACE|ATOMIC_LOCK_OWNERSHIP/.test(err.message)) triggerFatalLease(err);
        else throw err;
      }
    };
    Actor.on('aborting', persistRecovery);
    Actor.on('migrating', persistRecovery);
    Actor.on('persistState', persistRecovery);
    const leaseRenewTimer = singleWriterLeaseEnabled ? setInterval(() => {
      lease.renew().catch((err) => {
        log.error('Liquidation periodic lease renewal failed; aborting source crawl', { error: err.message });
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
      for (const item of recovery.pendingManifestRequests()) {
        initial.push({ url: item.url, uniqueKey: `resume:manifest:${item.key}`, userData: { type: 'manifest', externalId: item.external_id, manifestKey: item.key, parent: item.parent || {}, partition: item.partition || 'manifest_resume' } });
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
        const key = req.userData?.externalId ? `detail:${req.userData.externalId}` : `${req.userData?.type || 'index'}:${canonicalizeLiquidationUrl(req.url)}`;
        if (!unique.has(key) || req.userData?.partition === 'dlq_replay') unique.set(key, req);
      }
      initial = [...unique.values()];
    }

    if (!initial.length) initial = exhaustive ? exhaustiveInitialRequests(startUrls, keywords, includeCompleted) : targetedInitialRequests(startUrls, keywords);
    if (recheckLots.length) initial = targetedInitialRequests(recheckLots, []).map(req => ({ ...req, uniqueKey: `recheck:${runContext.actorRunId}:${req.url}`, userData: { ...req.userData, recheck: true } }));
    for (const req of initial) {
      assertLiquidationUrl(req.url);
      if (req.userData.type === 'index') {
        visitedIndexUrls.add(req.url);
        await recovery.queueIndex(req.url, { partition: req.userData.partition || 'seed', depth: req.userData.depth || 1 });
        discoveryRequestsQueued += 1;
      } else if (req.userData.type === 'manifest') {
        // Manifest requests are persisted separately from lot detail work.
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
      source: 'liquidation',
      run_id: runContext.actorRunId ?? null,
      actor_build_id: runContext.actorBuildId ?? null,
      release_version: runContext.releaseVersion ?? null,
      build_tag: runContext.buildTag ?? null,
      release_artifact_sha256: runContext.releaseArtifactSha256 ?? null,
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
      throw new Error(`LIQUIDATION_HEALTH_FAIL: ${health.reasons.join('; ')}`);
    }
    if (health.status === 'INCOMPLETE') {
      await recovery.persist(true);
      log.warning('Liquidation run incomplete and resumable', { reasons: health.incomplete_reasons });
      return stats;
    }
    if (health.status === 'DEGRADED') log.warning('Liquidation run health degraded', { warnings: health.warnings });
    await recovery.persist(true);
    return stats;
  };

  crawler.liquidationStats = stats;
  crawler.liquidationRecovery = recovery;
  crawler.liquidationLease = lease;
  return crawler;
}

export { classifyHttpStatus, targetedInitialRequests as makeInitialRequests, parseAuctionIdentity };