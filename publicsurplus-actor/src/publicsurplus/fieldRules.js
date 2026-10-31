import { createHash } from 'node:crypto';

/**
 * Pure field rules for Public Surplus records (no cheerio dependency, unit-testable).
 * Added in V1.2.1 after the live canary found: wrong no-bid prices, site icons used as photos,
 * description text leaking into `condition`, and empty bid_count on no-bid lots.
 */

// Static site assets live under /sms/<yyyymmdd>/images/... (language flags, logos, UI icons).
const STATIC_ASSET_PATH = /\/sms\/\d{8}\/images\//i;
const SITE_IMAGE_PATH = /\/images\/ps\//i;
const LANGUAGE_FLAG = /\/(?:en|es|fr|de|pt|it|zh|ja|ko|ar|ru|vi|tl)\.(?:png|gif|jpe?g|webp)(?:\?|$)/i;
const UI_IMAGE_WORDS = /logo|icon|flag|sprite|translate|pixel|spacer|captcha|banner|button|arrow|badge|loading|placeholder|blank|no[-_]?image|header|footer|navbar|social|facebook|twitter|linkedin|youtube|rss/i;

// Real item photos on Public Surplus are served from CloudFront without a file extension, e.g.
// https://d37qv0n5b4mbzm.cloudfront.net/sms/docviewer/cdnmainaucdoc/thumb-b/{auctionId}/{docId}
const ITEM_DOC_PATH = /^https?:\/\/[^/]+\/sms\/docviewer\/cdn(?:main)?aucdoc\//i;

export function isItemPhotoUrl(url) {
  const u = String(url ?? '');
  if (!/^https?:\/\//i.test(u)) return false;
  if (ITEM_DOC_PATH.test(u)) return true;
  if (!/\.(?:jpe?g|png|webp)(?:\?|$)/i.test(u)) return false;
  if (STATIC_ASSET_PATH.test(u) || SITE_IMAGE_PATH.test(u)) return false;
  if (LANGUAGE_FLAG.test(u)) return false;
  if (UI_IMAGE_WORDS.test(u)) return false;
  return true;
}

export function filterItemPhotos(urls) {
  const seen = new Set();
  const out = [];
  for (const u of Array.isArray(urls) ? urls : []) {
    if (isItemPhotoUrl(u) && !seen.has(u)) { seen.add(u); out.push(u); }
  }
  return out;
}

const CONDITION_TOKENS = [
  'SEE DESCRIPTION', 'LIKE NEW', 'VERY GOOD', 'FOR PARTS', 'AS IS', 'REFURBISHED', 'EXCELLENT',
  'SALVAGE', 'DAMAGED', 'UNKNOWN', 'NEW', 'GOOD', 'FAIR', 'POOR', 'USED', 'WORKING', 'NOT WORKING',
].sort((a, b) => b.length - a.length);

/** Keep only the condition label ("SEE DESCRIPTION", "GOOD", ...). Raw text is kept separately in raw_condition. */
export function normalizeCondition(raw) {
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return 'UNKNOWN';
  const upper = text.toUpperCase();
  for (const token of CONDITION_TOKENS) {
    if (upper === token || upper.startsWith(`${token} `) || upper.startsWith(`${token}:`) || upper.startsWith(`${token},`)) {
      return token;
    }
  }
  if (text.length <= 30) return text;
  const cut = text.slice(0, 30);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), 10)).trim();
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Lots with no bids show no "Current Price" on the detail page. Never borrow a price from the
 * search page (its blocks are shared, which produced the same $162.50 on 12 lots).
 *
 * For a no-bid auction, use the published starting/opening amount. Public Surplus labels
 * this amount "Minimum bid" when the auction has no bids; do not use next minimum bid on
 * an auction with bids. Never replace a published amount with zero.
 */
export function applyNoBidRules(raw) {
  if (!raw) return raw;
  if (raw.listing_type === 'FIXED_PRICE') {
    if (raw.current_price == null && raw.buy_now_price != null) raw.current_price = raw.buy_now_price;
    if (raw.current_price != null) raw.price_type = 'buy_now';
    return raw;
  }
  const isAuction = raw.listing_type === 'AUCTION' || raw.minimum_bid != null || raw.bid_increment != null;
  if (!isAuction) {
    if (raw.current_price == null && raw.buy_now_price != null) raw.current_price = raw.buy_now_price;
    if (raw.current_price != null && raw.buy_now_price != null) raw.price_type = 'buy_now';
    return raw;
  }

  if (raw.bid_count !== 0) {
    if (raw.current_price != null) raw.price_type = 'current_bid';
    else if (raw.buy_now_price != null) {
      raw.current_price = raw.buy_now_price;
      raw.price_type = 'buy_now';
      raw.source_meta = { ...(raw.source_meta || {}), price: { value: raw.buy_now_price, source: 'publicsurplus_buy_now_fallback', raw: null } };
    }
    return raw;
  }

  const opening = raw.starting_price ?? raw.minimum_bid;
  if (opening != null && (raw.current_price == null || raw.current_price === 0)) {
    raw.current_price = opening;
    raw.price_type = 'starting_bid';
    raw.source_meta = { ...(raw.source_meta || {}), price: {
      value: opening,
      source: raw.starting_price != null ? 'publicsurplus_published_starting_bid' : 'publicsurplus_minimum_bid_no_bids',
      raw: raw.source_meta?.price?.raw ?? null,
      no_bids: true,
    } };
  } else if (raw.current_price != null) {
    raw.price_type = 'starting_bid';
  } else if (raw.buy_now_price != null) {
    raw.current_price = raw.buy_now_price;
    raw.price_type = 'buy_now';
    raw.source_meta = { ...(raw.source_meta || {}), price: { value: raw.buy_now_price, source: 'publicsurplus_buy_now_no_bids', raw: null, no_bids: true } };
  }

  if (raw.buyers_premium == null && raw.buyers_premium_pct != null && raw.current_price > 0) {
    raw.buyers_premium = round2(raw.current_price * (raw.buyers_premium_pct / 100));
    raw.buyers_premium_source = raw.buyers_premium_source || 'DERIVED_FROM_PUBLISHED_PERCENTAGE';
    raw.buyers_premium_confidence = raw.buyers_premium_confidence ?? 0.98;
  }
  return raw;
}

function shippingSentences(value) {
  return String(value ?? '').split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

/** Classify only explicit shipping language; return the exact source sentence for QA. */
export function classifyPublicSurplusShipping({ title = '', description = '', shippingText = '', pickupText = '', shippingCosts = [] } = {}) {
  const sentences = [title, description, shippingText, pickupText].flatMap(shippingSentences);
  const negative = /\b(?:shipping\s+(?:is\s+)?(?:not available|unavailable|not offered|not provided)|no\s+shipping(?:\s+(?:available|offered|provided))?|pickup\s+only|pick[ -]?up\s+only|must\s+be\s+picked\s+up|buyer\s+must\s+pick\s*up|will\s+not\s+ship|does\s+not\s+ship|cannot\s+ship|not\s+available\s+for\s+shipping)\b/i;
  const free = /\bfree\s+shipping\b/i;
  const pricedShipping = /\b(?:shipping|freight|postage)\b[^.!?]{0,100}\$\s*[\d,]+(?:\.\d{1,2})?|\$\s*[\d,]+(?:\.\d{1,2})?[^.!?]{0,100}\b(?:shipping|freight|postage)\b/i;
  const offer = /\b(?:shipping\s+(?:is\s+)?(?:available|offered)|will\s+ship|can\s+ship|seller\s+ships|we\s+ship|shipping\s+available|shipping\s+can\s+be\s+arranged|arrange\s+(?:for\s+)?shipping)\b/i;
  const scopedRestriction = /\bno\s+shipping\b.{0,80}\b(?:to|outside|in|for|except)\b.{0,60}\b(?:po\s*boxes?|p\.o\.|alaska|hawaii|canada|international|usa|u\.s\.|lower 48|contiguous|territor(?:y|ies)|remote areas?|zip codes?)\b/i;
  const negativeSentence = sentences.find((s) => negative.test(s) && !scopedRestriction.test(s));
  const scopedNegativeSentence = sentences.find((s) => negative.test(s) && scopedRestriction.test(s));
  const freeSentence = sentences.find((s) => free.test(s) && !/\b(?:no|not|without)\s+(?:free\s+)?shipping\b/i.test(s));
  const pricedSentence = sentences.find((s) => pricedShipping.test(s));
  const offerSentence = sentences.find((s) => offer.test(s));
  // A clear prohibition wins over a generic offer unless both refer to different
  // conditions in a way that offers an actual shipping option (handled upstream).
  if (negativeSentence) return { shipping_method: 'pickup_only', estimated_shipping: null, shipping_evidence: negativeSentence };
  if (freeSentence) return { shipping_method: 'free_shipping', estimated_shipping: 0, shipping_evidence: freeSentence };
  if (pricedSentence) {
    const amounts = [...pricedSentence.matchAll(/\$\s*([\d,]+(?:\.\d{1,2})?)/g)]
      .map((m) => Number.parseFloat(m[1].replace(/,/g, ''))).filter(Number.isFinite);
    if (amounts.length) return { shipping_method: 'shipping', estimated_shipping: Math.min(...amounts), shipping_evidence: pricedSentence };
  }
  if (offerSentence) return { shipping_method: 'shipping_quote', estimated_shipping: null, shipping_evidence: offerSentence };
  if (scopedNegativeSentence) return { shipping_method: 'shipping_quote', estimated_shipping: null, shipping_evidence: scopedNegativeSentence };
  const amounts = (Array.isArray(shippingCosts) ? shippingCosts : []).map(Number).filter((n) => Number.isFinite(n) && n >= 0);
  if (amounts.length) {
    const evidence = pricedSentence || `Shipping: ${String(shippingText).trim()}`;
    return { shipping_method: 'shipping', estimated_shipping: Math.min(...amounts), shipping_evidence: evidence };
  }
  const pickupEvidence = pickupText ? `Pick-up Location: ${String(pickupText).trim()}` : '';
  return { shipping_method: 'pickup_only', estimated_shipping: null, shipping_evidence: pickupEvidence || null };
}

// ── Intake-guide helpers (V1.2.3) ───────────────────────────────────────────

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

/** Intake guide: no personal data we do not need (emails, phone numbers). */
export function redactContacts(text) {
  if (text == null) return text;
  return String(text).replace(EMAIL_RE, '').replace(PHONE_RE, '').replace(/[ \t]{2,}/g, ' ').replace(/ +\n/g, '\n').trim();
}

/** "Salt River Project [7005 S. Kyrene Rd. Tempe, AZ 85283] ..." -> "Tempe, AZ 85283" (item location, not the agency name). */
export function cityStateZip(text) {
  const s = String(text ?? '');
  const lines = s.split(/\r?\n/).map(l => l.trim());
  for (const line of lines.reverse()) {
    if (/^[A-Za-z][A-Za-z.' -]*,\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?[\] ]*$/.test(line)) return line.replace(/[\] ]+$/, '');
  }
  const re = /([A-Za-z][A-Za-z.'\- ]{1,40}?),\s*([A-Z]{2})\s+(\d{5})(?:-\d{4})?/g;
  let m; let last = null;
  while ((m = re.exec(s)) !== null) last = m;
  if (!last) return null;
  const city = last[1].trim().replace(/^.*\b(?:Rd|Road|St|Street|Ave|Avenue|Blvd|Dr|Drive|Ln|Lane|Way|Hwy|Pkwy|Ct|Court|Pl|Place|Suite|Ste)\.?\s+/i, '');
  return `${city}, ${last[2]} ${last[3]}`;
}

/** Intake guide: unknown values are null, never empty strings. Top level and one level into plain objects. */
export function nullifyEmptyStrings(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'source_record') continue; // Preserve the captured page evidence byte-for-byte.
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
    description: record.description ?? null, image_urls: record.image_urls ?? [],
    category: record.category ?? null, subcategory: record.subcategory ?? null,
    auction_start_time: record.auction_start_time ?? null, bid_count: record.bid_count ?? null,
    shipping_available: record.shipping_available ?? null, pickup_required: record.pickup_required ?? null,
    estimated_shipping: record.estimated_shipping ?? null, seller_name: record.seller_name ?? null,
    brand: record.brand ?? null, model: record.model ?? null, mpn: record.mpn ?? null, minimum_bid: record.minimum_bid ?? null,
  };
  const sorted = JSON.stringify(Object.fromEntries(Object.entries(meaningful).sort(([a], [b]) => (a < b ? -1 : 1))));
  return createHash('sha256').update(sorted).digest('hex');
}

// validateRecord (shared normalizer) insists on strings/number for these fields, while the intake guide wants null.
// Validate a shim with the legacy placeholders; the record itself keeps null.
const STRING_FIELDS = ['listing_url', 'category', 'subcategory', 'condition', 'description', 'shipping_weight', 'auction_end_time',
  'location', 'decision_reason', 'purchase_recommendation', 'actor_run_id', 'actor_build_id', 'actor_task_id', 'input_fingerprint'];
export function validationShim(record) {
  const shim = { ...record };
  for (const f of STRING_FIELDS) if (shim[f] == null) shim[f] = '';
  if (shim.current_price == null) shim.current_price = 0;
  return shim;
}