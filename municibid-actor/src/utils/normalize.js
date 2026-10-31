/**
 * src/utils/normalize.js
 *
 * Enterprise normalization and validation layer for unified acquisition records.
 *
 * Goals:
 * - Normalize PropertyRoom and eBay records into a governed schema
 * - Preserve audit lineage and field provenance
 * - Support acquisition, comparison, and arbitrage record families
 * - Remain backward-compatible enough for existing pipeline integrations
 *
 * Canonical high-level schema:
 * {
 *   schema: string,
 *   schema_version: number,
 *   record_type: string,
 *   source: string,
 *   external_id: string,
 *   listing_url: string,
 *   title: string,
 *   category: string,
 *   subcategory: string,
 *   condition: string,
 *   description: string,
 *   current_price: number,
 *   buyers_premium: number|null,
 *   estimated_shipping: number|null,
 *   tax_estimate: number|null,
 *   total_estimated_cost: number|null,
 *   currency: string,
 *   auction_end_time: string,
 *   location: string,
 *   image_urls: string[],
 *   primary_image_url: string|null,
 *   attributes: { trusted: object, mined: object },
 *   source_meta: object,
 *   record_lineage: object,
 *   median_comp_price: number|null,
 *   avg_comp_price: number|null,
 *   estimated_ebay_fees: number|null,
 *   estimated_profit: number|null,
 *   estimated_margin_pct: number|null,
 *   risk_score: number|null,
 *   confidence_score: number|null,
 *   purchase_recommendation: string,
 *   decision_reason: string,
 *   dedupe_key: string,
 *   content_hash: string,
 *   normalization_status: string,
 *   pipeline_stage: string,
 *   scraped_at: string,
 *   observed_at: string,
 *   actor_run_id: string,
 *   actor_build_id: string,
 *   actor_task_id: string,
 *   input_fingerprint: string
 * }
 */

import { createHash } from 'node:crypto';

const DEFAULTS = Object.freeze({
  schema: process.env.DEFAULT_SCHEMA_NAME || 'arb.unified_listing.v1',
  schemaVersion: Number(process.env.DEFAULT_SCHEMA_VERSION || 1),
  currency: process.env.DEFAULT_CURRENCY || 'USD',
  normalizationStatus: 'normalized',
  pipelineStage: 'normalized',
  purchaseRecommendation: 'unscored',
});

const ALLOWED_SOURCES = new Set(['propertyroom', 'municibid', 'ebay', 'unknown']);
const ALLOWED_RECORD_TYPES = new Set([
  'auction_listing',
  'market_comp',
  'arbitrage_candidate',
  'unknown',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Generic helpers
// ─────────────────────────────────────────────────────────────────────────────

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function deepClone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function cleanText(raw) {
  if (raw == null) return '';
  return String(raw).replace(/\s+/g, ' ').trim();
}

function cleanNullableText(raw) {
  const value = cleanText(raw);
  return value || null;
}

function toFiniteNumber(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;

  const cleaned = String(raw).replace(/[^0-9.+-]/g, '');
  if (!cleaned) return null;

  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function toNonNegativeMoney(raw) {
  const n = toFiniteNumber(raw);
  if (n == null) return null;
  return n >= 0 ? roundTo2(n) : null;
}

function roundTo2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function cleanImageUrls(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const result = [];

  for (const item of arr) {
    const url = String(item ?? '').trim();
    if (!url) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    result.push(url);
  }

  return result;
}

function firstNonEmpty(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (v != null && typeof v !== 'string') return v;
  }
  return null;
}

function normalizeSource(source) {
  const s = cleanText(source || 'unknown').toLowerCase();
  return ALLOWED_SOURCES.has(s) ? s : 'unknown';
}

function inferRecordType(source, raw) {
  const explicit = cleanText(raw?.record_type || raw?.recordType || '').toLowerCase();
  if (ALLOWED_RECORD_TYPES.has(explicit)) return explicit;

  if (source === 'propertyroom' || source === 'municibid') return 'auction_listing';
  if (source === 'ebay') return 'market_comp';

  return 'unknown';
}

function safeStableStringify(value) {
  return JSON.stringify(sortObject(value));
}

function sortObject(value) {
  if (Array.isArray(value)) {
    return value.map(sortObject);
  }

  if (isPlainObject(value)) {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = sortObject(value[key]);
        return acc;
      }, {});
  }

  return value;
}

function sha256Hex(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function coerceBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    if (s === 'true') return true;
    if (s === 'false') return false;
  }
  return fallback;
}

// ─────────────────────────────────────────────────────────────────────────────
// Date parsing
// ─────────────────────────────────────────────────────────────────────────────

export function parseDate(raw) {
  if (!raw) return '';

  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime()) ? '' : raw.toISOString();
  }

  const s = String(raw).trim();
  if (!s) return '';

  if (/^\d{10,13}$/.test(s)) {
    const n = Number.parseInt(s, 10);
    const ms = s.length === 10 ? n * 1000 : n;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString();
  }

  const normalized = s
    .replace(/\bEastern\b/i, '-05:00')
    .replace(/\bPacific\b/i, '-08:00')
    .replace(/\bCentral\b/i, '-06:00')
    .replace(/\bMountain\b/i, '-07:00')
    .replace(/\bEST\b/, '-05:00')
    .replace(/\bEDT\b/, '-04:00')
    .replace(/\bCST\b/, '-06:00')
    .replace(/\bCDT\b/, '-05:00')
    .replace(/\bMST\b/, '-07:00')
    .replace(/\bMDT\b/, '-06:00')
    .replace(/\bPST\b/, '-08:00')
    .replace(/\bPDT\b/, '-07:00')
    .replace(/\bGMT\b/, '+00:00')
    .replace(/\bUTC\b/, '+00:00')
    .replace(/\bat\b/gi, ' ');

  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

// ─────────────────────────────────────────────────────────────────────────────
// Field normalization helpers
// ─────────────────────────────────────────────────────────────────────────────

function normalizeAttributes(raw) {
  if (!isPlainObject(raw)) {
    return { trusted: {}, mined: {} };
  }

  const trusted = isPlainObject(raw.trusted) ? normalizeAttributeBucket(raw.trusted) : {};
  const mined = isPlainObject(raw.mined) ? normalizeAttributeBucket(raw.mined) : {};

  // Backward compatibility: old flat attributes object becomes trusted bucket.
  if (!raw.trusted && !raw.mined) {
    return {
      trusted: normalizeAttributeBucket(raw),
      mined: {},
    };
  }

  return { trusted, mined };
}

function normalizeAttributeBucket(raw) {
  if (!isPlainObject(raw)) return {};

  const out = {};

  for (const [k, v] of Object.entries(raw)) {
    const key = cleanText(k);
    if (!key) continue;

    if (v == null) continue;

    if (Array.isArray(v)) {
      out[key] = v
        .map((x) => (typeof x === 'string' ? cleanText(x) : x))
        .filter((x) => x !== '' && x != null);
      continue;
    }

    if (isPlainObject(v)) {
      out[key] = normalizeLooseObject(v);
      continue;
    }

    if (typeof v === 'number') {
      out[key] = Number.isFinite(v) ? v : null;
      continue;
    }

    if (typeof v === 'boolean') {
      out[key] = v;
      continue;
    }

    const text = cleanText(v);
    if (text) out[key] = text;
  }

  return out;
}

function normalizeLooseObject(raw) {
  const out = {};

  for (const [k, v] of Object.entries(raw)) {
    const key = cleanText(k);
    if (!key) continue;

    if (v == null) {
      out[key] = null;
    } else if (Array.isArray(v)) {
      out[key] = v.map((x) => {
        if (isPlainObject(x)) return normalizeLooseObject(x);
        if (typeof x === 'string') return cleanText(x);
        if (typeof x === 'number') return Number.isFinite(x) ? x : null;
        if (typeof x === 'boolean') return x;
        return x == null ? null : cleanText(x);
      });
    } else if (isPlainObject(v)) {
      out[key] = normalizeLooseObject(v);
    } else if (typeof v === 'string') {
      out[key] = cleanText(v);
    } else if (typeof v === 'number') {
      out[key] = Number.isFinite(v) ? v : null;
    } else if (typeof v === 'boolean') {
      out[key] = v;
    } else {
      out[key] = cleanText(v);
    }
  }

  return out;
}

function normalizeSourceMeta(raw) {
  if (!isPlainObject(raw)) return {};

  const out = deepClone(raw);

  // Best-effort cleanup of common nested provenance values.
  if (isPlainObject(out.title)) out.title = normalizeFieldProvenance(out.title);
  if (isPlainObject(out.category)) out.category = normalizeFieldProvenance(out.category);
  if (isPlainObject(out.condition)) out.condition = normalizeFieldProvenance(out.condition);
  if (isPlainObject(out.description)) out.description = normalizeFieldProvenance(out.description);
  if (isPlainObject(out.price)) out.price = normalizeLooseObject(out.price);
  if (isPlainObject(out.shipping)) out.shipping = normalizeLooseObject(out.shipping);
  if (isPlainObject(out.buyers_premium)) out.buyers_premium = normalizeLooseObject(out.buyers_premium);
  if (isPlainObject(out.location)) out.location = normalizeLooseObject(out.location);
  if (isPlainObject(out.auction_end_time)) out.auction_end_time = normalizeLooseObject(out.auction_end_time);
  if (isPlainObject(out.page_signals)) out.page_signals = normalizeLooseObject(out.page_signals);

  return out;
}

function normalizeFieldProvenance(raw) {
  return {
    value: cleanText(raw.value ?? ''),
    source: cleanText(raw.source ?? 'unknown'),
    confidence: toBoundedScore(raw.confidence),
    raw: raw.raw == null ? null : raw.raw,
  };
}

function normalizeRecordLineage(raw, source) {
  const out = isPlainObject(raw) ? deepClone(raw) : {};

  out.extractor = cleanText(out.extractor || source || 'unknown');
  out.extractor_version = cleanText(out.extractor_version || 'unknown');
  out.extracted_at = parseDate(out.extracted_at) || new Date().toISOString();
  out.actor_run_id = cleanText(out.actor_run_id || '');
  out.actor_build_id = cleanText(out.actor_build_id || '');
  out.actor_task_id = cleanText(out.actor_task_id || '');
  out.input_fingerprint = cleanText(out.input_fingerprint || '');
  out.source_name = cleanText(out.source_name || source || 'unknown');
  out.discovered_from = cleanNullableText(out.discovered_from);
  out.keyword = cleanNullableText(out.keyword);
  out.seed_type = cleanNullableText(out.seed_type);

  return out;
}

function normalizeCurrency(raw) {
  const c = cleanText(raw || DEFAULTS.currency).toUpperCase();
  return c || DEFAULTS.currency;
}

function normalizePurchaseRecommendation(raw) {
  const value = cleanText(raw || DEFAULTS.purchaseRecommendation).toLowerCase();
  return value || DEFAULTS.purchaseRecommendation;
}

function toBoundedScore(raw) {
  const n = toFiniteNumber(raw);
  if (n == null) return null;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return roundTo2(n);
}

function deriveTotalEstimatedCost(record) {
  const base = record.current_price ?? 0;
  const shipping = record.estimated_shipping ?? 0;
  const premium = record.buyers_premium ?? 0;
  const tax = record.tax_estimate ?? 0;

  const total = base + shipping + premium + tax;
  return Number.isFinite(total) ? roundTo2(total) : null;
}

function buildDedupeKey(record) {
  return `${record.source}:${record.external_id}`;
}

function buildContentHash(record) {
  const contentShape = {
    source: record.source,
    external_id: record.external_id,
    title: record.title,
    category: record.category,
    condition: record.condition,
    current_price: record.current_price,
    buyers_premium: record.buyers_premium,
    estimated_shipping: record.estimated_shipping,
    shipping_weight: record.shipping_weight,
    shipping_weight_lbs: record.shipping_weight_lbs,
    auction_end_time: record.auction_end_time,
    location: record.location,
    // Omit image_urls from hash: headless browser DOM rendering race conditions 
    // cause the length of extracted image arrays to fluctuate randomly.
    attributes: record.attributes,
    source_meta: record.source_meta,
    record_type: record.record_type,
  };

  return sha256Hex(safeStableStringify(contentShape));
}

// ─────────────────────────────────────────────────────────────────────────────
// Main normalizer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize a raw extracted record into the governed acquisition schema.
 *
 * @param {object} raw
 * @param {string} sourceHint
 * @returns {object}
 */
export function normalizeRecord(raw, sourceHint) {
  if (!isPlainObject(raw)) {
    throw new TypeError(`normalizeRecord: expected object, got ${typeof raw}`);
  }

  const nowIso = new Date().toISOString();
  const source = normalizeSource(sourceHint || raw.source || 'unknown');
  const recordType = inferRecordType(source, raw);

  const externalId = cleanText(raw.external_id ?? raw.externalId ?? '');
  const title = cleanText(raw.title ?? '');
  const listingUrl = cleanText(raw.listing_url ?? raw.listingUrl ?? raw.url ?? '');

  if (!externalId) {
    throw new Error(`normalizeRecord: missing external_id for source=${source}`);
  }

  if (!title) {
    throw new Error(`normalizeRecord: missing title for source=${source} id="${externalId}"`);
  }

  const attributes = normalizeAttributes(raw.attributes ?? raw.specifications ?? raw.itemSpecifics ?? {});
  const sourceMeta = normalizeSourceMeta(raw.source_meta ?? raw.sourceMeta ?? {});
  const recordLineage = normalizeRecordLineage(raw.record_lineage ?? raw.recordLineage ?? {}, source);

  const normalized = {
    schema: cleanText(raw.schema || DEFAULTS.schema),
    schema_version: Number.isFinite(Number(raw.schema_version))
      ? Number(raw.schema_version)
      : DEFAULTS.schemaVersion,

    record_type: recordType,
    source,
    external_id: externalId,
    listing_url: listingUrl,

    title,
    category: cleanText(raw.category ?? ''),
    subcategory: cleanText(raw.subcategory ?? ''),
    condition: cleanText(raw.condition ?? ''),
    description: cleanText(raw.description ?? ''),

    current_price: roundTo2(toFiniteNumber(raw.current_price ?? raw.currentPrice ?? raw.price ?? 0) ?? 0),
    buyers_premium: toNonNegativeMoney(
      raw.buyers_premium ??
      raw.buyersPremium ??
      raw.premium ??
      raw.source_meta?.buyers_premium?.amount ??
      null,
    ),
    estimated_shipping: toNonNegativeMoney(
      raw.estimated_shipping ?? raw.estimatedShipping ?? raw.shipping ?? null,
    ),
    shipping_weight: cleanText(
      raw.shipping_weight ??
      raw.shippingWeight ??
      raw.source_meta?.shipping?.weight ??
      '',
    ),
    shipping_weight_lbs: toNonNegativeMoney(
      raw.shipping_weight_lbs ??
      raw.shippingWeightLbs ??
      raw.source_meta?.shipping?.weight_lbs ??
      null,
    ),
    tax_estimate: toNonNegativeMoney(raw.tax_estimate ?? raw.taxEstimate ?? null),
    total_estimated_cost: null,

    currency: normalizeCurrency(raw.currency ?? raw.attributes?.currency ?? DEFAULTS.currency),

    auction_end_time: parseDate(
      raw.auction_end_time ??
      raw.auctionEndTime ??
      raw.endTime ??
      raw.source_meta?.auction_end_time?.raw ??
      '',
    ),

    location: cleanText(raw.location ?? ''),
    image_urls: cleanImageUrls(raw.image_urls ?? raw.imageUrls ?? raw.images ?? []),
    primary_image_url: cleanNullableText(
      raw.primary_image_url ??
      raw.primaryImageUrl ??
      (Array.isArray(raw.image_urls) && raw.image_urls.length > 0 ? [...raw.image_urls].sort()[0] : null) ??
      (Array.isArray(raw.imageUrls) && raw.imageUrls.length > 0 ? [...raw.imageUrls].sort()[0] : null) ??
      null,
    ),

    attributes,
    source_meta: sourceMeta,
    record_lineage: recordLineage,

    median_comp_price: toNonNegativeMoney(raw.median_comp_price ?? raw.medianCompPrice ?? null),
    avg_comp_price: toNonNegativeMoney(raw.avg_comp_price ?? raw.avgCompPrice ?? null),
    estimated_ebay_fees: toNonNegativeMoney(raw.estimated_ebay_fees ?? raw.estimatedEbayFees ?? null),
    estimated_profit: toFiniteNumber(raw.estimated_profit ?? raw.estimatedProfit ?? null),
    estimated_margin_pct: toFiniteNumber(raw.estimated_margin_pct ?? raw.estimatedMarginPct ?? null),
    risk_score: toBoundedScore(raw.risk_score ?? raw.riskScore ?? null),
    confidence_score: toBoundedScore(raw.confidence_score ?? raw.confidenceScore ?? null),
    purchase_recommendation: normalizePurchaseRecommendation(
      raw.purchase_recommendation ?? raw.purchaseRecommendation ?? null,
    ),
    decision_reason: cleanText(raw.decision_reason ?? raw.decisionReason ?? ''),

    dedupe_key: '',
    content_hash: '',
    normalization_status: cleanText(raw.normalization_status || DEFAULTS.normalizationStatus),
    pipeline_stage: cleanText(raw.pipeline_stage || DEFAULTS.pipelineStage),

    scraped_at: parseDate(raw.scraped_at ?? raw.scrapedAt ?? nowIso) || nowIso,
    observed_at: parseDate(raw.observed_at ?? raw.observedAt ?? raw.scraped_at ?? nowIso) || nowIso,

    actor_run_id: cleanText(
      raw.actor_run_id ||
      recordLineage.actor_run_id ||
      '',
    ),
    actor_build_id: cleanText(
      raw.actor_build_id ||
      recordLineage.actor_build_id ||
      '',
    ),
    actor_task_id: cleanText(
      raw.actor_task_id ||
      recordLineage.actor_task_id ||
      '',
    ),
    input_fingerprint: cleanText(
      raw.input_fingerprint ||
      recordLineage.input_fingerprint ||
      '',
    ),
  };

  normalized.total_estimated_cost =
    toNonNegativeMoney(raw.total_estimated_cost ?? raw.totalEstimatedCost ?? null) ??
    deriveTotalEstimatedCost(normalized);

  normalized.dedupe_key = cleanText(raw.dedupe_key || buildDedupeKey(normalized));
  normalized.content_hash = cleanText(raw.content_hash || buildContentHash(normalized));

  return normalized;
}

// ─────────────────────────────────────────────────────────────────────────────
// Supabase aliases
// ─────────────────────────────────────────────────────────────────────────────

function toNum(v) {
  const n = toFiniteNumber(v);
  return n == null ? null : n;
}

const CATEGORY_RULES = [
  // ── Electronics sub-categories ──
  [/\b(iphone|cell\s*phone|smartphone|android\s*phone|galaxy\s*s|pixel\s*\d|oneplus|motorola)\b/i, 'mobile_phones'],
  [/\b(airpods|earbuds?|earphones?|tws\s*wireless|speaker|soundbar|boombox|audio|amplifier|radio)\b/i, 'audio_equipment'],
  [/\b(headset|headphones?|over-ear|on-ear)\b/i, 'headphones'],
  [/\b(drone|quadcopter|aerial\s*photography)\b/i, 'drones'],
  [/\b(nintendo|xbox|playstation|ps[345]|game\s*console|switch\s*oled)\b/i, 'game_consoles'],
  [/\b(video\s*game|game\s*cartridge|game\s*disc)\b/i, 'video_games'],
  [/\b(nikon|canon|camera|lens|nikkor|dslr|mirrorless|gopro)\b/i, 'cameras'],
  [/\b(laptop|macbook|chromebook|tablet|ipad|computer|apple\s*watch|smartwatch|smart\s*watch|desktop|monitor)\b/i, 'computing'],
  [/\b(router|modem|mesh\s*wifi|networking|access\s*point)\b/i, 'networking'],
  [/\b(tv|television|flat\s*screen|oled\s*display|smart\s*tv|projector)\b/i, 'televisions'],
  [/\b(ssd|hard\s*drive|flash\s*drive|usb\s*drive|memory\s*card|sd\s*card|storage\s*device)\b/i, 'storage_media'],
  [/\b(charger|adapter|cable|power\s*bank|power\s*supply|battery\s*pack|usb)\b/i, 'accessories_electronics'],

  // ── Vehicles ──
  [/\b(car|truck|van|suv|sedan|coupe|minivan|pickup|dodge|ford|chevrolet|chevy|toyota|honda|bmw|mercedes|audi|jeep|gmc|nissan|hyundai|kia|subaru|volkswagen|vw|lexus|infiniti|acura|cadillac|buick|chrysler|police\s*interceptor)\b/i, 'vehicles_cars_trucks'],
  [/\b(motorcycle|motorbike|harley|ducati|kawasaki|yamaha\s*(?:bike|motor)|suzuki\s*(?:bike|motor)|moped|scooter)\b/i, 'vehicles_motorcycles'],
  [/\b(atv|dirt\s*bike|quad|four\s*wheeler|utv|side.by.side)\b/i, 'vehicles_atvs'],
  [/\b(boat|watercraft|jet\s*ski|kayak|canoe|pontoon|sailboat|yacht)\b/i, 'vehicles_boats'],
  [/\b(trailer|heavy\s*equipment|excavator|forklift|tractor|bulldozer|backhoe|loader|municipal\s*vehicle)\b/i, 'vehicles_heavy_equipment'],

  // ── Jewelry & Watches ──
  [/\b(necklace|bracelet|ring|pendant|earring|brooch|fine\s*jewelry|diamond|gold\s*(?:chain|ring|necklace|bracelet)|silver\s*jewelry|gemstone|carat)\b/i, 'jewelry'],
  [/\b(watch|rolex|omega|seiko|citizen|casio|tissot|tag\s*heuer|breitling|fossil|wristwatch|timepiece)\b/i, 'watches'],

  // ── Fashion ──
  [/\b(handbag|purse|wallet|clutch|tote\s*bag|backpack|louis\s*vuitton|gucci|prada|coach|michael\s*kors)\b/i, 'fashion_bags'],
  [/\b(sneakers?|shoes?|boots?|sandals?|nike|adidas|jordan|new\s*balance|reebok|puma|converse)\b/i, 'fashion_footwear'],
  [/\b(jacket|coat|dress|shirt|pants|jeans|suit|clothing|apparel|hoodie|sweater)\b/i, 'fashion_clothing'],
  [/\b(sunglasses|eyeglasses|optical\s*frame|ray.ban|oakley)\b/i, 'sunglasses_eyewear'],

  // ── Tools & Equipment ──
  [/\b(drill|saw|wrench|tool\s*kit|jump\s*starter|tpms|power\s*tool|compressor|multimeter|plier|socket\s*set|ratchet|clamp|tool\s*set|inflator|cutter|sander|grinder)\b/i, 'tools_equipment'],

  // ── Musical Instruments ──
  [/\b(guitar|keyboard|piano|drum|synthesizer|midi|dj\s*controller|rane|pioneer\s*dj|violin|trumpet|saxophone|ukulele|bass\s*guitar|amplifier\s*guitar|pedal\s*board)\b/i, 'music_instruments'],

  // ── Bikes ──
  [/\b(bicycle|bike|mountain\s*bike|road\s*bike|e-?bike|electric\s*bike|cycling|bmx|trek|specialized|giant\s*bike|schwinn)\b/i, 'bikes'],

  // ── Coins & Bullion ──
  [/\b(coin|bullion|silver\s*bar|gold\s*bar|numismatic|mint\s*set|proof\s*set|silver\s*eagle|gold\s*eagle|morgan\s*dollar)\b/i, 'coins_bullion'],

  // ── Collectibles ──
  [/\b(collectible|memorabilia|antique|vintage|autograph|signed|sports\s*card|trading\s*card|figurine|action\s*figure|comic\s*book)\b/i, 'collectibles'],

  // ── Art ──
  [/\b(painting|sculpture|lithograph|art\s*print|canvas|artwork|oil\s*on|watercolor|acrylic|framed\s*print)\b/i, 'art'],

  // ── Health & Personal Care ──
  [/\b(toothbrush|oral.b|electric\s*shaver|razor|hair\s*dryer|curling\s*iron|straightener|massager|blood\s*pressure|thermometer|fitness\s*tracker|fitbit)\b/i, 'health_personal_care'],

  // ── Home & Garden ──
  [/\b(vacuum|roomba|robot\s*vacuum|air\s*purifier|humidifier|dehumidifier|fan|heater|blender|mixer|coffee\s*maker|instant\s*pot|kitchen|cookware|furniture)\b/i, 'home_garden'],

  // ── Bulk Lots (broad catch — must be after specific rules) ──
  [/\bbulk\s*lot\b/i, 'bulk_lots'],
];

/**
 * Slugify a raw category string into a snake_case key.
 * e.g. "Tools & Equipment" → "tools_equipment"
 *      "Cars, Trucks, Vans" → "cars_trucks_vans"
 */
function slugifyCategory(raw) {
  if (!raw) return null;
  const slug = raw
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
  return slug || null;
}

// Map breadcrumb slugs and non-standard keys to watchlist-standard keys
const CATEGORY_ALIAS_MAP = {
  // Gaming
  gaming_systems_and_games: 'game_consoles',
  // Cameras
  digital_and_slr_cameras: 'cameras',
  video_cameras: 'cameras',
  other_photography: 'cameras',
  // Tools
  tools_equipment: 'tools_small',
  tools_and_equipment: 'tools_small',
  other_tools_and_equipment: 'tools_small',
  // Audio
  speakers: 'audio_equipment',
  blu_ray_dvd_cd_players: 'audio_equipment',
  // Computing
  tvs: 'computing',
  accessories_electronics: 'computing',
  accessories_and_software: 'computing',
  storage_media: 'computing',
  // Eyewear
  sunglasses_eyewear: 'sunglasses',
  // Vehicles
  cars_trucks_vans: 'vehicles_cars_trucks',
  atvs_and_dirt_bikes: 'vehicles_atvs',
  // Catch-all breadcrumb slugs that should map to broader categories
  bulk_lots_and_other_electronics: 'bulk_lots',
  parts_and_accessories: 'accessories_electronics',
  accessories_and_parts: 'accessories_electronics',
};

function normalizeCategoryKey(rawCategory, title) {
  const text = `${rawCategory || ''} ${title || ''}`.toLowerCase();
  for (const [re, key] of CATEGORY_RULES) {
    if (re.test(text)) {
      return CATEGORY_ALIAS_MAP[key] || key;
    }
  }
  // Fallback: slugify the raw breadcrumb category, then check alias map
  const slug = slugifyCategory(rawCategory);
  if (slug && CATEGORY_ALIAS_MAP[slug]) return CATEGORY_ALIAS_MAP[slug];
  return slug;
}

export function addSupabaseAliases(record) {
  record.listing_external_id = record.external_id;
  record.condition_text = record.condition ?? '';
  record.end_time = record.auction_end_time ?? '';
  record.buy_now_price =
    toNum(record.source_meta?.price?.buy_now_price) ??
    toNum(record.attributes?.trusted?.prices?.buy_now_price) ??
    toNum(record.attributes?.prices?.buy_now_price) ??
    null;

  record.inbound_shipping_usd = toNum(record.estimated_shipping);
  record.inbound_shipping_weight_lbs = toNum(record.shipping_weight_lbs);
  record.inbound_tax_usd = toNum(record.tax_estimate);
  record.inbound_fees_usd = toNum(record.buyers_premium);
  record.photo_urls = Array.isArray(record.image_urls) ? record.image_urls : [];
  record.images = record.photo_urls;

  // Preserve original human-readable category before overwriting
  record.raw_category = record.category || '';
  record.source_category_key = normalizeCategoryKey(record.category, record.title) ?? null;
  // category field sent to webhook/SQL = normalized key (never null if breadcrumb existed)
  record.category = record.source_category_key;

  // Brand / model — prefer structured description attributes, fall back to title parsing
  const trusted = record.attributes?.trusted ?? {};
  const attrBrand = cleanNullableText(trusted['Brand'] ?? trusted['brand'] ?? null);
  const titleBrand = extractBrandFromTitle(record.title ?? '');
  record.brand = attrBrand ?? titleBrand ?? null;

  const attrModel =
    cleanNullableText(trusted['Model name'] ?? trusted['Model Name'] ?? trusted['Model'] ?? null);
  record.model = attrModel ?? null;

  const attrMpn =
    cleanNullableText(trusted['Model number'] ?? trusted['Model Number'] ?? trusted['MPN'] ?? trusted['mpn'] ?? null);
  record.mpn = attrMpn ?? null;

  // Extra helpful aliases for SQL / db procedures
  record.schema_name = record.schema;
  record.record_family = record.record_type;
  record.run_id = record.actor_run_id || null;

  return record;
}

const BRAND_TITLE_MAP = [
  'Apple', 'Dell', 'Samsung', 'Sony', 'Nintendo', 'Microsoft', 'HP', 'Lenovo',
  'Canon', 'Nikon', 'Bose', 'Dyson', 'DeWalt', 'Bosch', 'Garmin', 'Fitbit',
  'JBL', 'LG', 'Panasonic', 'GoPro', 'Logitech', 'Asus', 'Acer', 'Razer',
  'Howard Medical', 'Motorola', 'Google', 'Amazon', 'Roku', 'Beats', 'Jabra',
  'Anker', 'Belkin', 'Philips', 'Whirlpool', 'KitchenAid', 'iRobot', 'Shark',
  'Milwaukee', 'Makita', 'Stanley', 'Craftsman', 'Ryobi', 'Black+Decker',
];

function extractBrandFromTitle(title) {
  if (!title) return null;
  const t = title.trim();
  for (const brand of BRAND_TITLE_MAP) {
    if (t.toLowerCase().startsWith(brand.toLowerCase() + ' ') || t.toLowerCase() === brand.toLowerCase()) {
      return brand;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

export function validateRecord(record) {
  const errors = [];

  if (!isPlainObject(record)) {
    return { valid: false, errors: ['record is not a plain object'] };
  }

  // Required governed fields
  for (const field of [
    'schema',
    'source',
    'record_type',
    'external_id',
    'title',
    'currency',
    'scraped_at',
    'observed_at',
    'normalization_status',
    'pipeline_stage',
    'dedupe_key',
    'content_hash',
  ]) {
    if (typeof record[field] !== 'string' || record[field].length === 0) {
      errors.push(`${field}: must be a non-empty string`);
    }
  }

  if (!Number.isInteger(record.schema_version) || record.schema_version < 1) {
    errors.push('schema_version: must be a positive integer');
  }

  if (!ALLOWED_SOURCES.has(record.source)) {
    errors.push(`source: unsupported value "${record.source}"`);
  }

  if (!ALLOWED_RECORD_TYPES.has(record.record_type)) {
    errors.push(`record_type: unsupported value "${record.record_type}"`);
  }

  for (const field of [
    'listing_url',
    'category',
    'subcategory',
    'condition',
    'description',
    'shipping_weight',
    'auction_end_time',
    'location',
    'decision_reason',
    'purchase_recommendation',
    'actor_run_id',
    'actor_build_id',
    'actor_task_id',
    'input_fingerprint',
  ]) {
    if (typeof record[field] !== 'string') {
      errors.push(`${field}: must be a string`);
    }
  }

  for (const field of ['current_price']) {
    if (typeof record[field] !== 'number' || !Number.isFinite(record[field])) {
      errors.push(`${field}: must be a finite number`);
    }
  }

  for (const field of [
    'buyers_premium',
    'estimated_shipping',
    'shipping_weight_lbs',
    'tax_estimate',
    'total_estimated_cost',
    'median_comp_price',
    'avg_comp_price',
    'estimated_ebay_fees',
    'estimated_profit',
    'estimated_margin_pct',
    'risk_score',
    'confidence_score',
  ]) {
    if (
      record[field] !== null &&
      (typeof record[field] !== 'number' || !Number.isFinite(record[field]))
    ) {
      errors.push(`${field}: must be a finite number or null`);
    }
  }

  if (record.risk_score !== null && (record.risk_score < 0 || record.risk_score > 1)) {
    errors.push('risk_score: must be between 0 and 1');
  }

  if (
    record.confidence_score !== null &&
    (record.confidence_score < 0 || record.confidence_score > 1)
  ) {
    errors.push('confidence_score: must be between 0 and 1');
  }

  for (const field of ['scraped_at', 'observed_at']) {
    if (typeof record[field] !== 'string' || !record[field]) {
      errors.push(`${field}: must be a non-empty ISO date string`);
    } else if (Number.isNaN(new Date(record[field]).getTime())) {
      errors.push(`${field}: must be a valid ISO date string`);
    }
  }

  if (typeof record.auction_end_time !== 'string') {
    errors.push('auction_end_time: must be a string');
  } else if (record.auction_end_time && Number.isNaN(new Date(record.auction_end_time).getTime())) {
    errors.push('auction_end_time: must be empty or a valid ISO date string');
  }

  if (!Array.isArray(record.image_urls)) {
    errors.push('image_urls: must be an array');
  } else {
    for (let i = 0; i < record.image_urls.length; i += 1) {
      if (typeof record.image_urls[i] !== 'string') {
        errors.push(`image_urls[${i}]: must be a string`);
        break;
      }
    }
  }

  if (record.primary_image_url !== null && typeof record.primary_image_url !== 'string') {
    errors.push('primary_image_url: must be a string or null');
  }

  if (!isPlainObject(record.attributes)) {
    errors.push('attributes: must be a plain object');
  } else {
    if (!isPlainObject(record.attributes.trusted)) {
      errors.push('attributes.trusted: must be a plain object');
    }
    if (!isPlainObject(record.attributes.mined)) {
      errors.push('attributes.mined: must be a plain object');
    }
  }

  if (!isPlainObject(record.source_meta)) {
    errors.push('source_meta: must be a plain object');
  }

  if (!isPlainObject(record.record_lineage)) {
    errors.push('record_lineage: must be a plain object');
  }

  if (!/^[a-f0-9]{64}$/i.test(record.content_hash)) {
    errors.push('content_hash: must be a 64-char sha256 hex string');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Backward-compatible exports
// ─────────────────────────────────────────────────────────────────────────────

export function parseCurrency(raw) {
  return toNonNegativeMoney(raw) ?? 0;
}