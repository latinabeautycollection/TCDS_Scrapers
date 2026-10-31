/**
 * GovDeals JSON API client (Liquidity Services "maestro" backend).
 * Search/detail requests plus the bid-box request for auction-specific fields.
 *
 * - API keys are passed in (actor input / env). They are never logged or put in errors.
 * - x-api-correlation-id is a fresh UUID per request (the API returns 400 without it).
 * - 401/403 are fatal (GOVDEALS_API_AUTH_FAILED): keys may have rotated or access changed.
 * - 429 and 5xx/network errors are retried with backoff.
 * - No proxy by default (per spec). Datacenter proxy only as a later fallback if 429s appear.
 */
import { randomUUID } from 'node:crypto';

export const DEFAULT_API_BASE = 'https://maestro.lqdt1.com';
export const PHOTO_BASE = 'https://files.lqdt1.com';
export const SITE_BASE = 'https://www.govdeals.com';

export class GovDealsApiError extends Error {
  constructor(code, message, { status = null, fatal = false } = {}) {
    super(`${code}: ${message}`);
    this.name = 'GovDealsApiError';
    this.code = code;
    this.status = status;
    this.fatal = fatal;
  }
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class GovDealsApiClient {
  constructor({
    apiKey, subscriptionKey, baseUrl = DEFAULT_API_BASE, sessionId = randomUUID(),
    requestTimeoutMs = 60_000, maxRetries = 3, requestDelayMs = 1000,
    stats = {}, log = console, fetchImpl = globalThis.fetch, sleep = defaultSleep,
  } = {}) {
    if (!apiKey || !subscriptionKey) {
      throw new GovDealsApiError('GOVDEALS_API_KEYS_MISSING',
        'govdealsApiKey and govdealsSubscriptionKey must be provided as actor input or environment variables', { fatal: true });
    }
    this._apiKey = apiKey;
    this._subKey = subscriptionKey;
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.sessionId = sessionId;
    this.timeoutMs = requestTimeoutMs;
    this.maxRetries = Math.max(0, maxRetries);
    this.delayMs = Math.max(0, requestDelayMs);
    this.stats = stats;
    this.log = log;
    this._fetch = fetchImpl;
    this._sleep = sleep;
  }

  _bump(key, n = 1) { this.stats[key] = (this.stats[key] || 0) + n; }

  _redact(text) {
    let out = String(text ?? '');
    for (const secret of [this._apiKey, this._subKey]) {
      if (secret) out = out.split(secret).join('[REDACTED]');
    }
    return out;
  }

  _headers() {
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-api-key': this._apiKey,
      'Ocp-Apim-Subscription-Key': this._subKey,
      'x-api-correlation-id': randomUUID(), // new UUID per request (required)
      'x-ecom-session-id': this.sessionId,  // one UUID per run
      'x-user-id': '-1',
      'x-referer': `${SITE_BASE}/`,
    };
  }

  _post(path, body, label) { return this._send('POST', path, body, label); }
  _get(path, label) { return this._send('GET', path, null, label); }

  /** HTTP call with retries. Returns { status, headers, json }. */
  async _send(method, path, body, label) {
    const url = `${this.baseUrl}${path}`;
    let lastErr;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      this._bump('requests_attempted');
      this._bump('requests_total');
      this._bump('api_requests');
      if (attempt > 0) this._bump('requests_retried');
      try {
        const init = { method, headers: this._headers(), signal: AbortSignal.timeout(this.timeoutMs) };
        if (method === 'POST') init.body = JSON.stringify(body);
        const res = await this._fetch(url, init);
        const status = res.status;

        if (status === 401 || status === 403) {
          this._bump('access_denied_events');
          throw new GovDealsApiError('GOVDEALS_API_AUTH_FAILED',
            `${label} returned HTTP ${status}. API keys may be invalid or rotated`, { status, fatal: true });
        }
        if (status === 429 || status >= 500) {
          if (status === 429) this._bump('rate_limit_events');
          const retryAfter = Number.parseInt(res.headers.get('retry-after') || '', 10);
          lastErr = new GovDealsApiError(status === 429 ? 'GOVDEALS_API_RATE_LIMITED' : 'GOVDEALS_API_UPSTREAM',
            `${label} returned HTTP ${status}`, { status });
          if (attempt < this.maxRetries) {
            const wait = Number.isFinite(retryAfter) ? retryAfter * 1000 : Math.min(30_000, 1000 * 2 ** attempt);
            await this._sleep(wait);
            continue;
          }
          throw lastErr;
        }
        if (status >= 400) {
          // 400 (e.g. missing correlation id), 404 (lot gone), 405 (wrong method): not retryable
          const code = status === 404 ? 'GOVDEALS_API_NOT_FOUND' : status === 400 ? 'GOVDEALS_API_BAD_REQUEST'
            : status === 405 ? 'GOVDEALS_API_METHOD_NOT_ALLOWED' : `GOVDEALS_API_HTTP_${status}`;
          throw new GovDealsApiError(code, `${label} returned HTTP ${status}`, { status });
        }

        let json;
        try {
          json = await res.json();
        } catch {
          throw new GovDealsApiError('GOVDEALS_API_BAD_JSON', `${label} returned a non-JSON body`, { status });
        }
        this._bump('requests_success');
        if (this.delayMs) await this._sleep(this.delayMs);
        return { status, headers: res.headers, json };
      } catch (err) {
        if (err instanceof GovDealsApiError && (err.fatal || !['GOVDEALS_API_RATE_LIMITED', 'GOVDEALS_API_UPSTREAM'].includes(err.code))) {
          this._bump('requests_failed');
          throw err;
        }
        if (err instanceof GovDealsApiError) { lastErr = err; break; }
        // network error / timeout: retry
        lastErr = new GovDealsApiError('GOVDEALS_API_NETWORK', `${label} failed: ${this._redact(err?.message).slice(0, 160)}`);
        if (attempt < this.maxRetries) { await this._sleep(Math.min(30_000, 1000 * 2 ** attempt)); continue; }
      }
    }
    this._bump('requests_failed');
    this._bump('requests_permanently_failed');
    throw lastErr;
  }

  /** 1) SEARCH: discovery + current bids. Returns { rows, total, pageSize }. */
  async search({ page = 1, displayRows = 500, searchText = '*', businessId = 'GD', accountIds = [] } = {}) {
    const body = {
      businessId, searchText, page, displayRows,
      sortField: 'bestfit', sortOrder: 'desc', requestType: 'search', responseStyle: 'fullResponse',
      facets: ['categoryName'], facetsFilter: [], categoryIds: '', isQAL: false, locationId: null,
      model: '', makebrand: '', timeType: '', sellerTypeId: null, accountIds,
    };
    const { headers, json } = await this._post('/search/list', body, `search page ${page}`);
    const rows = json?.assetSearchResults;
    if (!Array.isArray(rows)) {
      throw new GovDealsApiError('GOVDEALS_API_SCHEMA_DRIFT', 'search response has no assetSearchResults array');
    }
    const totalHeader = Number.parseInt(headers.get('x-total-count') || '', 10);
    return { rows, total: Number.isFinite(totalHeader) ? totalHeader : null, pageSize: displayRows };
  }

  /** 2) ITEM DETAIL. Must be POST with a body (GET = 405, empty body = blank record). */
  async detail(assetId, accountId, { businessId = 'GD', siteId = 1 } = {}) {
    const { json } = await this._post(`/assets/${assetId}/${accountId}/false`, { businessId, siteId }, `detail ${accountId}/${assetId}`);
    if (!json || typeof json !== 'object' || (json.assetId == null && json.assetShortDescription == null && json.auctionId == null)) {
      throw new GovDealsApiError('GOVDEALS_API_BLANK_DETAIL', `detail ${accountId}/${assetId} returned a blank record`);
    }
    return json;
  }

  /**
   * 3) BID BOX: premiumPercent (buyer's premium), requirements (bidder restrictions),
   * bid count, bid increment and auction start time. Replaces the fees call.
   * GET /bids/bidbox/{businessId}/{assetId}/{accountId}/{auctionId}
   */
  async bidbox(assetId, accountId, auctionId, { businessId = 'GD' } = {}) {
    const { json } = await this._get(`/bids/bidbox/${businessId}/${assetId}/${accountId}/${auctionId}`, `bidbox ${accountId}/${assetId}`);
    if (!json || typeof json !== 'object') {
      throw new GovDealsApiError('GOVDEALS_API_BLANK_BIDBOX', `bidbox ${accountId}/${assetId} returned no data`);
    }
    return json;
  }

  /** (Legacy fallback, not used by default) FEES: buyer's premium / admin fees. Needs assetAuctionEndDate + auctionId from detail. */
  async fees(assetId, accountId, { assetAuctionEndDate, auctionId }) {
    const body = { assetAuctionEndDate, auctionId, includeShipping: false, excludeAdminFees: false };
    const { json } = await this._post(`/assets/${assetId}/${accountId}/assetadditionalfees`, body, `fees ${accountId}/${assetId}`);
    return json;
  }
}