/**
 * src/extractors/ebay.js
 *
 * Milestone 3 — eBay Integration (API-first, no website scraping)
 *
 * APIs used:
 *   • eBay Browse API  (OAuth 2.0 client credentials)
 *     - GET /buy/browse/v1/item_summary/search   → active listings
 *   • eBay Finding API (App ID / FSBO, XML-free JSON mode)
 *     - findCompletedItems  → sold comparables
 *
 * Token management:
 *   • Client-credentials grant (no user login needed for search-only access)
 *   • Auto-refresh when token is within 60 s of expiry
 *
 * Normalisation:
 *   • All eBay records are mapped into the same canonical schema used by
 *     PropertyRoom so the Dataset + webhook pipeline is source-agnostic.
 *
 * Docs:
 *   https://developer.ebay.com/api-docs/buy/browse/resources/item_summary/methods/search
 *   https://developer.ebay.com/devzone/finding/callref/findCompletedItems.html
 */

import { normalizeRecord, addSupabaseAliases } from '../utils/normalize.js';
import { incrementStat } from '../utils/logging.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const EBAY_OAUTH_URL = {
  production: 'https://api.ebay.com/identity/v1/oauth2/token',
  sandbox:    'https://api.sandbox.ebay.com/identity/v1/oauth2/token',
};

const EBAY_BROWSE_BASE = {
  production: 'https://api.ebay.com/buy/browse/v1',
  sandbox:    'https://api.sandbox.ebay.com/buy/browse/v1',
};

const EBAY_FINDING_BASE = {
  production: 'https://svcs.ebay.com/services/search/FindingService/v1',
  sandbox:    'https://svcs.sandbox.ebay.com/services/search/FindingService/v1',
};

const BROWSE_PAGE_SIZE  = 200; // eBay max per call
const FINDING_PAGE_SIZE = 100; // eBay Finding max per call
const REQUEST_TIMEOUT   = 30_000; // ms

// ─── OAuth Token Manager ──────────────────────────────────────────────────────

class EbayTokenManager {
  /**
   * @param {{ clientId: string, clientSecret: string, environment: string }} opts
   */
  constructor({ clientId, clientSecret, environment }) {
    this._clientId     = clientId;
    this._clientSecret = clientSecret;
    this._env          = environment === 'sandbox' ? 'sandbox' : 'production';
    this._token        = null;
    this._expiresAt    = 0; // Unix ms
  }

  /** Returns a valid access token, fetching one if needed. */
  async getToken() {
    if (this._token && Date.now() < this._expiresAt - 60_000) {
      return this._token;
    }
    await this._fetchToken();
    return this._token;
  }

  async _fetchToken() {
    const creds = Buffer.from(`${this._clientId}:${this._clientSecret}`).toString('base64');
    const body  = 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope';

    const resp = await fetch(EBAY_OAUTH_URL[this._env], {
      method:  'POST',
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded',
        'Authorization': `Basic ${creds}`,
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`eBay OAuth ${resp.status}: ${text.slice(0, 200)}`);
    }

    const data = await resp.json();
    this._token     = data.access_token;
    this._expiresAt = Date.now() + (data.expires_in ?? 7200) * 1000;
  }
}

// ─── Browse API helper ────────────────────────────────────────────────────────

/**
 * Fetch one page of eBay Browse API search results.
 *
 * @param {{
 *   token: string,
 *   baseUrl: string,
 *   query?: string,
 *   categoryId?: string,
 *   offset: number,
 *   limit: number,
 * }} opts
 * @returns {Promise<{ items: object[], total: number }>}
 */
async function browseSearchPage({ token, baseUrl, query, categoryId, offset, limit }) {
  const params = new URLSearchParams({
    limit:  String(limit),
    offset: String(offset),
  });
  if (query)      params.set('q', query);
  if (categoryId) params.set('category_ids', categoryId);

  const url = `${baseUrl}/item_summary/search?${params}`;

  const resp = await fetch(url, {
    headers: {
      Authorization:          `Bearer ${token}`,
      'Content-Type':         'application/json',
      'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Browse API ${resp.status}: ${text.slice(0, 300)}`);
  }

  const data = await resp.json();
  return {
    items: data.itemSummaries ?? [],
    total: data.total ?? 0,
  };
}

// ─── Finding API helper ───────────────────────────────────────────────────────

/**
 * Fetch one page of eBay Finding API completed/sold items.
 *
 * @param {{
 *   appId: string,
 *   baseUrl: string,
 *   query?: string,
 *   categoryId?: string,
 *   pageNumber: number,
 *   pageSize: number,
 * }} opts
 * @returns {Promise<{ items: object[], totalPages: number }>}
 */
async function findingCompletedPage({ appId, baseUrl, query, categoryId, pageNumber, pageSize }) {
  const params = new URLSearchParams({
    'OPERATION-NAME':          'findCompletedItems',
    'SERVICE-VERSION':         '1.0.0',
    'SECURITY-APPNAME':        appId,
    'RESPONSE-DATA-FORMAT':    'JSON',
    'REST-PAYLOAD':            '',
    'outputSelector(0)':       'SellerInfo',
    'outputSelector(1)':       'PictureURLLarge',
    'paginationInput.pageNumber': String(pageNumber),
    'paginationInput.entriesPerPage': String(pageSize),
  });

  if (query)      params.set('keywords', query);
  if (categoryId) params.set('categoryId', categoryId);

  // Sold/completed filter
  params.set('itemFilter(0).name',  'SoldItemsOnly');
  params.set('itemFilter(0).value', 'true');

  const url = `${baseUrl}?${params}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT) });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Finding API ${resp.status}: ${text.slice(0, 300)}`);
  }

  const data = await resp.json();
  const root = data?.findCompletedItemsResponse?.[0];
  const items = root?.searchResult?.[0]?.item ?? [];
  const totalPages = parseInt(
    root?.paginationOutput?.[0]?.totalPages?.[0] ?? '1',
    10,
  );

  return { items, totalPages };
}

// ─── Normalisation helpers ─────────────────────────────────────────────────────

/**
 * Map a Browse API itemSummary to the canonical schema.
 *
 * @param {object} item
 * @returns {object} raw fields for normalizeRecord()
 */
function mapBrowseItem(item) {
  const price = item.price?.value ?? item.currentBidPrice?.value ?? 0;
  const specs = {};
  for (const spec of item.localizedAspects ?? []) {
    if (spec.name && spec.value) specs[spec.name] = spec.value;
  }

  return {
    external_id:       `ebay-${item.itemId}`,
    title:             item.title ?? '',
    category:          item.categories?.[0]?.categoryName ?? '',
    condition:         item.condition ?? '',
    description:       item.shortDescription ?? '',
    current_price:     price,
    estimated_shipping: item.shippingOptions?.[0]?.shippingCost?.value ?? 0,
    buyers_premium:    0, // not available via Browse API
    auction_end_time:  item.itemEndDate ?? '',
    location:          [item.itemLocation?.city, item.itemLocation?.stateOrProvince, item.itemLocation?.country]
                         .filter(Boolean).join(', '),
    image_urls:        item.thumbnailImages?.map((i) => i.imageUrl).filter(Boolean) ??
                       (item.image?.imageUrl ? [item.image.imageUrl] : []),
    attributes:        {
      ...specs,
      listing_url:  item.itemWebUrl ?? '',
      seller:       item.seller?.username ?? '',
      buy_it_now:   item.buyingOptions?.includes('FIXED_PRICE') ? 'Yes' : 'No',
      auction:      item.buyingOptions?.includes('AUCTION') ? 'Yes' : 'No',
    },
  };
}

/**
 * Map a Finding API completed item to the canonical schema.
 *
 * @param {object} item  (raw Finding API JSON item node)
 * @returns {object}
 */
function mapFindingItem(item) {
  const itemId   = item.itemId?.[0] ?? 'unknown';
  const title    = item.title?.[0] ?? '';
  const price    = parseFloat(item.sellingStatus?.[0]?.currentPrice?.[0]?.__value__ ?? '0');
  const endTime  = item.listingInfo?.[0]?.endTime?.[0] ?? '';
  const location = item.location?.[0] ?? '';
  const imageUrl = item.galleryPlusPictureURL?.[0] ?? item.galleryURL?.[0] ?? '';
  const catName  = item.primaryCategory?.[0]?.categoryName?.[0] ?? '';
  const condition = item.condition?.[0]?.conditionDisplayName?.[0] ?? '';

  return {
    external_id:       `ebay-sold-${itemId}`,
    title,
    category:          catName,
    condition,
    description:       '',
    current_price:     price,
    estimated_shipping: parseFloat(item.shippingInfo?.[0]?.shippingServiceCost?.[0]?.__value__ ?? '0'),
    buyers_premium:    0,
    auction_end_time:  endTime,
    location,
    image_urls:        imageUrl ? [imageUrl] : [],
    attributes:        {
      listing_url: item.viewItemURL?.[0] ?? '',
      sold:        'true',
    },
  };
}

// ─── Main integration function ────────────────────────────────────────────────

/**
 * Fetch eBay listings and/or sold comps, normalise, and save.
 *
 * @param {{
 *   clientId: string,
 *   clientSecret: string,
 *   environment: string,
 *   queries: string[],
 *   categoryIds: string[],
 *   maxResults: number,
 *   includeSoldComps: boolean,
 *   dataset: import('apify').Dataset,
 *   dedupeManager: import('../utils/dedupe.js').DedupeManager,
 *   webhookManager: import('../utils/webhook.js').WebhookManager | null,
 *   log: ReturnType<import('../utils/logging.js').createLogger>,
 * }} opts
 */
export async function fetchEbayListings(opts) {
  const {
    clientId,
    clientSecret,
    environment = 'production',
    queries,
    categoryIds,
    maxResults = 1000,
    includeSoldComps = false,
    dataset,
    dedupeManager,
    webhookManager,
    log,
  } = opts;

  if (!clientId || !clientSecret) {
    throw new Error('eBay integration requires ebayClientId and ebayClientSecret');
  }

  const env = environment === 'sandbox' ? 'sandbox' : 'production';
  const tokenManager = new EbayTokenManager({ clientId, clientSecret, environment: env });

  log.info('eBay: authenticating…');
  await tokenManager.getToken(); // validate credentials early
  log.info('eBay: token obtained');

  const browseBase  = EBAY_BROWSE_BASE[env];
  const findingBase = EBAY_FINDING_BASE[env];

  /**
   * Process one Browse API search (query or categoryId).
   *
   * @param {string|null} query
   * @param {string|null} categoryId
   */
  async function processBrowseSearch(query, categoryId) {
    const label = query ? `query="${query}"` : `category=${categoryId}`;
    log.info(`eBay Browse: starting ${label}`);

    let offset = 0;
    let savedCount = 0;
    let total = Infinity;

    while (offset < Math.min(total, maxResults)) {
      const token = await tokenManager.getToken();
      const limit = Math.min(BROWSE_PAGE_SIZE, maxResults - offset);

      let page;
      try {
        page = await browseSearchPage({ token, baseUrl: browseBase, query, categoryId, offset, limit });
      } catch (err) {
        log.error(`eBay Browse error at offset ${offset} for ${label}: ${err.message}`);
        break;
      }

      total = page.total;
      if (page.items.length === 0) break;

      for (const item of page.items) {
        const raw = mapBrowseItem(item);
        let record;
        try {
          record = normalizeRecord(raw, 'ebay');
        } catch (err) {
          log.debug(`eBay normalisation skip: ${err.message}`);
          continue;
        }

        if (dedupeManager.isDuplicate(record.external_id)) {
          incrementStat('itemsSkipped');
          continue;
        }
        dedupeManager.markSeen(record.external_id);
        addSupabaseAliases(record);
        await dataset.pushData(record);
        if (webhookManager) await webhookManager.add(record);
        savedCount++;
        incrementStat('itemsSaved');
      }

      offset += page.items.length;
      log.info(`eBay Browse ${label}: page offset=${offset}/${total} saved=${savedCount}`);
    }

    log.info(`eBay Browse ${label}: complete — ${savedCount} records saved`);
  }

  /**
   * Process one Finding API completed-items search.
   *
   * @param {string|null} query
   * @param {string|null} categoryId
   */
  async function processFindingSearch(query, categoryId) {
    const label = query ? `query="${query}"` : `category=${categoryId}`;
    log.info(`eBay Finding (sold): starting ${label}`);

    let pageNumber = 1;
    let totalPages = 1;
    let savedCount = 0;
    let totalFetched = 0;

    while (pageNumber <= totalPages && totalFetched < maxResults) {
      let page;
      try {
        page = await findingCompletedPage({
          appId: clientId,
          baseUrl: findingBase,
          query,
          categoryId,
          pageNumber,
          pageSize: FINDING_PAGE_SIZE,
        });
      } catch (err) {
        log.error(`eBay Finding error at page ${pageNumber} for ${label}: ${err.message}`);
        break;
      }

      totalPages = page.totalPages;
      if (page.items.length === 0) break;

      for (const item of page.items) {
        const raw = mapFindingItem(item);
        let record;
        try {
          record = normalizeRecord(raw, 'ebay');
        } catch (err) {
          log.debug(`eBay Finding normalisation skip: ${err.message}`);
          continue;
        }

        if (dedupeManager.isDuplicate(record.external_id)) {
          incrementStat('itemsSkipped');
          continue;
        }
        dedupeManager.markSeen(record.external_id);
        addSupabaseAliases(record);
        await dataset.pushData(record);
        if (webhookManager) await webhookManager.add(record);
        savedCount++;
        incrementStat('itemsSaved');
      }

      totalFetched += page.items.length;
      log.info(`eBay Finding ${label}: page=${pageNumber}/${totalPages} saved=${savedCount}`);
      pageNumber++;
    }

    log.info(`eBay Finding ${label}: complete — ${savedCount} sold comps saved`);
  }

  // ── Run all queries ───────────────────────────────────────────────────────
  const allSearches = [
    ...queries.map((q)   => ({ query: q,    categoryId: null })),
    ...categoryIds.map((c) => ({ query: null, categoryId: c  })),
  ];

  for (const { query, categoryId } of allSearches) {
    // Active listings via Browse API
    try {
      await processBrowseSearch(query, categoryId);
    } catch (err) {
      log.error(`eBay Browse fatal for ${query ?? categoryId}: ${err.message}`);
    }

    // Sold comps via Finding API (optional)
    if (includeSoldComps) {
      try {
        await processFindingSearch(query, categoryId);
      } catch (err) {
        log.error(`eBay Finding fatal for ${query ?? categoryId}: ${err.message}`);
      }
    }
  }
}