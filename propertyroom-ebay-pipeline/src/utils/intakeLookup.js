/**
 * Intake client: asks the database which lots it already has ("lookup") and reports lots the actor saw but
 * did not re-open ("touch"). Both go to the apify-intake edge function with the shared secret.
 *
 * Decision rule (decideDetailFetch): open a lot page only when the lot is new, its search-page title, price,
 * bid count or end time differs from ours, our copy is incomplete, or it ends within `endingSoonMs`. Everything else is skipped and
 * touched. If the lookup fails the caller opens every page (fail open: never lose a lot because of the lookup).
 */

const LOOKUP_CHUNK = 5000;
const TOUCH_CHUNK = 5000;

export class IntakeLookup {
  /**
   * @param {{ url: string, secret: string, source: string, log: any, timeoutMs?: number }} opts
   */
  constructor({ url, secret, source, log, timeoutMs = 30_000 }) {
    this._url = url;
    this._secret = secret;
    this._source = source;
    this._log = log;
    this._timeoutMs = timeoutMs;
    this.stats = { lookedUp: 0, seenBefore: 0, lookupFailures: 0, touched: 0 };
  }

  async _post(body) {
    const res = await fetch(this._url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-webhook-secret': this._secret },
      body: JSON.stringify({ source: this._source, ...body }),
      signal: AbortSignal.timeout(this._timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`intake ${body.type} HTTP ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  }

  /**
   * @param {string[]} ids
   * @returns {Promise<Map<string, object>|null>} id -> lookup row, or null when the lookup is unavailable
   */
  async lookup(ids) {
    const unique = [...new Set(ids.filter(Boolean))];
    const out = new Map();
    if (unique.length === 0) return out;
    try {
      for (let i = 0; i < unique.length; i += LOOKUP_CHUNK) {
        const data = await this._post({ type: 'lookup', external_ids: unique.slice(i, i + LOOKUP_CHUNK) });
        for (const lot of data.lots ?? []) out.set(lot.listing_external_id, lot);
      }
    } catch (err) {
      this.stats.lookupFailures += 1;
      this._log.warning(`Intake lookup failed, opening all pages on this index page: ${err.message}`);
      return null;
    }
    this.stats.lookedUp += unique.length;
    for (const lot of out.values()) if (lot.seen_before) this.stats.seenBefore += 1;
    return out;
  }

  /**
   * @param {string[]} ids lots seen on the site but not re-opened this run
   */
  async touch(ids) {
    const unique = [...new Set(ids.filter(Boolean))];
    for (let i = 0; i < unique.length; i += TOUCH_CHUNK) {
      const data = await this._post({ type: 'touch', external_ids: unique.slice(i, i + TOUCH_CHUNK) });
      this.stats.touched += Number(data.state_touched ?? 0);
    }
    return this.stats.touched;
  }
}

/** Lower-case, collapse spaces, drop a trailing ellipsis (search cards may truncate titles). */
function normTitle(title) {
  return String(title ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/(\.\.\.|…)\s*$/, '')
    .trim();
}

/** True when both titles are known and neither is a prefix of the other. */
export function titlesDiffer(indexTitle, knownTitle) {
  const a = normTitle(indexTitle);
  const b = normTitle(knownTitle);
  if (!a || !b) return false;
  return !(a.startsWith(b) || b.startsWith(a));
}

/**
 * @param {{ indexPrice: number|null, indexTitle?: string|null, indexBids?: number|null, indexEnd?: string|null }} item
 *   values from the search page
 * @param {object|undefined} known  row from IntakeLookup.lookup()
 * @param {{ now?: number, endingSoonMs: number }} opts
 * @returns {{ open: boolean, reason: string }}
 */
export function decideDetailFetch(item, known, { now = Date.now(), endingSoonMs }) {
  if (!known || !known.seen_before) return { open: true, reason: 'new' };
  if (known.needs_detail) return { open: true, reason: 'incomplete' };

  const endMs = known.end_time ? Date.parse(known.end_time) : NaN;
  if (Number.isFinite(endMs) && endMs - now <= endingSoonMs) return { open: true, reason: 'ending_soon' };

  const knownPrice = known.current_price == null ? null : Number(known.current_price);
  if (item.indexPrice != null && knownPrice != null && Math.abs(item.indexPrice - knownPrice) > 0.01) {
    return { open: true, reason: 'price_changed' };
  }
  if (item.indexPrice != null && knownPrice == null) return { open: true, reason: 'price_changed' };

  const knownBids = known.bid_count == null || known.bid_count === '' ? null : Number(known.bid_count);
  if (item.indexBids != null && knownBids != null && Number.isFinite(knownBids) && item.indexBids !== knownBids) {
    return { open: true, reason: 'bids_changed' };
  }

  const indexEndMs = item.indexEnd ? Date.parse(item.indexEnd) : NaN;
  if (Number.isFinite(indexEndMs) && Number.isFinite(endMs) && Math.abs(indexEndMs - endMs) > 60_000) {
    return { open: true, reason: 'end_changed' };
  }

  if (titlesDiffer(item.indexTitle, known.title)) return { open: true, reason: 'title_changed' };

  return { open: false, reason: 'unchanged' };
}
