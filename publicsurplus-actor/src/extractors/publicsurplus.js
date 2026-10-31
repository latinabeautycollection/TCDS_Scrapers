/**
 * PublicSurplus acquisition crawler V1.1 Fortune-500 hardened.
 * Strict PropertyRoom framework alignment with Public Surplus-specific
 * exhaustive discovery, durable recovery, request DLQ, and coverage reconciliation.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { Actor } from 'apify';
import { hasEnded, isClosedLot, unavailableDisposition } from '../publicsurplus/lifecycle.js';
import { CheerioCrawler } from 'crawlee';
import { normalizeRecord, validateRecord, addSupabaseAliases } from '../utils/normalize.js';
import { incrementStat } from '../utils/logging.js';
import {
  buildKeywordUrl,
  canonicalizePublicSurplusUrl,
  exhaustiveSeedRequests,
  isDetailUrl,
  looksLikeErrorPage,
  parseAuctionIdentity,
  parseDetailPage,
  parseSearchPage,
  publicSearchUrl,
} from '../publicsurplus/index.js';
import { evaluateRunHealth } from '../publicsurplus/health.js';
import { stripVolatileObservationFields } from '../publicsurplus/fingerprint.js';
import { PublicSurplusRecoveryState } from '../publicsurplus/recovery.js';
import { SourceCircuitBreaker } from '../publicsurplus/circuitBreaker.js';
import { PublicSurplusRunLease } from '../publicsurplus/lease.js';
import { applyNoBidRules, redactContacts, cityStateZip, nullifyEmptyStrings, computeContentHash, validationShim } from '../publicsurplus/fieldRules.js';

import { archiveSource } from '../publicsurplus/sourceArchive.js';
import { buildRecheckBootstrapRequests, buildRecheckRequests } from '../publicsurplus/recheck.js';

export { buildRecheckBootstrapRequests, buildRecheckRequests };

const DEFAULT_SEARCH = publicSearchUrl();
const ALLOWED_PUBLICSURPLUS_HOST = /(^|\.)publicsurplus\.com$/i;

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

function statusFromError(error) {
  const match = String(error?.message || error || '').match(/received\s+(401|403|404|408|429|5\d\d)\s+status code/i);
  return match ? Number(match[1]) : null;
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
    // A published opening amount is required as current_price even before the first bid.
    const applicable = !(field === 'auction_end_time' && record.listing_type === 'FIXED_PRICE');
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

export function assertPublicSurplusUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (!/^https?:$/.test(url.protocol) || !ALLOWED_PUBLICSURPLUS_HOST.test(url.hostname)) {
    throw new Error(`PublicSurplus start URL is outside approved host boundary: ${rawUrl}`);
  }
  return url.toString();
}

function targetedInitialRequests(startUrls, keywords) {
  const urls = [];
  for (const raw of startUrls || []) {
    const candidate = typeof raw === 'string' ? raw : raw?.url;
    if (!candidate) continue;
    assertPublicSurplusUrl(candidate);
    const url = canonicalizePublicSurplusUrl(candidate);
    assertPublicSurplusUrl(url);
    urls.push({
      url,
      uniqueKey: `seed:${url}`,
      userData: { type: isDetailUrl(url) ? 'detail' : 'index', depth: 1, partition: 'operator_seed' },
    });
  }
  for (const kw of keywords || []) {
    const url = buildKeywordUrl(kw);
    assertPublicSurplusUrl(url);
    urls.push({ url, uniqueKey: `keyword:${String(kw).toLowerCase()}`, userData: { type: 'index', depth: 1, keyword: kw, partition: `keyword:${String(kw).toLowerCase()}` } });
  }
  if (!urls.length) urls.push({ url: DEFAULT_SEARCH, uniqueKey: 'default-search', userData: { type: 'index', depth: 1, partition: 'global_active' } });
  return urls;
}

function exhaustiveInitialRequests(startUrls, keywords) {
  const map = new Map();
  for (const seed of exhaustiveSeedRequests()) {
    const url = canonicalizePublicSurplusUrl(seed.url);
    map.set(url, { url, uniqueKey: `exhaustive:${seed.partition}:${url}`, userData: { type: 'index', depth: 1, partition: seed.partition } });
  }
  for (const req of targetedInitialRequests(startUrls, keywords)) map.set(req.url, req);
  return [...map.values()];
}

/** @param {object} opts */
export function createPublicSurplusCrawler(opts) {
  const {
    startUrls = [], keywords = [], recheckLots = [], discoveryMode = 'EXHAUSTIVE', includeAgencyPartitions = true,
    maxPages = 0, maxDiscoveryRequests = 0, maxDetailRequests = 0, maxRuntimeMinutes = 0,
    maxConcurrency = 8, requestTimeoutSecs = 45, maxRequestRetries = 3,
    proxyEnabled = false, proxyGroups = [], proxyFallbackToDirect = false, debug = false,
    dataset, dedupeManager, webhookManager, seenExternalIds, stateKvStore,
    runContext = {}, sourceName = 'publicsurplus', maxItemsPerRun = 0,
    dedupeFlushInterval = 500, recoveryPersistInterval = 100,
    circuitBreaker403Threshold = 10, circuitBreaker5xxThreshold = 20, circuitBreaker429Threshold = 30,
    singleWriterLeaseEnabled = true, runLeaseTtlMinutes = 30, completedEvidenceRetainEntries = 1000,
    onProgress, log, zeroResultsAlertThreshold = Number(process.env.ZERO_RESULTS_ALERT_THRESHOLD || 1),
    recordPages = false,
  } = opts;
  let recordedPages = 0;

  if (!stateKvStore) throw new Error('PUBLICSURPLUS_RECOVERY_STORE_REQUIRED');
  const exhaustive = recheckLots.length === 0 && String(discoveryMode).toUpperCase() === 'EXHAUSTIVE';
  const startedMs = Date.now();
  const partitionSets = new Map();
  const discoveredThisRun = new Set();
  const visitedIndexUrls = new Set();
  let lotStates = {};
  const endFor = (request, id) => request.userData?.indexObservation?.auctionEndTime || lotStates[id]?.auction_end_time || null;
  const markClosed = async (id, end, url) => {
    lotStates[id] = { auction_end_time: end, status: 'CLOSED' };
    await stateKvStore.setValue('PUBLICSURPLUS_LOT_STATES_V1', lotStates);
    await recovery.disposition(id, 'FILTERED_GOVERNED', { reason: 'closed_auction', status: 'CLOSED', end, url });
    await recovery.resolveFailure(url, id);
    stats.closed_skipped += 1;
    stats.filtered_records += 1;
    log.info('PublicSurplus closed lot excluded', { id, end, url });
  };
  const recovery = new PublicSurplusRecoveryState(stateKvStore, { log, persistEvery: recoveryPersistInterval, completedEvidenceRetainEntries });
  const lease = new PublicSurplusRunLease(stateKvStore, {
    runId: runContext.actorRunId || `local-${process.pid}`,
    ttlMs: Math.max(1, Number(runLeaseTtlMinutes) || 30) * 60 * 1000,
    enabled: singleWriterLeaseEnabled,
    log,
  });
  const breaker = new SourceCircuitBreaker({
    maxConsecutive403: circuitBreaker403Threshold,
    maxConsecutive5xx: circuitBreaker5xxThreshold,
    maxRateLimited: circuitBreaker429Threshold,
  });

  const stats = {
    transport: 'publicsurplus_html', discovery_mode: recheckLots.length ? 'RECHECK' : exhaustive ? 'EXHAUSTIVE' : 'TARGETED',
    requests_total: 0, requests_attempted: 0, requests_success: 0, requests_success_first_attempt: 0,
    requests_success_after_retry: 0, requests_failed: 0, requests_permanently_failed: 0, retry_attempts: 0,
    html_requests: 0, pages_processed: 0, index_pages_processed: 0, detail_pages_attempted: 0,
    detail_pages_parsed: 0, detail_parse_failures: 0, normalization_failures: 0, validation_failures: 0,
    records_discovered: 0, records_discovered_unique: 0, records_queued: 0, records_processed: 0,
    records_saved: 0, records_rejected: 0, duplicates_skipped: 0, zero_result_pages: 0,
    auction_start_not_published: 0, recheck_targets: Array.isArray(recheckLots) ? recheckLots.filter(Boolean).length : 0,
    rate_limit_events: 0, access_denied_events: 0, auth_required_events: 0, schema_drift_events: 0, filtered_records: 0,
    http_401: 0, http_403: 0, http_404: 0, http_408: 0, http_429: 0, http_5xx: 0,
    discovery_requests: 0, detail_requests: 0, session_bootstrap_requests: 0, records_normalized: 0, records_validated: 0,
    capacity_skipped: 0, capacity_truncated: false, runtime_truncated: false, terminal_removed: 0, dlq_replayed: 0, checkpoint_resumed: false,
    closed_skipped: 0, closed_detail_pages: 0, proxy_mode: 'DIRECT_HTTP',
    discovery_partitions: {}, circuit_open_reason: null,
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

  const runtimeCheck = () => {
    if (maxRuntimeMinutes > 0 && Date.now() - startedMs >= maxRuntimeMinutes * 60 * 1000) {
      stats.runtime_truncated = true;
      stats.capacity_truncated = true;
      crawler.autoscaledPool?.abort();
      return false;
    }
    breaker.assertClosed();
    return true;
  };

  const notePartition = (partition, externalId) => {
    const key = partition || 'unknown';
    if (!partitionSets.has(key)) partitionSets.set(key, new Set());
    partitionSets.get(key).add(externalId);
  };

  const crawler = new CheerioCrawler({
    useSessionPool: false,
    maxConcurrency: recheckLots.length ? 1 : Math.max(1, Math.min(maxConcurrency, 20)),
    requestHandlerTimeoutSecs: Math.max(15, Math.min(requestTimeoutSecs, 300)),
    maxRequestRetries,
    // Public pages are fetched directly. Never rotate sessions or retry login requirements.
    errorHandler: async ({ request }, error) => {
      const status = statusFromError(error);
      if ([401,403,404,410].includes(status)) {
        request.noRetry = true;
        log.warning('PublicSurplus access/unavailable response; not retrying', { url: request.url, status });
      }
    },
    preNavigationHooks: [({ request }) => {
      if (!runtimeCheck()) return;
      stats.requests_attempted += 1;
      stats.requests_total += 1;
      stats.html_requests += 1;
      if ((request.retryCount || 0) > 0) stats.retry_attempts += 1;
      const requestType = request.userData?.type ?? (isDetailUrl(request.url) ? 'detail' : 'index');
      if (requestType === 'detail') stats.detail_requests += 1;
      else if (requestType === 'bootstrap') stats.session_bootstrap_requests += 1;
      else stats.discovery_requests += 1;
      request.headers = {
        ...request.headers,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        ...(request.userData?.referer ? { Referer: request.userData.referer } : {}),
      };
    }],

    async requestHandler({ body, request, response }) {
      if (!runtimeCheck()) return;
      const status = response?.statusCode ?? 0;
      const statusClass = classifyHttpStatus(status);
      const type = request.userData?.type ?? (isDetailUrl(request.url) ? 'detail' : 'index');
      const identity = type === 'detail' ? parseAuctionIdentity(request.url) : null;
      const externalId = identity?.externalId || request.userData?.externalId || null;

      if (type === 'detail' && externalId && unavailableDisposition(status, endFor(request, externalId)) === 'CLOSED') {
        await markClosed(externalId, endFor(request, externalId), request.url);
        return;
      }
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

      if (status === 404 || status === 410) {
        if (type === 'detail' && externalId) {
          stats.terminal_removed += 1;
          await recovery.disposition(externalId, 'REMOVED_CONFIRMED', { url: request.url, status });
          await recovery.resolveFailure(request.url, externalId);
          return;
        }
        stats.requests_failed += 1;
        stats.requests_permanently_failed += 1;
        log.warning('PublicSurplus seed URL returned not found', { url: request.url, status });
        return;
      }

      if (status === 401 || status === 403) {
        stats.requests_failed += 1;
        stats.requests_permanently_failed += 1;
        const reason = breaker.note(status);
        if (reason) stats.circuit_open_reason = reason;
        if (type === 'detail' && externalId) {
          const disposition = status === 401 ? 'AUTH_REQUIRED' : 'ACCESS_RESTRICTED';
          await recovery.disposition(externalId, disposition, { url: request.url, status });
          await recovery.resolveFailure(request.url, externalId, disposition);
        }
        log.error('PublicSurplus request denied; not retrying an authorization response', { url: request.url, status, classification: statusClass });
        return;
      }

      if (status === 429 || status >= 500 || status === 408) {
        const reason = breaker.note(status);
        if (reason) {
          stats.circuit_open_reason = reason;
          request.noRetry = true;
          throw new Error(`PUBLICSURPLUS_CIRCUIT_OPEN:${reason}`);
        }
        await sleep(retryDelayMs(status, request.retryCount || 0, response));
        throw new Error(`PublicSurplus ${statusClass} for ${request.url}`);
      }

      if (type === 'bootstrap') {
        stats.pages_processed += 1;
        incrementStat('pagesVisited');
        log.info('Public Surplus recheck session bootstrap completed', { url: request.url, status });
        return;
      }

      const html = Buffer.isBuffer(body) ? body.toString('utf8') : String(body ?? '');
      if (recordPages && recordedPages < 4) {
        // Diagnostic: save real page HTML (no keys/headers) so fixtures can replace the synthetic ones.
        try {
          recordedPages += 1;
          const kind = isDetailUrl(request.url) ? 'detail' : 'index';
          const store = await Actor.openKeyValueStore();
          await store.setValue(`FIXTURE_html_${kind}_${recordedPages}`, html, { contentType: 'text/html; charset=utf-8' });
        } catch (err) { log.warning(`Could not record page HTML: ${err.message}`); }
      }
      if (!html.trim()) throw new Error(`PublicSurplus EMPTY_BODY for ${request.url}`);
      if (looksLikeErrorPage(html)) {
        stats.schema_drift_events += 1;
        throw new Error(`PublicSurplus ERROR_PAGE_DETECTED for ${request.url}`);
      }

      stats.pages_processed += 1;
      incrementStat('pagesVisited');

      if (type === 'index') {
        stats.index_pages_processed += 1;
        const parsed = parseSearchPage(html, request.url, { includeAgencyPartitions });
        const depth = request.userData?.depth ?? 1;
        const partition = request.userData?.partition || 'index';
        if (parsed.items.length === 0 && /\/browse\/search/i.test(new URL(request.url).pathname)) {
          stats.zero_result_pages += 1;
          log.warning('PublicSurplus search page returned zero asset links', { url: request.url, depth, partition });
          if (stats.zero_result_pages >= zeroResultsAlertThreshold) stats.schema_drift_events += 1;
        }

        stats.records_discovered += parsed.items.length;
        incrementStat('itemsFound', parsed.items.length);
        for (const item of parsed.items) {
          discoveredThisRun.add(item.externalId);
          notePartition(partition, item.externalId);
          if (seenExternalIds) seenExternalIds.add(item.externalId);
          await recovery.noteDiscovered(item.externalId, partition);

          const knownEnd = item.auctionEndTime || lotStates[item.externalId]?.auction_end_time;
          if (lotStates[item.externalId]?.status === 'CLOSED' || hasEnded(knownEnd)) { await markClosed(item.externalId, knownEnd, item.listingUrl); continue; }
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
        const discoveryMeta = new Map((parsed.discoveryLinks || []).map((x) => [canonicalizePublicSurplusUrl(x.url), x]));
        for (const next of nextLinks) {
          if (!next) continue;
          const normalized = canonicalizePublicSurplusUrl(next);
          assertPublicSurplusUrl(normalized);
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
        if (raw.auction_start_time_source === 'not_published_by_site') stats.auction_start_not_published += 1;
        const originalRecord = await archiveSource(await Actor.openKeyValueStore(), html, raw);
        raw.source_meta.original_record = originalRecord;
        raw.attributes.original_record = originalRecord;
        const indexObs = request.userData?.indexObservation || {};
        // Mandatory intake rule: a no-bid auction uses its published opening amount, never a shared search-card price.
        applyNoBidRules(raw);
        if (!raw.auction_end_time && indexObs.auctionEndTime) raw.auction_end_time = indexObs.auctionEndTime;
        if (!raw.location && indexObs.location) raw.location = indexObs.location;
        if (!raw.lot_number && indexObs.lotNumber) raw.lot_number = indexObs.lotNumber;
        if (indexObs.eventId) raw.source_meta.event_id = indexObs.eventId;
        // Photos: detail-page photos first; the search-card thumbnail only as a fallback.
        if ((!Array.isArray(raw.image_urls) || raw.image_urls.length === 0) && indexObs.imageUrl) raw.image_urls = [indexObs.imageUrl];
        stripVolatileObservationFields(raw);
        if (raw.auction_end_time) {
          lotStates[raw.external_id] = { auction_end_time: raw.auction_end_time, status: raw.auction_status };
          await stateKvStore.setValue('PUBLICSURPLUS_LOT_STATES_V1', lotStates);
        }
        if (isClosedLot(raw, observedAt)) {
          stats.closed_detail_pages += 1;
          await markClosed(raw.external_id, raw.auction_end_time, request.url);
          return;
        }
        stats.detail_pages_parsed += 1;
        updateCompleteness(stats, raw, 'extraction');
      } catch (err) {
        stats.detail_parse_failures += 1;
        incrementStat('errors');
        log.warning('PublicSurplus detail extraction failed; allowing governed Crawlee retry', {
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
        log.warning('PublicSurplus record rejected: current price unavailable', { id: raw.external_id, url: request.url });
        return;
      }
      if (!raw.auction_end_time) raw.normalization_status = 'valid_with_warnings';

      let record;
      try {
        record = normalizeRecord({
          ...raw,
          record_lineage: {
            source: 'publicsurplus', transport: 'publicsurplus_html',
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
        log.error('PublicSurplus normalization failed', { url: request.url, error: err.message });
        return;
      }

      if (raw.total_estimated_cost == null && (raw.buyers_premium == null || raw.estimated_shipping == null || raw.tax_estimate == null)) record.total_estimated_cost = null;
      Object.assign(record, {
        listing_type: raw.listing_type ?? 'UNKNOWN', asset_id: raw.asset_id ?? null,
        auction_id: raw.auction_id ?? raw.source_meta?.event_id ?? null, lot_number: raw.lot_number ?? null,
        canonical_url: raw.canonical_url ?? record.listing_url, raw_condition: raw.raw_condition ?? null,
        price_type: raw.price_type ?? null,
        serial_number: raw.serial_number ?? null, vin: raw.vin ?? null, buy_now_price: raw.buy_now_price ?? null, starting_price: raw.starting_price ?? null,
        minimum_bid: raw.minimum_bid ?? null, bid_increment: raw.bid_increment ?? null, bid_count: raw.bid_count ?? null,
        reserve_status: raw.reserve_status ?? null, reserve_met: raw.reserve_met ?? null,
        buyers_premium_pct: raw.buyers_premium_pct ?? null, buyers_premium_source: raw.buyers_premium_source ?? null,
        buyers_premium_confidence: raw.buyers_premium_confidence ?? null, shipping_available: raw.shipping_available ?? null,
        shipping_method: raw.shipping_method ?? null, estimated_shipping: raw.estimated_shipping ?? null,
        pickup_required: raw.pickup_required ?? null, pickup_location: raw.pickup_location ?? null,
        seller_name: raw.seller_name ?? null, seller_agency: raw.seller_agency ?? null, seller_type: raw.seller_type ?? null,
        auction_start_time: raw.auction_start_time ?? null, auction_extension_possible: raw.auction_extension_possible ?? null,
        auction_start_time_source: raw.auction_start_time_source ?? 'not_published_by_site',
        bid_deposit: raw.bid_deposit ?? null, auction_status: raw.auction_status ?? 'UNKNOWN',
        time_remaining_seconds: raw.time_remaining_seconds ?? null, inspection_available: raw.inspection_available ?? null,
        inspection_details: raw.inspection_details ?? null, payment_terms: raw.payment_terms ?? null,
        removal_requirements: raw.removal_requirements ?? null, documents: raw.documents ?? [],
        bidding_allowed: raw.bidding_allowed ?? null, bidding_eligibility: raw.bidding_eligibility ?? 'UNKNOWN',
        bidding_restriction_message: raw.bidding_restriction_message ?? null, requires_account_review: raw.requires_account_review ?? false,
      });

      // ── Intake-guide alignment ─────────────────────────────────────────────
      // Done here (not in the shared normalizer): premium as a percent,
      // line-break-preserving description, item location, no personal data, nulls not '', stable hash.
      record.current_price = raw.current_price ?? null;
      if ((!Array.isArray(record.image_urls) || record.image_urls.length === 0) && Array.isArray(raw.image_urls)) record.image_urls = raw.image_urls;
      record.primary_image_url = (Array.isArray(record.image_urls) && record.image_urls[0]) || null; // first photo in page order, not alphabetical
      record.buyers_premium = raw.buyers_premium_pct ?? null;
      record.description = redactContacts(raw.description) || null;
      for (const f of ['inspection_details', 'payment_terms', 'removal_requirements', 'special_instructions']) {
        if (record[f] != null) record[f] = redactContacts(record[f]) || null;
      }
      // Item location "City, ST ZIP"; fall back to the card's 2-letter state when the pick-up block is cut off.
      const idxObs = request.userData?.indexObservation || {};
      record.location = cityStateZip(raw.pickup_location) || cityStateZip(raw.location) || cityStateZip(record.location)
        || (/^[A-Z]{2}$/.test(String(idxObs.location || '')) ? idxObs.location : null) || (/^[A-Z]{2}$/.test(String(raw.location || '')) ? raw.location : null);
      record.attributes = {
        ...(record.attributes && typeof record.attributes === 'object' ? record.attributes : {}),
        price_type: raw.price_type ?? null,
        auction_start_time_source: raw.auction_start_time_source ?? 'not_published_by_site',
        bid_count: raw.bid_count ?? null, bid_increment: raw.bid_increment ?? null, minimum_bid: raw.minimum_bid ?? null,
        buyers_premium_source: raw.buyers_premium_source ? 'publicsurplus_auction_page' : null,
        seller: raw.seller_name ?? null, lot_number: raw.lot_number ?? null, listing_type: raw.listing_type ?? null,
        reserve_status: raw.reserve_status ?? null, pickup_location: raw.pickup_location ?? null,
        payment_terms: record.payment_terms ?? null, removal_requirements: record.removal_requirements ?? null,
        inspection_details: record.inspection_details ?? null,
      };
      // Keep the provenance visible as a first-class dataset column as well as
      // inside attributes, where the intake contract originally placed it.
      record.auction_start_time_source = record.attributes.auction_start_time_source;
      record.brand = raw.brand ?? null;
      record.model = raw.model ?? null;
      record.mpn = raw.mpn ?? null;
      nullifyEmptyStrings(record);
      record.content_hash = computeContentHash(record);

      stats.records_normalized += 1;
      // Validate the published opening price for no-bid auctions just like a current bid.
      const validation = validateRecord(validationShim(record));
      if (!validation.valid) {
        stats.validation_failures += 1;
        stats.records_rejected += 1;
        await recovery.disposition(record.external_id, 'VALIDATION_FAILED', { phase: 'unified_schema', errors: validation.errors, url: request.url });
        log.error('PublicSurplus unified schema validation failed', { id: record.external_id, errors: validation.errors });
        return;
      }

      stats.records_processed += 1;
      stats.records_validated += 1;
      updateCompleteness(stats, record, 'normalized');
      const knownBefore = dedupeManager.isDuplicate(record.external_id);
      const isRecheck = request.userData?.recheck === true;
      const shouldIngest = isRecheck || await dedupeManager.shouldProcess(record.external_id, record.content_hash);
      if (!shouldIngest) {
        stats.duplicates_skipped += 1;
        incrementStat('itemsSkipped');
        await recovery.disposition(record.external_id, 'SKIPPED_UNCHANGED', { url: request.url });
        await recovery.resolveFailure(request.url, record.external_id);
        return;
      }

      if (!isRecheck && maxItemsPerRun > 0 && savedCount >= maxItemsPerRun) {
        stats.capacity_skipped += 1;
        stats.capacity_truncated = true;
        await recovery.queueDetail(record.external_id, { url: request.url, indexObservation: request.userData?.indexObservation || {}, partition: request.userData?.partition || 'detail' });
        crawler.autoscaledPool?.abort();
        return;
      }

      addSupabaseAliases(record);
      // addSupabaseAliases (legacy PropertyRoom aliases) re-introduces '' values, a category slug and a dollar "fees" alias.
      // Align with the intake guide again: site's own category (null until the parser captures it), premium is a percent.
      record.attributes = { ...(record.attributes || {}), category_key: record.source_category_key ?? null };
      record.category = record.raw_category || null;
      record.brand = raw.brand ?? null;
      record.model = raw.model ?? null;
      record.mpn = raw.mpn ?? null;
      record.inbound_fees_usd = null;
      nullifyEmptyStrings(record);
      await dataset.pushData(record);
      savedCount += 1;
      stats.records_saved += 1;
      incrementStat('itemsSaved');
      if (webhookManager) await webhookManager.add(record);

      await dedupeManager.markSeenWithFingerprint(record.external_id, record.content_hash, { price: record.current_price });
      await recovery.disposition(record.external_id, knownBefore ? 'SAVED_CHANGED' : 'SAVED_NEW', { url: request.url, content_hash: record.content_hash });
      await recovery.resolveFailure(request.url, record.external_id);

      if (onProgress && savedCount % Math.max(1, dedupeFlushInterval) === 0) await onProgress({ recordsSaved: savedCount });
      log.info('Saved PublicSurplus asset', { id: record.external_id, listingType: record.listing_type, price: record.current_price, end: record.auction_end_time, title: record.title.slice(0, 80) });
    },

    async failedRequestHandler({ request, error, response }) {
      const status = response?.statusCode ?? statusFromError(error);
      const type = request.userData?.type ?? (isDetailUrl(request.url) ? 'detail' : 'index');
      const identity = type === 'detail' ? parseAuctionIdentity(request.url) : null;
      const externalId = identity?.externalId || request.userData?.externalId || null;
      if (type === 'detail' && externalId && unavailableDisposition(status, endFor(request, externalId)) === 'CLOSED') {
        await markClosed(externalId, endFor(request, externalId), request.url);
        return;
      }
      stats.requests_failed += 1;
      stats.requests_permanently_failed += 1;

      if (status === 401) { stats.http_401 += 1; stats.auth_required_events += 1; }
      if (status === 403) { stats.http_403 += 1; stats.access_denied_events += 1; }
      if (status === 404) stats.http_404 += 1;
      if (status === 408) stats.http_408 += 1;
      if (status === 429) { stats.http_429 += 1; stats.rate_limit_events += 1; }
      if (status >= 500) stats.http_5xx += 1;
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
      log.error('PublicSurplus request failed after retries', { url: request.url, status, retries: request?.retryCount ?? 0, error: error?.message?.slice(0, 300) });
    },
  });

  const originalRun = crawler.run.bind(crawler);
  crawler.run = async function runPublicSurplus() {
    if (proxyEnabled || proxyGroups?.length) {
      log.warning('PublicSurplus uses direct HTTP; proxy settings are ignored by source policy', { requestedProxyGroups: proxyGroups });
    }
    log.info('PublicSurplus transport policy', { proxyEnabled: false, transport: 'DIRECT_HTTP' });
    await lease.acquire();
    lotStates = await stateKvStore.getValue('PUBLICSURPLUS_LOT_STATES_V1') || {};
    if (typeof lotStates !== 'object' || Array.isArray(lotStates)) { await lease.release(); throw new Error('PUBLICSURPLUS_LOT_STATE_CORRUPT'); }
    let init;
    try {
      init = await recovery.initialize(runContext.inputFingerprint || 'no-input-fingerprint');
    } catch (err) {
      await lease.release();
      throw err;
    }
    stats.checkpoint_resumed = init.resume;
    const persistRecovery = async () => {
      try { await recovery.persist(true); await lease.renew(); } catch (err) { log.warning('PublicSurplus recovery/lease persist failed', { error: err.message }); }
    };
    Actor.on('aborting', persistRecovery);
    Actor.on('migrating', persistRecovery);
    Actor.on('persistState', persistRecovery);

    let initial = recheckLots.length
      ? [
        ...buildRecheckRequests(recheckLots, runContext.actorRunId || 'manual'),
      ]
      : [];
    if (!recheckLots.length && init.resume) {
      for (const item of recovery.pendingIndexRequests()) {
        initial.push({ url: item.url, uniqueKey: `resume:index:${item.url}`, userData: { type: 'index', depth: item.depth || 1, partition: item.partition || 'resume' } });
      }
      for (const item of recovery.pendingDetailRequests()) {
        initial.push({ url: item.url, uniqueKey: `resume:detail:${item.external_id}`, userData: { type: 'detail', externalId: item.external_id, indexObservation: item.indexObservation || {}, partition: item.partition || 'resume' } });
      }
    }

    for (const item of recheckLots.length ? [] : recovery.replayRequests()) {
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
        const key = req.userData?.externalId ? `detail:${req.userData.externalId}` : `${req.userData?.type || 'index'}:${canonicalizePublicSurplusUrl(req.url)}`;
        if (!unique.has(key) || req.userData?.partition === 'dlq_replay') unique.set(key, req);
      }
      initial = [...unique.values()];
    }

    if (!initial.length && !recheckLots.length) initial = exhaustive ? exhaustiveInitialRequests(startUrls, keywords) : targetedInitialRequests(startUrls, keywords);
    const openInitial = [];
    for (const req of initial) {
      const id = req.userData?.externalId || (isDetailUrl(req.url) ? parseAuctionIdentity(req.url)?.externalId : null);
      const knownEnd = id ? endFor(req, id) : null;
      if (id && (lotStates[id]?.status === 'CLOSED' || hasEnded(knownEnd))) { await markClosed(id, knownEnd, req.url); continue; }
      openInitial.push(req);
    }
    initial = openInitial;
    for (const req of initial) {
      assertPublicSurplusUrl(req.url);
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
    } catch (err) {
      await recovery.persist(true);
      await lease.release();
      throw err;
    }

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

    const completionManifest = {
      source: 'publicsurplus',
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
      started_at: new Date(startedMs).toISOString(),
      completed_at: new Date().toISOString(),
    };

    if (health.status === 'FAIL') {
      await recovery.markFailed({ manifest: completionManifest });
      await lease.release();
      throw new Error(`PUBLICSURPLUS_HEALTH_FAIL: ${health.reasons.join('; ')}`);
    }
    if (health.status === 'INCOMPLETE') {
      await recovery.persist(true);
      log.warning('PublicSurplus run incomplete and resumable', { reasons: health.incomplete_reasons });
      return stats;
    }
    if (health.status === 'DEGRADED') log.warning('PublicSurplus run health degraded', { warnings: health.warnings });
    await recovery.persist(true);
    return stats;
  };

  crawler.publicsurplusStats = stats;
  crawler.publicsurplusRecovery = recovery;
  crawler.publicsurplusLease = lease;
  return crawler;
}

export { classifyHttpStatus, targetedInitialRequests as makeInitialRequests, parseAuctionIdentity };