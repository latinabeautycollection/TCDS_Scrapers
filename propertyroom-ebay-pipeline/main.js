/**
 * main.js
 *
 * Enterprise actor entrypoint for:
 * - PropertyRoom crawl
 * - optional eBay enrichment
 * - optional webhook delivery
 * - governed exports
 */

import crypto from 'node:crypto';
import { Actor } from 'apify';

import { createPropertyRoomCrawler } from './src/extractors/propertyroom.js';
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
  keywords: [],
  maxPages: 10,
  maxConcurrency: 15,
  requestTimeoutSecs: 30,
  maxRequestRetries: 3,
  proxyEnabled: true,
  proxyGroups: ['DATACENTER'],
  debug: false,

  webhookUrl: null,
  webhookAuthToken: null,
  webhookBatchSize: 10,
  webhookMaxRetries: 5,
  webhookTimeoutMs: 30_000,
  webhookReplayDeadLetterOnStart: false,

  ebayEnabled: false,
  ebayClientId: null,
  ebayClientSecret: null,
  ebayEnvironment: 'production',
  ebayQueries: [],
  ebayCategoryIds: [],
  ebayMaxResults: 1000,
  ebayIncludeSoldComps: false,

  csvExportEnabled: true,
  csvExportProfile: 'propertyroom',
  csvOutputDir: './output',
  csvFileName: 'propertyroom_export.csv',

  googleSheetId: null,
  googleSheetName: 'Sheet1',
  googleSheetsExportProfile: 'overview',
  googleServiceAccountKey: null,

  sqlExportEnabled: false,
  sqlExportProfile: 'propertyroom',
  sqlWrapInTransaction: true,
  sqlOutputDir: './output',
  sqlFileName: 'propertyroom_ingest.sql',

  dedupePersistInterval: 500,
  enableFingerprintRefresh: true,
  enableStaleRefresh: true,
  staleAfterMinutes: 1440,

  sourceName: 'propertyroom',
  runLabel: null,
  maxItemsPerRun: 0,

  ingestionMode: 'sql_export'
  // supported values:
  // - "none"
  // - "sql_export"
  // - "webhook"
  // - "direct_db"   // reserved for future implementation
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

function buildInputFingerprint(input) {
  const canonical = JSON.stringify(input, Object.keys(input).sort());
  return crypto.createHash('sha256').update(canonical).digest('hex');
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
    keywords: safeStringArray(rawInput.keywords, DEFAULTS.keywords),

    maxPages: clampInt(rawInput.maxPages, DEFAULTS.maxPages, 1, 500, { allowZero: true }),
    maxConcurrency: clampInt(rawInput.maxConcurrency, DEFAULTS.maxConcurrency, 1, 20),
    requestTimeoutSecs: clampInt(rawInput.requestTimeoutSecs, DEFAULTS.requestTimeoutSecs, 15, 300),
    maxRequestRetries: clampInt(rawInput.maxRequestRetries, DEFAULTS.maxRequestRetries, 0, 10),

    proxyEnabled: clampBool(rawInput.proxyEnabled, DEFAULTS.proxyEnabled),
    proxyGroups: safeStringArray(rawInput.proxyGroups, DEFAULTS.proxyGroups),
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
    }),

    ingestionMode: safeString(rawInput.ingestionMode, DEFAULTS.ingestionMode)
  };

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
  const inputFingerprint = buildInputFingerprint(input);

  const runContext = {
    actorRunId: actorEnv.actorRunId ?? null,
    actorBuildId: actorEnv.actorBuildId ?? null,
    actorTaskId: actorEnv.actorTaskId ?? null,
    inputFingerprint,
    sourceName: input.sourceName,
    runLabel: input.runLabel,
  };

  initializeRunContext(runContext);

  const log = createLogger('main', input.debug);

  log.info('Actor starting', {
    sourceName: input.sourceName,
    runLabel: input.runLabel,
    startUrls: input.startUrls.length,
    keywords: input.keywords.length,
    maxPages: input.maxPages,
    maxConcurrency: input.maxConcurrency,
    ebayEnabled: input.ebayEnabled,
    webhookEnabled: !!input.webhookUrl,
    ingestionMode: input.ingestionMode,
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

  const hasPropertyRoomWork = input.startUrls.length > 0 || input.keywords.length > 0;

  // Tracks every external_id the actor saw on this run (changed or unchanged).
  // Sent to the webhook as a "touch" payload after the crawl so the backend can
  // refresh last_seen_at on still-available listings even when dedupe skipped them.
  const seenExternalIds = new Set();

  if (hasPropertyRoomWork) {
    const crawler = createPropertyRoomCrawler({
      startUrls: input.startUrls,
      keywords: input.keywords,
      maxPages: input.maxPages,
      maxConcurrency: input.maxConcurrency,
      requestTimeoutSecs: input.requestTimeoutSecs,
      maxRequestRetries: input.maxRequestRetries,
      proxyEnabled: input.proxyEnabled,
      proxyGroups: input.proxyGroups,
      debug: input.debug,
      dataset,
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
          log.progress('propertyroom');
        }
      },
      log: createLogger('propertyroom', input.debug),
    });

    try {
      await crawler.run();
      await dedupeManager.persist();
      log.info('PropertyRoom crawl complete');
    } catch (err) {
      log.exception('PropertyRoom crawl failed', err);
      // Still persist state even on failure so the next run doesn't start from scratch
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
    log.info('No PropertyRoom crawl work configured');
  }

  const hasEbayWork =
    input.ebayEnabled && (input.ebayQueries.length > 0 || input.ebayCategoryIds.length > 0);

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

  if (webhookManager) {
    await webhookManager.flush();
  }

  const allRecords = await getAllDatasetItems(dataset);

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

  await kvStore.setValue('LAST_RUN_STATS', {
    ...getRunStats(),
    completedAt: new Date().toISOString(),
    inputFingerprint,
    sourceName: input.sourceName,
    runLabel: input.runLabel,
  });

  log.summary();
});