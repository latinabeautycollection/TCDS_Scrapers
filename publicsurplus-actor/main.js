/**
 * main.js
 *
 * Enterprise actor entrypoint for:
 * - Public Surplus crawl
 * - optional eBay enrichment
 * - optional webhook delivery
 * - governed exports
 */

import { Actor } from 'apify';

import { createPublicSurplusCrawler, assertPublicSurplusUrl } from './src/extractors/publicsurplus.js';
import { buildPublicSurplusInputFingerprint } from './src/publicsurplus/inputFingerprint.js';
import { fetchEbayListings } from './src/extractors/ebay.js';

import { WebhookManager } from './src/utils/webhook.js';
import { DedupeManager } from './src/utils/dedupe.js';
import {
  createLogger,
  getRunStats,
  initializeRunContext,
  resetRunStats,
} from './src/utils/logging.js';
import { exportDatasetToCSV, exportDatasetToGoogleSheets } from './src/utils/export.js';
import { exportDatasetToSql } from './src/utils/sqlExport.js';

const DEFAULTS = Object.freeze({
  startUrls: [],
  recheckLots: [],
  keywords: [],
  discoveryMode: 'EXHAUSTIVE',
  includeAgencyPartitions: true,
  maxPages: 0,
  maxDiscoveryRequests: 0,
  maxDetailRequests: 0,
  maxRuntimeMinutes: 0,
  maxConcurrency: 1,
  requestTimeoutSecs: 60,
  maxRequestRetries: 3,
  recoveryPersistInterval: 100,
  circuitBreaker403Threshold: 10,
  circuitBreaker5xxThreshold: 20,
  circuitBreaker429Threshold: 30,
  proxyEnabled: false,
  recordPages: false,
  proxyGroups: [],
  proxyFallbackToDirect: false,
  singleWriterLeaseEnabled: true,
  runLeaseTtlMinutes: 30,
  completedEvidenceRetainEntries: 1000,
  debug: false,

  webhookUrl: null,
  webhookAuthToken: null,
  webhookBatchSize: 10,
  webhookMaxRetries: 5,
  webhookTimeoutMs: 30_000,
  webhookReplayDeadLetterOnStart: false,
  webhookDeliveryRequired: process.env.WEBHOOK_DELIVERY_REQUIRED === 'true',

  ebayEnabled: false,
  ebayClientId: null,
  ebayClientSecret: null,
  ebayEnvironment: 'production',
  ebayQueries: [],
  ebayCategoryIds: [],
  ebayMaxResults: 1000,
  ebayIncludeSoldComps: false,

  csvExportEnabled: false, // ./output is ephemeral on Apify; read the dataset instead
  csvExportProfile: 'overview',
  csvOutputDir: './output',
  csvFileName: 'publicsurplus_export.csv',

  googleSheetId: null,
  googleSheetName: 'Sheet1',
  googleSheetsExportProfile: 'overview',
  googleServiceAccountKey: null,

  sqlExportEnabled: false,
  sqlExportProfile: 'overview',
  sqlWrapInTransaction: true,
  sqlOutputDir: './output',
  sqlFileName: 'publicsurplus_ingest.sql',

  dedupePersistInterval: 500,
  enableFingerprintRefresh: true,
  enableStaleRefresh: true,
  staleAfterMinutes: 60,

  sourceName: 'publicsurplus',
  runLabel: null,
  maxItemsPerRun: 0,


});

function clampInt(value, fallback, min, max, { allowZero = false } = {}) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  if (allowZero && n === 0) return 0;
  if (n < min) return fallback;
  if (n > max) return max;
  return n;
}

function clampBool(value, fallback) {
  if (typeof value === 'boolean') return value;
  return fallback;
}

function safeString(value, fallback = null) {
  if (value == null) return fallback;
  const s = String(value).trim();
  return s || fallback;
}

function safeStringArray(value, fallback = []) {
  if (!Array.isArray(value)) return fallback;
  return value.map((v) => String(v).trim()).filter(Boolean);
}

function normalizeStartUrls(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (typeof entry === 'string') return entry.trim();
      if (entry && typeof entry === 'object' && entry.url) return String(entry.url).trim();
      return '';
    })
    .filter(Boolean);
}

async function getAllDatasetItems(dataset) {
  const all = [];
  let offset = 0;
  const limit = 1000;

  while (true) {
    const { items } = await dataset.getData({ offset, limit });
    if (!items || items.length === 0) break;
    all.push(...items);
    if (items.length < limit) break;
    offset += limit;
  }

  return all;
}

await Actor.main(async () => {
  resetRunStats();

  const rawInput = (await Actor.getInput()) ?? {};

  const input = {
    startUrls: normalizeStartUrls(rawInput.startUrls ?? DEFAULTS.startUrls),
    recheckLots: safeStringArray(rawInput.recheckLots, DEFAULTS.recheckLots),
    keywords: safeStringArray(rawInput.keywords, DEFAULTS.keywords),

    discoveryMode: String(rawInput.discoveryMode || DEFAULTS.discoveryMode).toUpperCase() === 'TARGETED' ? 'TARGETED' : 'EXHAUSTIVE',
    includeAgencyPartitions: clampBool(rawInput.includeAgencyPartitions, DEFAULTS.includeAgencyPartitions),
    maxPages: clampInt(rawInput.maxPages, DEFAULTS.maxPages, 1, 100000, { allowZero: true }),
    maxDiscoveryRequests: clampInt(rawInput.maxDiscoveryRequests, DEFAULTS.maxDiscoveryRequests, 1, 1000000, { allowZero: true }),
    maxDetailRequests: clampInt(rawInput.maxDetailRequests, DEFAULTS.maxDetailRequests, 1, 1000000, { allowZero: true }),
    maxRuntimeMinutes: clampInt(rawInput.maxRuntimeMinutes, DEFAULTS.maxRuntimeMinutes, 1, 10080, { allowZero: true }),
    maxConcurrency: clampInt(rawInput.maxConcurrency, DEFAULTS.maxConcurrency, 1, 20),
    requestTimeoutSecs: clampInt(rawInput.requestTimeoutSecs, DEFAULTS.requestTimeoutSecs, 15, 300),
    maxRequestRetries: clampInt(rawInput.maxRequestRetries, DEFAULTS.maxRequestRetries, 0, 10),
    recoveryPersistInterval: clampInt(rawInput.recoveryPersistInterval, DEFAULTS.recoveryPersistInterval, 1, 10000),
    circuitBreaker403Threshold: clampInt(rawInput.circuitBreaker403Threshold, DEFAULTS.circuitBreaker403Threshold, 1, 1000),
    circuitBreaker5xxThreshold: clampInt(rawInput.circuitBreaker5xxThreshold, DEFAULTS.circuitBreaker5xxThreshold, 1, 1000),
    circuitBreaker429Threshold: clampInt(rawInput.circuitBreaker429Threshold, DEFAULTS.circuitBreaker429Threshold, 1, 1000),

    proxyEnabled: clampBool(rawInput.proxyEnabled, DEFAULTS.proxyEnabled),
    recordPages: clampBool(rawInput.recordPages, DEFAULTS.recordPages),
    proxyGroups: safeStringArray(rawInput.proxyGroups, DEFAULTS.proxyGroups),
    proxyFallbackToDirect: clampBool(rawInput.proxyFallbackToDirect, DEFAULTS.proxyFallbackToDirect),
    singleWriterLeaseEnabled: clampBool(rawInput.singleWriterLeaseEnabled, DEFAULTS.singleWriterLeaseEnabled),
    runLeaseTtlMinutes: clampInt(rawInput.runLeaseTtlMinutes, DEFAULTS.runLeaseTtlMinutes, 1, 1440),
    completedEvidenceRetainEntries: clampInt(rawInput.completedEvidenceRetainEntries, DEFAULTS.completedEvidenceRetainEntries, 0, 100000, { allowZero: true }),
    debug: clampBool(rawInput.debug, DEFAULTS.debug),

    webhookUrl: safeString(rawInput.webhookUrl, DEFAULTS.webhookUrl),
    webhookAuthToken: safeString(rawInput.webhookAuthToken, DEFAULTS.webhookAuthToken),
    webhookBatchSize: clampInt(rawInput.webhookBatchSize, DEFAULTS.webhookBatchSize, 1, 500),
    webhookMaxRetries: clampInt(rawInput.webhookMaxRetries, DEFAULTS.webhookMaxRetries, 0, 20),
    webhookTimeoutMs: clampInt(rawInput.webhookTimeoutMs, DEFAULTS.webhookTimeoutMs, 1000, 120000),
    webhookReplayDeadLetterOnStart: clampBool(
      rawInput.webhookReplayDeadLetterOnStart,
      DEFAULTS.webhookReplayDeadLetterOnStart,
    ),
    webhookDeliveryRequired: clampBool(
      rawInput.webhookDeliveryRequired,
      DEFAULTS.webhookDeliveryRequired,
    ),

    ebayEnabled: clampBool(rawInput.ebayEnabled, DEFAULTS.ebayEnabled),
    ebayClientId: safeString(rawInput.ebayClientId, DEFAULTS.ebayClientId),
    ebayClientSecret: safeString(rawInput.ebayClientSecret, DEFAULTS.ebayClientSecret),
    ebayEnvironment:
      rawInput.ebayEnvironment === 'sandbox' ? 'sandbox' : DEFAULTS.ebayEnvironment,
    ebayQueries: safeStringArray(rawInput.ebayQueries, DEFAULTS.ebayQueries),
    ebayCategoryIds: safeStringArray(rawInput.ebayCategoryIds, DEFAULTS.ebayCategoryIds),
    ebayMaxResults: clampInt(rawInput.ebayMaxResults, DEFAULTS.ebayMaxResults, 1, 10000),
    ebayIncludeSoldComps: clampBool(
      rawInput.ebayIncludeSoldComps,
      DEFAULTS.ebayIncludeSoldComps,
    ),

    csvExportEnabled: clampBool(rawInput.csvExportEnabled, DEFAULTS.csvExportEnabled),
    csvExportProfile: safeString(rawInput.csvExportProfile, DEFAULTS.csvExportProfile),
    csvOutputDir: safeString(rawInput.csvOutputDir, DEFAULTS.csvOutputDir),
    csvFileName: safeString(rawInput.csvFileName, DEFAULTS.csvFileName),

    googleSheetId: safeString(rawInput.googleSheetId, DEFAULTS.googleSheetId),
    googleSheetName: safeString(rawInput.googleSheetName, DEFAULTS.googleSheetName),
    googleSheetsExportProfile: safeString(
      rawInput.googleSheetsExportProfile,
      DEFAULTS.googleSheetsExportProfile,
    ),
    // IMPORTANT: pass through raw, do not JSON.parse here
    googleServiceAccountKey:
      rawInput.googleServiceAccountKey ?? DEFAULTS.googleServiceAccountKey,

    sqlExportEnabled: clampBool(rawInput.sqlExportEnabled, DEFAULTS.sqlExportEnabled),
    sqlExportProfile: safeString(rawInput.sqlExportProfile, DEFAULTS.sqlExportProfile),
    sqlWrapInTransaction: clampBool(
      rawInput.sqlWrapInTransaction,
      DEFAULTS.sqlWrapInTransaction,
    ),
    sqlOutputDir: safeString(rawInput.sqlOutputDir, DEFAULTS.sqlOutputDir),
    sqlFileName: safeString(rawInput.sqlFileName, DEFAULTS.sqlFileName),

    dedupePersistInterval: clampInt(
      rawInput.dedupePersistInterval,
      DEFAULTS.dedupePersistInterval,
      1,
      10000,
    ),
    enableFingerprintRefresh: clampBool(
      rawInput.enableFingerprintRefresh,
      DEFAULTS.enableFingerprintRefresh,
    ),
    enableStaleRefresh: clampBool(
      rawInput.enableStaleRefresh,
      DEFAULTS.enableStaleRefresh,
    ),
    staleAfterMinutes: clampInt(
      rawInput.staleAfterMinutes,
      DEFAULTS.staleAfterMinutes,
      5,
      100800,
    ),

    sourceName: safeString(rawInput.sourceName, DEFAULTS.sourceName),
    runLabel: safeString(rawInput.runLabel, DEFAULTS.runLabel),
    maxItemsPerRun: clampInt(rawInput.maxItemsPerRun, DEFAULTS.maxItemsPerRun, 0, 50000, {
      allowZero: true,
    })
  };

  if (input.sourceName !== 'publicsurplus') {
    throw new Error(`Public Surplus actor requires sourceName=publicsurplus; received ${input.sourceName}`);
  }
  if (input.discoveryMode === 'TARGETED' && input.startUrls.length === 0 && input.keywords.length === 0 && input.recheckLots.length === 0) {
    throw new Error('PUBLICSURPLUS_TARGETED_REQUIRES_STARTURL_OR_KEYWORD');
  }
  for (const startUrl of input.startUrls) assertPublicSurplusUrl(startUrl);
  if (input.webhookDeliveryRequired && !input.webhookUrl) {
    throw new Error('WEBHOOK_DELIVERY_REQUIRED=true but webhookUrl is not configured');
  }

  const dataset = await Actor.openDataset();
  const kvStore = await Actor.openKeyValueStore();
  
  // State from dedupe and webhook dead-letter queue must persist across runs.
  // The default KV store is isolated per-run, so we must use a named store.
  const stateStoreName = input.sourceName ? `actor-state-${input.sourceName}` : 'actor-state-global';
  let stateKvStore;
  try {
    stateKvStore = await Actor.openKeyValueStore(stateStoreName);
  } catch (err) {
    throw new Error(
      `Could not open persistent dedupe KV store "${stateStoreName}". ` +
      `Refusing to fall back to the per-run default store because that would re-scrape known listings. ` +
      `Original error: ${err.message}`,
    );
  }

  const actorEnv = Actor.getEnv();
  const inputFingerprint = buildPublicSurplusInputFingerprint(input);

  const runContext = {
    actorRunId: actorEnv.actorRunId ?? null,
    actorBuildId: actorEnv.actorBuildId ?? null,
    actorTaskId: actorEnv.actorTaskId ?? null,
    inputFingerprint,
    sourceName: input.sourceName,
    runLabel: input.runLabel,
    releaseVersion: '1.3.14',
    buildTag: 'release-1.3.14',
  };

  initializeRunContext(runContext);

  const log = createLogger('main', input.debug);

  log.info('Actor starting', {
    sourceName: input.sourceName,
    runLabel: input.runLabel,
    startUrls: input.startUrls.length,
    recheckLots: input.recheckLots.length,
    keywords: input.keywords.length,
    discoveryMode: input.discoveryMode,
    maxPages: input.maxPages,
    maxDiscoveryRequests: input.maxDiscoveryRequests,
    maxDetailRequests: input.maxDetailRequests,
    maxConcurrency: input.maxConcurrency,
    ebayEnabled: input.ebayEnabled,
    webhookEnabled: !!input.webhookUrl,
    proxyEnabled: false, proxyRequested: input.proxyEnabled,
    proxyFallbackToDirect: input.proxyFallbackToDirect,
  });

  const dedupeManager = new DedupeManager(stateKvStore, {
    log: createLogger('dedupe', input.debug),
    staleAfterMs: input.staleAfterMinutes * 60 * 1000,
    enableFingerprintRefresh: input.enableFingerprintRefresh,
    enableStaleRefresh: input.enableStaleRefresh,
  });
  await dedupeManager.initialize();

  // ── Register abort/migration handlers to persist state ─────────────────
  // When Apify aborts a run (SIGTERM), the default handler doesn't persist
  // our named KV store. We MUST listen for these events so partial runs
  // don't lose all their accumulated dedupe state.
  const emergencyPersist = async () => {
    log.info('Emergency persist triggered (abort/migration)');
    try {
      await dedupeManager.persist();
      log.info('Emergency persist completed successfully');
    } catch (err) {
      log.warning(`Emergency persist failed: ${err.message}`);
    }
  };
  Actor.on('aborting', emergencyPersist);
  Actor.on('migrating', emergencyPersist);
  Actor.on('persistState', emergencyPersist);

  // ── Diagnostic: confirm state loaded correctly ─────────────────────────
  const dedupeStats = dedupeManager.getStats();
  log.info('Dedupe state loaded', {
    loadedEntries: dedupeStats.loadedEntries,
    kvStoreName: stateStoreName,
    fingerprintRefreshEnabled: dedupeStats.fingerprintRefreshEnabled,
    staleRefreshEnabled: dedupeStats.staleRefreshEnabled,
    staleAfterMs: dedupeStats.staleAfterMs,
  });

  const webhookManager = input.webhookUrl
    ? new WebhookManager({
        url: input.webhookUrl,
        authToken: input.webhookAuthToken ?? undefined,
        batchSize: input.webhookBatchSize,
        maxRetries: input.webhookMaxRetries,
        timeoutMs: input.webhookTimeoutMs,
        kvStore: stateKvStore,
        log: createLogger('webhook', input.debug),
        runContext,
        sourceName: input.sourceName,
      })
    : null;

  if (webhookManager && input.webhookReplayDeadLetterOnStart) {
    await webhookManager.replayDeadLetter();
  }

  const hasPublicSurplusWork = input.recheckLots.length > 0 || input.discoveryMode === 'EXHAUSTIVE' || input.startUrls.length > 0 || input.keywords.length > 0;

  // Tracks every external_id the actor saw on this run (changed or unchanged).
  // Sent to the webhook as a "touch" payload after the crawl so the backend can
  // refresh last_seen_at on still-available listings even when dedupe skipped them.
  const seenExternalIds = new Set();

  let publicSurplusRunStats = null;
  let publicSurplusRecovery = null;
  let publicSurplusLease = null;
  let publicSurplusCrawlError = null;

  if (hasPublicSurplusWork) {
    const crawler = createPublicSurplusCrawler({
      startUrls: input.startUrls,
      recheckLots: input.recheckLots,
      keywords: input.keywords,
      discoveryMode: input.discoveryMode,
      includeAgencyPartitions: input.includeAgencyPartitions,
      maxPages: input.maxPages,
      maxDiscoveryRequests: input.maxDiscoveryRequests,
      maxDetailRequests: input.maxDetailRequests,
      maxRuntimeMinutes: input.maxRuntimeMinutes,
      maxConcurrency: input.maxConcurrency,
      requestTimeoutSecs: input.requestTimeoutSecs,
      maxRequestRetries: input.maxRequestRetries,
      recoveryPersistInterval: input.recoveryPersistInterval,
      circuitBreaker403Threshold: input.circuitBreaker403Threshold,
      circuitBreaker5xxThreshold: input.circuitBreaker5xxThreshold,
      circuitBreaker429Threshold: input.circuitBreaker429Threshold,
      proxyEnabled: input.proxyEnabled,
      recordPages: input.recordPages,
      proxyGroups: input.proxyGroups,
      proxyFallbackToDirect: input.proxyFallbackToDirect,
      singleWriterLeaseEnabled: input.singleWriterLeaseEnabled,
      runLeaseTtlMinutes: input.runLeaseTtlMinutes,
      completedEvidenceRetainEntries: input.completedEvidenceRetainEntries,
      debug: input.debug,
      dataset,
      stateKvStore,
      dedupeManager,
      webhookManager,
      seenExternalIds,
      runContext,
      sourceName: input.sourceName,
      maxItemsPerRun: input.maxItemsPerRun, 
      dedupeFlushInterval: input.dedupePersistInterval,
      onProgress: async ({ recordsSaved } = {}) => {
        if (recordsSaved && recordsSaved % input.dedupePersistInterval === 0) {
          await dedupeManager.persist();
          log.progress('publicsurplus');
        }
      },
      log: createLogger('publicsurplus', input.debug),
    });

    publicSurplusRecovery = crawler.publicsurplusRecovery;
    publicSurplusLease = crawler.publicsurplusLease;
    try {
      publicSurplusRunStats = await crawler.run();
      await dedupeManager.persist();
      log.info('Public Surplus crawl complete');
    } catch (err) {
      publicSurplusCrawlError = err;
      publicSurplusRunStats = crawler.publicsurplusStats || publicSurplusRunStats || {};
      publicSurplusRunStats.health_status = 'FAIL';
      publicSurplusRunStats.health_reasons = [...(publicSurplusRunStats.health_reasons || []), `crawl_error:${err.message}`];
      log.exception('Public Surplus crawl failed', err);
      try { await dedupeManager.persist(); } catch (_) { /* best effort */ }
    }

    // Log final dedupe diagnostics
    const finalDedupeStats = dedupeManager.getStats();
    log.info('Dedupe final stats', {
      loadedEntries: finalDedupeStats.loadedEntries,
      processedThisRun: finalDedupeStats.processedThisRun,
      skippedThisRun: finalDedupeStats.skippedThisRun,
      unchangedSkippedThisRun: finalDedupeStats.unchangedSkippedThisRun,
      newProcessedThisRun: finalDedupeStats.newProcessedThisRun,
      persistedEntries: finalDedupeStats.persistedEntries,
    });
  } else {
    log.info('No Public Surplus crawl work configured');
  }

  const hasEbayWork =
    !publicSurplusCrawlError && input.ebayEnabled && (input.ebayQueries.length > 0 || input.ebayCategoryIds.length > 0);

  if (hasEbayWork) {
    if (!input.ebayClientId || !input.ebayClientSecret) {
      log.error('eBay integration enabled but credentials are missing');
    } else {
      try {
        await fetchEbayListings({
          clientId: input.ebayClientId,
          clientSecret: input.ebayClientSecret,
          environment: input.ebayEnvironment,
          queries: input.ebayQueries,
          categoryIds: input.ebayCategoryIds,
          maxResults: input.ebayMaxResults,
          includeSoldComps: input.ebayIncludeSoldComps,
          dataset,
          dedupeManager,
          webhookManager,
          log: createLogger('ebay', input.debug),
        });
        await dedupeManager.persist();
        log.info('eBay integration complete');
      } catch (err) {
        log.exception('eBay integration failed', err);
      }
    }
  }

  // ── Touch path: tell the backend which listings the actor saw this run ──
  // Refreshes last_seen_at for every still-available listing, including ones
  // dedupe skipped. Backend sweeper deletes anything not touched within 26h.
  if (input.webhookUrl && seenExternalIds.size > 0) {
    try {
      const ids = Array.from(seenExternalIds);
      const CHUNK = 5000;
      for (let i = 0; i < ids.length; i += CHUNK) {
        const chunk = ids.slice(i, i + CHUNK);
        const res = await fetch(input.webhookUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(input.webhookAuthToken
              ? { Authorization: `Bearer ${input.webhookAuthToken}` }
              : {}),
          },
          body: JSON.stringify({ type: 'touch', external_ids: chunk }),
        });
        if (!res.ok) {
          log.warning(`Touch POST failed: ${res.status} ${await res.text()}`);
        }
      }
      log.info(`Touch sent for ${ids.length} external_ids`);
    } catch (err) {
      log.warning(`Touch POST exception: ${err.message}`);
    }
  }

  let requiredWebhookFailure = null;
  let webhookStats = null;
  if (webhookManager) {
    await webhookManager.flush();
    webhookStats = webhookManager.getStats();
    if (input.webhookDeliveryRequired && webhookStats.failedBatches > 0) {
      requiredWebhookFailure = `REQUIRED_WEBHOOK_DELIVERY_FAILED: ${webhookStats.failedBatches} batch(es) failed`;
    }
  }

  const allRecords = (input.csvExportEnabled || input.googleSheetId || input.sqlExportEnabled) ? await getAllDatasetItems(dataset) : [];

  log.info('Dataset ready for export', { recordCount: allRecords.length });

  if (input.csvExportEnabled && allRecords.length > 0) {
    await exportDatasetToCSV(allRecords, {
      outputDir: input.csvOutputDir,
      fileName: input.csvFileName,
      exportProfile: input.csvExportProfile,
      log: createLogger('csv-export', input.debug),
    });
  }

  if (input.googleSheetId && allRecords.length > 0) {
    await exportDatasetToGoogleSheets(allRecords, {
      spreadsheetId: input.googleSheetId,
      sheetName: input.googleSheetName,
      serviceAccountKey: input.googleServiceAccountKey,
      exportProfile: input.googleSheetsExportProfile,
      log: createLogger('gsheets-export', input.debug),
    });
  }

  if (input.sqlExportEnabled && allRecords.length > 0) {
    await exportDatasetToSql(allRecords, {
      outputDir: input.sqlOutputDir,
      fileName: input.sqlFileName,
      exportProfile: input.sqlExportProfile,
      wrapInTransaction: input.sqlWrapInTransaction,
      log: createLogger('sql-export', input.debug),
    });
  }

  await dedupeManager.persist();

  const completedAt = new Date().toISOString();
  const sharedRunStats = getRunStats();
  await kvStore.setValue('LAST_RUN_STATS', {
    ...sharedRunStats,
    completedAt,
    inputFingerprint,
    sourceName: input.sourceName,
    runLabel: input.runLabel,
  });
  let finalRunStatus = publicSurplusRunStats?.health_status ?? (hasPublicSurplusWork ? 'PASS' : 'NO_SOURCE_WORK');
  const finalHealthReasons = [...(publicSurplusRunStats?.health_reasons || [])];
  if (publicSurplusCrawlError) {
    finalRunStatus = 'FAIL';
    finalHealthReasons.push(`crawl_error:${publicSurplusCrawlError.message}`);
  }
  if (requiredWebhookFailure) {
    finalRunStatus = 'FAIL';
    finalHealthReasons.push(requiredWebhookFailure);
  }

  const httpAttempts = Number(publicSurplusRunStats?.requests_attempted || 0);
  const recordsSaved = Number(publicSurplusRunStats?.records_saved || 0);
  const runSummary = {
    source: 'publicsurplus',
    version: runContext.releaseVersion ?? '1.3.14',
    build_tag: runContext.buildTag ?? 'release-1.3.14',
    run_status: finalRunStatus,
    transport: publicSurplusRunStats?.transport ?? 'publicsurplus_html',
    ...(publicSurplusRunStats || {}),
    health_reasons: finalHealthReasons,
    webhook_stats: webhookStats,
    required_webhook_failure: requiredWebhookFailure,
    requests_per_1000_records: recordsSaved > 0 ? (httpAttempts / recordsSaved) * 1000 : null,
    completed_at: completedAt,
    input_fingerprint: inputFingerprint,
    actor_run_id: runContext.actorRunId,
    actor_build_id: runContext.actorBuildId,
    actor_task_id: runContext.actorTaskId,
  };
  await kvStore.setValue('RUN_SUMMARY', runSummary);

  if (publicSurplusRecovery) {
    const finalManifest = {
      source: 'publicsurplus',
      release_version: runContext.releaseVersion ?? '1.3.14',
      build_tag: runContext.buildTag ?? 'release-1.3.14',
      run_id: runContext.actorRunId,
      actor_build_id: runContext.actorBuildId,
      input_fingerprint: inputFingerprint,
      discovery_mode: input.discoveryMode,
      run_status: finalRunStatus,
      reconciliation: publicSurplusRunStats?.reconciliation || null,
      dlq_pending: publicSurplusRunStats?.reconciliation?.retry_pending ?? null,
      circuit_state: publicSurplusRunStats?.circuit_state || null,
      completed_at: completedAt,
      run_summary_consistency_key: `${runContext.actorRunId || 'local'}:${finalRunStatus}:${publicSurplusRunStats?.reconciliation?.discovered_unique ?? 0}`,
    };
    if (finalRunStatus === 'FAIL') await publicSurplusRecovery.markFailed({ manifest: finalManifest });
    else if (finalRunStatus === 'INCOMPLETE') await publicSurplusRecovery.markIncomplete({ manifest: finalManifest });
    else await publicSurplusRecovery.markComplete({ manifest: finalManifest, compact: true });
  }


  if (publicSurplusLease) await publicSurplusLease.release();
  log.summary();
  if (publicSurplusCrawlError) throw publicSurplusCrawlError;
  if (requiredWebhookFailure) throw new Error(requiredWebhookFailure);
});