import { Actor } from 'apify';
import { PlaywrightCrawler } from 'crawlee';
import { normalizeRecord, validateRecord, addSupabaseAliases } from '../../utils/normalize.js';
import { incrementStat } from '../../utils/logging.js';
import { SELECTORS } from './selectors.js';
import { keywordUrl, externalIdFromUrl, isDetailUrl, normalizeDetailUrl } from './urlHelpers.js';
import { collectDetailUrls, findNextPageUrl, normalizeDetailUrlList } from './indexExtractor.js';
import { extractPropertyRoomDetail } from './detailExtractor.js';

function randomBetween(minMs, maxMs) {
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function buildInitialRequests(startUrls, keywords) {
  return [
    ...startUrls.map((url) => ({
      url: typeof url === 'string' ? url : url.url,
      userData: { type: 'index', depth: 1, seed_type: 'start_url' },
    })),
    ...keywords.map((kw) => ({
      url: keywordUrl(kw),
      userData: { type: 'index', depth: 1, keyword: kw, seed_type: 'keyword' },
    })),
  ];
}

function computeObservationFingerprint(record) {
  return JSON.stringify({
    external_id: record.external_id,
    current_price: record.current_price,
    auction_end_time: record.auction_end_time,
    page_state: record.source_meta?.page_signals?.page_state || 'unknown',
  });
}

async function shouldSkipRecord(dedupeManager, record) {
  if (!dedupeManager) return false;
  if (typeof dedupeManager.shouldProcess === 'function') {
    return !(await dedupeManager.shouldProcess(record.external_id, computeObservationFingerprint(record)));
  }
  if (typeof dedupeManager.isDuplicate === 'function') {
    return dedupeManager.isDuplicate(record.external_id);
  }
  return false;
}

async function markProcessedRecord(dedupeManager, record) {
  if (!dedupeManager) return;
  if (typeof dedupeManager.markSeenWithFingerprint === 'function') {
    await dedupeManager.markSeenWithFingerprint(record.external_id, computeObservationFingerprint(record));
    return;
  }
  if (typeof dedupeManager.markSeen === 'function') {
    dedupeManager.markSeen(record.external_id);
  }
}

export function createPropertyRoomCrawler(opts) {
  const {
    startUrls,
    keywords,
    maxPages,
    maxConcurrency,
    requestTimeoutSecs,
    maxRequestRetries,
    proxyEnabled,
    proxyGroups,
    debug,
    dataset,
    dedupeManager,
    webhookManager,
    log,
    runContext = {},
    sourceName = 'propertyroom',
    dedupeFlushInterval = 500,
    onProgress = null,
    maxItemsPerRun = 0,
  } = opts;

  const initialRequests = buildInitialRequests(startUrls, keywords);
  let detailSavedCount = 0;

  const crawler = new PlaywrightCrawler({
    maxConcurrency,
    requestHandlerTimeoutSecs: requestTimeoutSecs,
    maxRequestRetries,
    useSessionPool: true,
    persistCookiesPerSession: true,
    maxSessionRotations: 20,
    launchContext: {
      launchOptions: {
        headless: true,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-infobars',
          '--no-first-run',
          '--no-zygote',
        ],
      },
    },

    preNavigationHooks: [
      async ({ page, session, request }, gotoOptions) => {
        await page.setExtraHTTPHeaders({
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
          Pragma: 'no-cache',
        });

        if (!page.__routeInitialized) {
          await page.route('**/*', async (route) => {
            const type = route.request().resourceType();
            if (['font', 'media'].includes(type)) return route.abort();
            if (type === 'image' && !isDetailUrl(request.url)) return route.abort();
            return route.continue();
          });
          page.__routeInitialized = true;
        }

        gotoOptions.waitUntil = 'domcontentloaded';
        gotoOptions.timeout = requestTimeoutSecs * 1000;

        const jitter = isDetailUrl(request.url)
          ? randomBetween(700, 1800)
          : randomBetween(300, 900);
        await sleep(jitter);

        if (session?.usageCount && session.usageCount > 25) {
          log.debug('Session aging', {
            sessionId: session.id,
            usageCount: session.usageCount,
          });
        }
      },
    ],

    async requestHandler({ page, request, enqueueLinks, session }) {
      const { url } = request;
      const userData = request.userData ?? {};
      const pageType = userData.type ?? (isDetailUrl(url) ? 'detail' : 'index');

      log.debug(`Handling ${pageType}`, {
        url,
        sessionId: session?.id,
      });

      if (pageType === 'index') {
        const depth = userData.depth ?? 1;

        try {
          await page.waitForSelector(SELECTORS.indexReady.join(', '), { timeout: 15000 });
        } catch {
          log.warning('No listings detected on index page', { url, depth });
        }

        const detailUrls = normalizeDetailUrlList(await collectDetailUrls(page));
        log.info('Index page processed', { url, depth, itemCount: detailUrls.length });
        incrementStat('indexPagesVisited');
        incrementStat('pagesVisited');

        const requestsToAdd = [];
        for (const detailUrl of detailUrls) {
          const cleanUrl = normalizeDetailUrl(detailUrl);
          const extId = externalIdFromUrl(cleanUrl);
          if (dedupeManager?.isQueued?.(extId)) continue;
          if (typeof dedupeManager?.markQueued === 'function') dedupeManager.markQueued(extId);

          requestsToAdd.push({
            url: cleanUrl,
            uniqueKey: extId,
            userData: {
              type: 'detail',
              sourceName,
              discovered_from: url,
              keyword: userData.keyword ?? null,
              seed_type: userData.seed_type ?? null,
            },
          });
        }

        if (requestsToAdd.length > 0) {
          await crawler.addRequests(requestsToAdd);
        }

        incrementStat('itemsFound', detailUrls.length);

        if (maxPages === 0 || depth < maxPages) {
          const nextUrl = await findNextPageUrl(page, url);
          if (nextUrl && nextUrl !== url) {
            await crawler.addRequests([{
              url: nextUrl,
              uniqueKey: `index-${normalizeDetailUrl(nextUrl)}`,
              userData: {
                type: 'index',
                depth: depth + 1,
                keyword: userData.keyword ?? null,
                seed_type: userData.seed_type ?? null,
              },
            }]);
          }
        }

        return;
      }

      if (pageType === 'detail') {
        try {
          await page.waitForSelector(SELECTORS.detailReady.join(', '), { timeout: 15000 });
        } catch {
          log.warning('Primary content not detected on detail page', { url });
        }

        const extracted = await extractPropertyRoomDetail({
          page,
          url,
          debug,
          log,
        });

        if (extracted.blocked) {
          session?.retire();
          incrementStat('blockedPages');
          log.warning('Blocked/challenge page detected', {
            url,
            page_state: extracted.page_state,
          });
          return;
        }

        const rawData = extracted.raw;

        if (!rawData) {
          incrementStat('errors');
          log.error('No raw data returned from detail extractor', { url });
          return;
        }

        if (rawData.source_meta?.page_signals?.page_state === 'unavailable') {
          incrementStat('unavailablePages');
          log.info('Unavailable or ended listing observed', {
            url,
            external_id: rawData.external_id,
          });
        }

        rawData.record_lineage = {
          ...(rawData.record_lineage || {}),
          actor_run_id: runContext.actorRunId || null,
          actor_build_id: runContext.actorBuildId || null,
          actor_task_id: runContext.actorTaskId || null,
          input_fingerprint: runContext.inputFingerprint || null,
          source_name: sourceName,
          discovered_from: userData.discovered_from || null,
          keyword: userData.keyword || null,
          seed_type: userData.seed_type || null,
        };

        let record;
        try {
          record = normalizeRecord(rawData, 'propertyroom');
        } catch (err) {
          incrementStat('errors');
          log.error(`Normalization failed for ${url}: ${err.message}`);
          return;
        }

        const validation = validateRecord(record);
        if (!validation.valid) {
          incrementStat('errors');
          log.error('Schema validation failed', {
            url,
            external_id: record.external_id,
            errors: validation.errors,
          });
          return;
        }

        const skip = await shouldSkipRecord(dedupeManager, record);
        if (skip) {
          incrementStat('itemsSkipped');
          log.debug('Skipping previously observed record', {
            external_id: record.external_id,
            url,
          });
          return;
        }

        // ── Safety cap: maxItemsPerRun ──────────────────────────────────
        if (maxItemsPerRun > 0 && detailSavedCount >= maxItemsPerRun) {
          log.info(`Reached maxItemsPerRun cap (${maxItemsPerRun}), stopping crawler`);
          crawler.autoscaledPool?.abort();
          return;
        }

        detailSavedCount += 1;

        await markProcessedRecord(dedupeManager, record);
        addSupabaseAliases(record);

        await dataset.pushData(record);
        incrementStat('itemsSaved');
        incrementStat('detailPagesVisited');
        incrementStat('pagesVisited');

        if (webhookManager) {
          await webhookManager.add(record);
        }

        

        if (onProgress && detailSavedCount % dedupeFlushInterval === 0) {
          await onProgress({ recordsSaved: detailSavedCount });
        }

        log.info('Saved PropertyRoom item', {
          id: record.external_id,
          title: record.title?.slice(0, 60),
          price: record.current_price,
          shipping: record.estimated_shipping,
          page_state: record.source_meta?.page_signals?.page_state || 'unknown',
          images: Array.isArray(record.image_urls) ? record.image_urls.length : 0,
        });
      }
    },

    failedRequestHandler({ request, error, session }) {
      if (session) session.retire();

      incrementStat('errors');
      log.error('Request failed after retries', {
        url: request.url,
        error: error?.message?.slice(0, 300),
      });
    },
  });

  const originalRun = crawler.run.bind(crawler);
  crawler.run = async function runPropertyRoomCrawler() {
    if (proxyEnabled) {
      try {
        crawler.proxyConfiguration = await Actor.createProxyConfiguration({
          groups: proxyGroups?.length ? proxyGroups : ['RESIDENTIAL'],
          countryCode: 'US',
        });
      } catch (err) {
        log.warning(`Proxy configuration failed: ${err.message}`);
      }
    }
    return originalRun(initialRequests);
  };

  return crawler;
}