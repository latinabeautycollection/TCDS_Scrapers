/**
 * Pure field rules for Municibid records (no cheerio dependency, unit-testable).
 * Aligned to the "Scraper Output & Intake Integration Guide" and the lessons from the GovDeals/Public Surplus canaries.
 */
import { createHash } from 'node:crypto';

/** Keep paragraph/list line breaks: collapse spaces inside lines, max one blank line between blocks. */
export function normalizeBlockText(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\f\v\u00a0 ]+/g, ' ')
    .split('\n').map((l) => l.trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\b\d{3})[\s.-]\d{3}[\s.-]\d{4}\b(?:\s*(?:ext\.?|x)\s*\d{1,5})?/gi;

/** Guide: no personal data we do not need (emails, phone numbers). */
export function redactContacts(text) {
  if (text == null) return text;
  return String(text).replace(EMAIL_RE, '').replace(PHONE_RE, '').replace(/[ \t]{2,}/g, ' ').replace(/ +\n/g, '\n').trim();
}

/** "Salt Lake City, UT 84115" or "Springfield, MA" -> item location as "City, ST[ ZIP]". Null if no match. */
export function cityState(text) {
  const s = String(text ?? '').replace(/,\s*Pennsylvania\b/gi, ', PA');
  const re = /([A-Za-z][A-Za-z.'\- ]{1,40}?),\s*([A-Z]{2})(?:\s+(\d{5})(?:-\d{4})?)?(?=\s|$|[,;|)\]])/g;
  let m; let last = null;
  while ((m = re.exec(s)) !== null) last = m;
  if (!last) return null;
  return `${last[1].trim()}, ${last[2]}${last[3] ? ` ${last[3]}` : ''}`;
}

/** Guide: unknown values are null, never empty strings. Top level and one level into plain objects. */
export function nullifyEmptyStrings(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && v.trim() === '') obj[k] = null;
    else if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v)) if (typeof v2 === 'string' && v2.trim() === '') v[k2] = null;
    }
  }
  return obj;
}

/** sha256 of the meaningful fields only (guide): never run-specific values or time-remaining counters. */
export function computeContentHash(record) {
  const meaningful = {
    source: record.source, listing_external_id: record.listing_external_id ?? record.external_id,
    title: record.title, current_price: record.current_price ?? null, auction_end_time: record.auction_end_time ?? null,
    auction_status: record.auction_status ?? null, condition: record.condition ?? null,
    buyers_premium: record.buyers_premium ?? null, location: record.location ?? null,
    auction_start_time: record.auction_start_time ?? null, estimated_shipping: record.estimated_shipping ?? null,
    price_type: record.price_type ?? null, shipping_method: record.shipping_method ?? null,
    shipping_evidence: record.shipping_evidence ?? null, condition_evidence: record.condition_evidence ?? null,
    auction_start_time_source: record.auction_start_time_source ?? null,
    shipping_available: record.shipping_available ?? null, pickup_required: record.pickup_required ?? null,
    brand: record.brand ?? null, model: record.model ?? null, mpn: record.mpn ?? null, minimum_bid: record.minimum_bid ?? null,
    description: record.description ?? null, image_urls: record.image_urls ?? [],
    bid_count: record.bid_count ?? null, starting_price: record.starting_price ?? null,
    pickup_location: record.pickup_location ?? null, payment_terms: record.payment_terms ?? null,
    removal_requirements: record.removal_requirements ?? null, seller_name: record.seller_name ?? null,
    year: record.year ?? null, make: record.make ?? null, vin: record.vin ?? null, mileage: record.mileage ?? null, hours: record.hours ?? null, subcategory: record.subcategory ?? null,
    category: record.category ?? null, documents: record.documents ?? [],
  };
  const sorted = JSON.stringify(Object.fromEntries(Object.entries(meaningful).sort(([a], [b]) => (a < b ? -1 : 1))));
  return createHash('sha256').update(sorted).digest('hex');
}

// validateRecord (shared normalizer) insists on strings/number for these fields, while the guide wants null.
const STRING_FIELDS = ['listing_url', 'category', 'subcategory', 'condition', 'description', 'shipping_weight', 'auction_end_time',
  'location', 'decision_reason', 'purchase_recommendation', 'actor_run_id', 'actor_build_id', 'actor_task_id', 'input_fingerprint'];
export function validationShim(record) {
  const shim = { ...record };
  for (const f of STRING_FIELDS) if (shim[f] == null) shim[f] = '';
  if (shim.current_price == null) shim.current_price = 0;
  return shim;
}

/**
 * Buyer rule: current_price is the live bid or, before the first bid, the published opening bid.
 * Never replace an observed opening bid with null. Search-page prices are never used (shared card text).
 */
export function applyNoBidRules(raw) {
  if (!raw) return raw;
  const noBids = raw.bid_count === 0;
  if (!noBids) return raw;
  if (raw.minimum_bid == null) raw.minimum_bid = raw.starting_price ?? (raw.current_price > 0 ? raw.current_price : null);
  if (raw.current_price == null || (raw.current_price === 0 && raw.minimum_bid > 0)) raw.current_price = raw.minimum_bid;
  raw.price_type = raw.current_price != null ? 'starting_bid' : raw.price_type;
  raw.source_meta = { ...(raw.source_meta || {}), price: { value: raw.current_price, source: 'published_opening_bid', no_bids: true } };
  return raw;
}
export function restoreSourceIdentity(record, raw) {
  record.brand = raw.manufacturer || raw.make || null;
  record.model = raw.model || null;
  const candidate = Object.hasOwn(raw, 'mpn') ? raw.mpn : raw.model_number || (raw.model && /\d/.test(raw.model) ? raw.model : null);
  record.mpn = candidate && ![raw.serial_number, raw.vin].filter(Boolean).some(value => String(value).toLowerCase() === String(candidate).toLowerCase()) ? candidate : null;
  return record;
}