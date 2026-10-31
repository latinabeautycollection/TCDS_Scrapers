// Intake-contract field rules for Liquidation.com (arb.unified_listing.v1).
// Pure functions only (no I/O) so they can be tested offline with plain `node`.
// Applied in the extractor AFTER normalizeRecord and re-applied AFTER addSupabaseAliases,
// so the shared (golden) normalize.js stays untouched.
import { createHash } from 'node:crypto';
export function isClosedLot(raw, observedAt) {
  return ['ENDED', 'CANCELLED'].includes(raw.auction_status)
    || Date.parse(raw.auction_end_time) <= Date.parse(observedAt);
}

export function normalizeNoBidPolicy() {
  // The intake contract requires the opening amount when the site publishes it.
  // Keep accepting the legacy NULL input for old saved Apify inputs, but normalize
  // it to MINIMUM_BID so it can no longer erase a real starting price.
  return 'MINIMUM_BID';
}

/** Search cards can show misleading counters for sealed bids; detail evidence wins. */
export function applyIndexObservations(raw, indexObs = {}) {
  if (raw.listing_type !== 'SEALED_BID') {
    if (raw.bid_count == null && indexObs.bidCount != null) raw.bid_count = indexObs.bidCount;
    if (indexObs.currentPrice != null && raw.minimum_bid == null && raw.bid_count === 0) {
      raw.minimum_bid = indexObs.currentPrice;
    }
  }
  return raw;
}

/** Preserve the site's opening price as current_price when a standard auction has no bids. */
export function applyNoBidPolicy(raw, policy = 'NULL') {
  normalizeNoBidPolicy(policy);
  const noBids = raw.bid_count === 0 && raw.listing_type === 'STANDARD_AUCTION';
  if (!noBids) return raw;
  const openingPrice = raw.starting_price ?? raw.minimum_bid ?? raw.current_price;
  if (openingPrice != null && Number.isFinite(Number(openingPrice)) && Number(openingPrice) > 0) {
    raw.starting_price = Number(openingPrice);
    raw.minimum_bid ??= Number(openingPrice);
    raw.current_price = Number(openingPrice);
    raw.price_type = 'starting_bid';
  }
  raw.price_status = 'NO_BIDS_YET';
  return raw;
}

export function isNoBidLot(record) {
  return record?.price_status === 'NO_BIDS_YET' && record?.current_price == null;
}

/** Clean multi-line description: keep line breaks, drop tags/entities/NBSP, no generic boilerplate,
 *  never the title. Returns null when nothing real is left. */
export function cleanDescription(text, title = null) {
  if (text == null) return null;
  let s = String(text)
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#0*39;|&apos;/gi, "'")
    .replace(/\u00a0/g, ' ').replace(/\r/g, '');
  const lines = s.split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter((l) => !/^(view manifest|download( manifest)?|get a quote)$/i.test(l));
  const out = [];
  for (const l of lines) {
    if (l === '' && (out.length === 0 || out[out.length - 1] === '')) continue;
    out.push(l);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  const norm = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  while (title && out.length && (out[0] === '' || norm(out[0]) === norm(title))) out.shift();
  const result = out.join('\n').trim();
  if (!result) return null;
  if (title && result.toLowerCase() === String(title).trim().toLowerCase()) return null;
  return result;
}

export function nullifyEmptyStrings(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim() === '') obj[k] = null;
    else if (v && typeof v === 'object' && !Array.isArray(v)) nullifyEmptyStrings(v);
  }
  return obj;
}

/** Flat site-specific attributes (everything not top-level). Empty values dropped. */
export function buildAttributes(raw, record = {}) {
  const m = raw.source_meta || {};
  const a = {
    serial_number: raw.serial_number ?? null, vin: raw.vin ?? null,
    shipping_evidence: raw.shipping_evidence ?? null,
    auction_id: raw.auction_id ?? m.auction_id ?? null,
    listing_type: raw.listing_type ?? null,
    auction_type_raw: m.auction_type_raw ?? null,
    available_purchase_modes: Array.isArray(raw.available_purchase_modes) ? raw.available_purchase_modes.join(',') : null,
    price_status: raw.price_status ?? null,
    price_type: raw.price_type ?? null,
    buy_now_price: raw.buy_now_price ?? null,
    bid_count: raw.bid_count ?? null,
    bidder_count: raw.bidder_count ?? null,
    view_count: raw.view_count ?? null,
    watcher_count: raw.watcher_count ?? null,
    minimum_bid: raw.minimum_bid ?? null,
    buyers_premium_source: raw.buyers_premium_pct != null ? 'published_percentage' : null,
    seller: raw.seller_name ?? null,
    seller_type: raw.seller_type ?? null,
    fulfilled_by: m.fulfilled_by ?? null,
    quantity: raw.quantity ?? null,
    quantity_variance_pct: m.quantity_variance_pct ?? null,
    package_count: m.package_count ?? null,
    pallet_count: m.pallet_count ?? null,
    shipping_terms: m.shipping_terms ?? null,
    minimum_shipping_fee: m.minimum_shipping_fee ?? null,
    shipping_weight: m.shipping_weight ?? null,
    shipping_restrictions: m.shipping_restrictions ?? null,
    estimated_retail_value: m.estimated_retail_value ?? null,
    bid_price_per_unit: m.bid_price_per_unit ?? null,
    payment_terms: raw.payment_terms ?? null,
    removal_requirements: raw.removal_requirements ?? null,
    manifest_html_url: m.manifest_html_url ?? null,
    manifest_csv_url: m.manifest_csv_url ?? null,
    original_currency: raw.currency && raw.currency !== 'USD' ? raw.currency : null,
    auction_start_time_source: raw.auction_start_time_source ?? null,
  };
  for (const k of Object.keys(a)) if (a[k] === null || a[k] === undefined || a[k] === '') delete a[k];
  return a;
}

/** Meaningful fields only. Never scraped_at/observed_at/actor_run_id/time-remaining. */
export function computeContentHash(record) {
  const attrs = record.attributes || {};
  const keyAttrs = {};
  for (const k of ['bid_count', 'minimum_bid', 'listing_type', 'quantity', 'shipping_terms', 'minimum_shipping_fee', 'seller', 'price_type', 'shipping_method', 'auction_start_time_source']) {
    if (attrs[k] !== undefined) keyAttrs[k] = attrs[k];
  }
  const payload = {
    title: record.title ?? null,
    current_price: record.current_price ?? null,
    buy_now_price: record.buy_now_price ?? null,
    estimated_shipping: record.estimated_shipping ?? null,
    shipping_method: record.shipping_method ?? null,
    auction_start_time: record.auction_start_time ?? null,
    auction_end_time: record.auction_end_time ?? null,
    auction_status: record.auction_status ?? null,
    condition: record.condition ?? null,
    model: record.model ?? null, mpn: record.mpn ?? null,
    shipping_evidence: record.shipping_evidence ?? null,
    buyers_premium: record.buyers_premium ?? null,
    location: record.location ?? null,
    currency: record.currency ?? null,
    description: record.description ?? null,
    attributes: keyAttrs,
  };
  const sorted = (v) => {
    if (Array.isArray(v)) return v.map(sorted);
    if (v && typeof v === 'object') return Object.keys(v).sort().reduce((o, k) => { o[k] = sorted(v[k]); return o; }, {});
    return v;
  };
  return createHash('sha256').update(JSON.stringify(sorted(payload))).digest('hex');
}

/** Intake overrides on the normalized record (shared normalizer left untouched). */
export function applyIntakeFields(record, raw) {
  const imgs = Array.isArray(raw.images) ? raw.images.filter((u) => typeof u === 'string' && u) : [];
  record.image_urls = imgs;
  record.primary_image_url = imgs[0] ?? null; // first photo, not alphabetical
  record.description = cleanDescription(raw.description, record.title);
  record.buyers_premium = raw.buyers_premium_pct ?? null; // percent (11, not 0.11)
  record.current_price = raw.current_price ?? null;
  record.buy_now_price = raw.buy_now_price ?? null;
  record.estimated_shipping = raw.estimated_shipping ?? null;
  record.shipping_method = raw.shipping_method ?? null;
  record.shipping_evidence = raw.shipping_evidence ?? null;
  record.auction_start_time = raw.auction_start_time ?? null;
  record.source_record = raw.source_record ?? null;
  record.location = raw.location || null;
  record.category = raw.category || null;
  record.subcategory = raw.subcategory || null;
  record.brand = raw.brand || record.brand || null;
  record.model = raw.model ?? null;
  record.mpn = raw.mpn ?? null;
  record.attributes = buildAttributes(raw, record);
  nullifyEmptyStrings(record);
  record.content_hash = computeContentHash(record);
  return record;
}

/** Re-apply after addSupabaseAliases() (which blanks/overwrites some fields for legacy PropertyRoom). */
export function reapplyAfterAliases(record, raw) {
  record.brand = raw.brand || record.brand || null;
  record.model = raw.model ?? null;
  record.mpn = raw.mpn ?? null;
  record.category = raw.category_name || raw.category || null; // site's own text, not a slug
  record.subcategory = raw.subcategory || null;
  record.buy_now_price = raw.buy_now_price ?? null;
  record.inbound_fees_usd = null; // aliases assume a dollar premium
  record.description = cleanDescription(raw.description, record.title);
  record.image_urls = Array.isArray(raw.images) ? raw.images.filter((u) => typeof u === 'string' && u) : [];
  record.primary_image_url = record.image_urls[0] ?? null;
  nullifyEmptyStrings(record);
  return record;
}

/** Copy used ONLY for validateRecord (which demands strings): the stored record keeps nulls. */
export function validationShim(record) {
  const shim = { ...record };
  const attrs = record.attributes && typeof record.attributes === 'object' ? record.attributes : {};
  shim.attributes = { ...attrs, trusted: attrs.trusted && typeof attrs.trusted === 'object' ? attrs.trusted : {}, mined: attrs.mined && typeof attrs.mined === 'object' ? attrs.mined : {} };
  for (const f of ['listing_url', 'category', 'subcategory', 'condition', 'description', 'shipping_weight', 'auction_end_time',
    'location', 'decision_reason', 'purchase_recommendation', 'actor_run_id', 'actor_build_id', 'actor_task_id', 'input_fingerprint']) {
    if (typeof shim[f] !== 'string') shim[f] = '';
  }
  return shim;
}