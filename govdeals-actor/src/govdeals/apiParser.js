/**
 * Maps GovDeals JSON API responses (search row + item detail + bid box) to the
 * "raw" record shape the shared normalizer expects (same shape the legacy HTML parser produced).
 * normalize / dedupe / fingerprint / eligibility / health are unchanged.
 */
import { createHash } from 'node:crypto';
import { cleanText, inferAuctionStatus, timeRemainingSeconds } from './text.js';
import { detectEligibility } from './eligibility.js';
import { extractLogisticsSignals } from './logistics.js';
import { detectDefects } from './defects.js';
import { PHOTO_BASE, SITE_BASE } from './api.js';

// ── helpers ────────────────────────────────────────────────────────────────
export function stripHtml(html) {
  return cleanText(
    String(html ?? '')
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6])>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"').replace(/&#0?39;|&apos;/gi, "'"),
  );
}

export function toIsoUtc(value) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(s);
  const d = new Date(hasZone ? s : `${s}Z`); // API field is "Utc": treat zone-less values as UTC
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function num(value) {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}

function int(value) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? n : null;
}

function firstMoney(objects, keys) {
  for (const obj of objects) {
    for (const key of keys) {
      const value = num(obj?.[key]);
      if (value != null) return { value, key };
    }
  }
  return { value: null, key: null };
}

function cheapestShippingCost(detail) {
  const values = [];
  const costKeys = /^(?:amount|cost|price|shippingcost|shippingamount|shippingprice|shippingfee|fee|feeamount|rate|value)$/i;
  const walk = (node, inShipping = false, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 8) return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child, inShipping, depth + 1);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      const shippingContext = inShipping || /shipping|shipoption|deliveryoption/i.test(key);
      if (shippingContext && costKeys.test(key.replace(/[_\s-]/g, '')) && (typeof value === 'number' || typeof value === 'string')) {
        const amount = num(value);
        if (amount != null) values.push(amount);
      }
      if (value && typeof value === 'object') walk(value, shippingContext, depth + 1);
    }
  };
  walk(detail);
  return values.length ? Math.min(...values) : null;
}

function str(value) {
  const s = cleanText(value);
  return s || null;
}

function normalizedLabel(value) {
  return String(value ?? '').toLowerCase().replace(/\s*#(?=\s|$)/g, ' number').replace(/[^a-z0-9]+/g, ' ').trim();
}

function firstSpecValue(specs, labels) {
  const wanted = new Set(labels.map(normalizedLabel));
  for (const [label, value] of Object.entries(specs || {})) {
    if (wanted.has(normalizedLabel(label)) && str(value)) return str(value);
  }
  return null;
}

function firstApiValue(objects, keys) {
  for (const obj of objects) for (const key of keys) if (str(obj?.[key])) return str(obj[key]);
  return null;
}

export function photoUrl(entry, accountId = null) {
  let path = null;
  if (typeof entry === 'string') path = entry;
  else if (entry && typeof entry === 'object') {
    for (const k of ['photoUrl', 'url', 'path', 'photoPath', 'assetPhotoUrl', 'fileName', 'photo', 'imageUrl']) {
      if (typeof entry[k] === 'string' && entry[k]) { path = entry[k]; break; }
    }
  }
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  // Bare file name (no folder): files live at /photos/{accountId}/{file}. Anything else is used as given.
  if (!path.includes('/') && accountId) return `${PHOTO_BASE}/photos/${accountId}/${path}`;
  return `${PHOTO_BASE}${path.startsWith('/') ? '' : '/'}${path}`;
}

/**
 * Flatten assetAttributeGroups into { label: value }.
 * The exact response shape is not yet confirmed, so this walks arrays/objects and
 * accepts common label/value key pairs. Verify against the first recorded canary response.
 */
const LABEL_KEYS = ['attributeName', 'attributeLabel', 'label', 'name', 'displayName', 'title', 'key'];
const VALUE_KEYS = ['attributeValue', 'displayValue', 'value', 'attributeValueText', 'text', 'val'];
export function flattenAttributes(groups) {
  const out = {};
  const walk = (node, depth = 0) => {
    if (node == null || depth > 6) return;
    if (Array.isArray(node)) { node.forEach((n) => walk(n, depth + 1)); return; }
    if (typeof node !== 'object') return;
    const labelKey = LABEL_KEYS.find((k) => typeof node[k] === 'string' && node[k].trim());
    const valueKey = VALUE_KEYS.find((k) => node[k] != null && typeof node[k] !== 'object' && String(node[k]).trim() !== '');
    if (labelKey && valueKey) {
      const label = cleanText(node[labelKey]).replace(/\s*:$/, '');
      const value = cleanText(node[valueKey]);
      if (label && value && !(label in out)) out[label] = value;
    }
    for (const v of Object.values(node)) if (v && typeof v === 'object') walk(v, depth + 1);
  };
  walk(groups);
  return out;
}

// ── identity ───────────────────────────────────────────────────────────────
export function assetIdentity(row) {
  const assetId = row?.assetId != null ? String(row.assetId).trim() : '';
  const accountId = row?.accountId != null ? String(row.accountId).trim() : '';
  if (!assetId || !accountId) return null;
  return {
    assetId,
    sellerAccountId: accountId,
    externalId: `govdeals-${accountId}-${assetId}`,
    canonicalUrl: `${SITE_BASE}/en/asset/${assetId}/${accountId}`,
    lotNumberDerived: `${accountId}-${assetId}`,
  };
}

/** Cheap fingerprint of the search row; decides whether detail+fees must be re-fetched. */
export function searchFingerprint(row) {
  const shape = [
    row.assetShortDescription, row.currentBid, row.assetAuctionEndDateUtc, row.categoryDescription,
    row.makebrand, row.model, row.modelYear, row.locationCity, row.locationState, row.locationZip,
    row.companyName, row.isReserveNotMet, row.lotNumber, row.photo,
  ];
  return createHash('sha256').update(JSON.stringify(shape)).digest('hex').slice(0, 32);
}

// ── bid box ────────────────────────────────────────────────────────────────
function pick(obj, keys) {
  for (const k of keys) if (obj && obj[k] != null && obj[k] !== '') return obj[k];
  return null;
}

/**
 * Read the bid box response. premiumPercent and requirements are confirmed by Tictac.
 * The other key names are not yet confirmed, so a few likely candidates are accepted;
 * verify with the recorded FIXTURE_bidbox_* response.
 */
export function readBidbox(bb) {
  if (!bb || typeof bb !== 'object') return null;
  const startRaw = pick(bb, ['auctionStartDateUtc', 'auctionStartDate', 'assetAuctionStartDateUtc', 'assetAuctionStartDate', 'startDate', 'startDateUtc', 'auctionStart']);
  return {
    premiumPercent: num(pick(bb, ['premiumPercent', 'buyerPremiumPercent', 'buyersPremiumPercent'])),
    requirements: str(stripHtml(pick(bb, ['requirements', 'bidRequirements', 'bidderRequirements']))),
    bidCount: int(pick(bb, ['bidCount', 'numberOfBids', 'totalBids', 'bids'])),
    bidIncrement: num(pick(bb, ['bidIncrement', 'minimumBidIncrement', 'bidIncrementAmount', 'minBidIncrement', 'incrementAmount'])),
    startIso: toIsoUtc(startRaw),
  };
}

/** Bidder restrictions from the bid box "requirements" text. Any requirement text means account review. */
export function eligibilityFromRequirements(text) {
  const t = cleanText(text);
  if (!t) return detectEligibility('');
  const lower = t.toLowerCase();
  let code = 'RESTRICTED';
  if (/business|entit|compan|corporat|dealer|licen[sc]|resale|wholesale/.test(lower)) code = 'BUSINESS_ENTITY_ONLY';
  const base = detectEligibility(t); // keep the existing codes (LOCKED, ACCOUNT_SETUP_REQUIRED, ...) when they match
  if (base.bidding_eligibility !== 'UNKNOWN') return base;
  return {
    bidding_allowed: null, // unknown for our account until reviewed
    bidding_eligibility: code,
    bidding_restriction_message: t,
    requires_account_review: true,
    account_restriction_detected: true,
    seller_restriction_detected: true,
  };
}

// ── main mapping ───────────────────────────────────────────────────────────
export function buildRawRecord({ row, detail = {}, bidbox = null, fees = null, observedAt = new Date().toISOString() }) {
  const id = assetIdentity(row);
  if (!id) throw new Error('GovDeals search row missing assetId/accountId');

  const title = str(row.assetShortDescription) || str(detail.assetShortDescription);
  if (!title) throw new Error('GovDeals record missing title');

  const specs = flattenAttributes(detail.assetAttributeGroups);
  const specCondition = specs.Condition || specs.condition || null;
  const rawCondition = str(specCondition) || str(detail.assetConditionCd);
  const condition = rawCondition || 'UNKNOWN';

  const endIso = toIsoUtc(row.assetAuctionEndDateUtc) || toIsoUtc(detail.assetAuctionEndDate);
  const displayedBid = num(row.currentBid);

  const city = str(detail.city) || str(row.locationCity);
  const state = str(detail.state) || str(row.locationState);
  const zip = str(detail.zipCode) || str(row.locationZip);
  const location = cleanText([city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', '));
  const pickupLocation = cleanText([str(detail.addressLine1), location].filter(Boolean).join(', ')) || null;

  const description = stripHtml(detail.assetLongDesc);
  const inspection = str(stripHtml(detail.inspectionInstructions));
  const payment = str(stripHtml(detail.paymentInstructions));
  const removal = str(stripHtml(detail.removalInstructions));
  const special = str(stripHtml(detail.specialInstructions));
  const logisticsText = cleanText([title, description, inspection, payment, removal, special].filter(Boolean).join('. '));
  const logistics = extractLogisticsSignals(logisticsText);
  const bb = readBidbox(bidbox);
  const eligibility = eligibilityFromRequirements(bb?.requirements);
  const defects = detectDefects(cleanText([title, description, condition].filter(Boolean).join(' ')));

  const detailPhotos = (Array.isArray(detail.assetPhotos) ? detail.assetPhotos : [])
    .map((p) => photoUrl(p, id.sellerAccountId)).filter(Boolean);
  // Search-row thumbnail only as a fallback when the detail call has no photos.
  const photos = [...new Set(detailPhotos.length ? detailPhotos : [photoUrl(row.photo, id.sellerAccountId)].filter(Boolean))];
  const primaryImage = photos[0] ?? null; // first detail photo in API order (not alphabetical)

  const bidCount = bb?.bidCount ?? int(row.bidCount);
  const opening = firstMoney([row, detail, bidbox], [
    'startingBid', 'startingBidAmount', 'startingPrice', 'startingPriceAmount',
    'openingBid', 'openingBidAmount', 'openingPrice', 'openingPriceAmount', 'initialBid', 'initialBidAmount',
  ]);
  const buyNow = firstMoney([row, detail, bidbox], [
    'buyNowPrice', 'buyNowPriceAmount', 'assetBuyNowPrice', 'buyNowAmount', 'buyNow', 'buyItNowPrice', 'buyItNowAmount',
  ]);
  let currentPrice = null;
  let priceType = null;
  let priceSource = null;
  if (bidCount === 0) {
    if (opening.value != null) {
      currentPrice = opening.value;
      priceType = 'starting_bid';
      priceSource = opening.key;
    } else if (displayedBid != null && displayedBid > 0) {
      // GovDeals search's displayed currentBid is the only published bid amount on
      // the listing when no bids exist; retain it as the opening amount.
      currentPrice = displayedBid;
      priceType = 'starting_bid';
      priceSource = 'currentBid_no_bids';
    } else if (buyNow.value != null) {
      currentPrice = buyNow.value;
      priceType = 'buy_now';
      priceSource = buyNow.key;
    }
  } else if (displayedBid != null && (displayedBid > 0 || buyNow.value == null)) {
    currentPrice = displayedBid;
    priceType = 'current_bid';
    priceSource = 'currentBid';
  } else if (opening.value != null) {
    currentPrice = opening.value;
    priceType = 'starting_bid';
    priceSource = opening.key;
  } else if (buyNow.value != null) {
    currentPrice = buyNow.value;
    priceType = 'buy_now';
    priceSource = buyNow.key;
  }

  // Buyer's premium: bid box premiumPercent x current bid (dollar amount). The fees endpoint returned 0 and is not used.
  const premiumPercent = bb?.premiumPercent ?? null;
  let feeTotal = null;
  let premiumSource = null;
  if (premiumPercent != null && currentPrice != null && currentPrice > 0) {
    feeTotal = Math.round(currentPrice * premiumPercent) / 100;
    premiumSource = 'GOVDEALS_BIDBOX_API';
  } else if (fees) {
    const legacy = num(fees.totalFeeSumAmount) ?? num(fees.adminFeeAmount);
    if (legacy != null && legacy > 0) { feeTotal = legacy; premiumSource = 'GOVDEALS_FEES_API'; }
  }
  const feeBlock = fees ? {
    admin_fee_percent: num(fees.adminFeePercent), admin_fee_amount: num(fees.adminFeeAmount),
    total_fee_sum_amount: num(fees.totalFeeSumAmount),
    additional_fees: Array.isArray(fees.additionalFees) ? fees.additionalFees : [],
  } : null;

  const lotNumber = str(row.lotNumber) || id.lotNumberDerived;
  const make = str(row.makebrand) || str(specs.Brand) || str(specs.Manufacturer) || str(specs.Make) || str(specs['Manufacturer/Brand']);
  const model = str(row.model) || firstSpecValue(specs, ['Model', 'Model Name']);
  const explicitMpn = firstSpecValue(specs, [
    'MPN', 'Part Number', 'Part No', 'Part #', 'Manufacturer Part Number',
    'Model Number', 'Model No', 'Model #', 'Catalog Number', 'Catalog No', 'Catalog #',
  ]) || firstApiValue([row, detail], [
    'mpn', 'MPN', 'partNumber', 'partNo', 'manufacturerPartNumber', 'modelNumber', 'catalogNumber',
  ]);
  // A coded Model value is a useful MPN fallback; free-text model names are not.
  const modelCodeMpn = model && /\d/.test(model) ? model : null;
  const modelNumber = explicitMpn || modelCodeMpn;
  const year = str(row.modelYear);
  const serialOrVin = str(detail.vinserial);
  const vin = str(detail.vin) || (serialOrVin && /^[A-HJ-NPR-Z0-9]{17}$/i.test(serialOrVin) ? serialOrVin : null);
  const serial = str(detail.serialNumber) || (serialOrVin && !vin ? serialOrVin : null);
  const meter = str(detail.meterCount);
  const status = inferAuctionStatus('', endIso, new Date(observedAt));
  const reserveNotMet = row.isReserveNotMet === true;
  const bidIncrement = bb?.bidIncrement ?? null;
  const startIso = bb?.startIso ?? toIsoUtc(row.assetAuctionStartDateUtc ?? row.auctionStartDateUtc ?? detail.assetAuctionStartDateUtc ?? detail.auctionStartDateUtc);
  // Missing from an API response is not proof that the website itself omits the date.
  // Keep it visibly unverified so validation can block the lot pending page review.
  const startTimeSource = bb?.startIso ? 'govdeals_bidbox_api' : startIso ? 'govdeals_api' : 'not_observed_in_api';
  const explicitWillShip = [row?.willShip, detail?.willShip, bidbox?.willShip];
  const publishedShippingCost = cheapestShippingCost({ row, detail, bidbox });
  const negativeShippingWins = logistics.shipping_method === 'pickup_only';
  const freeShippingPublished = !negativeShippingWins && logistics.shipping_method === 'free_shipping';
  const textShippingCost = logistics.text_shipping_cost;
  const observedShippingCost = [publishedShippingCost, textShippingCost].filter((v) => v != null).sort((a, b) => a - b)[0] ?? null;
  const estimatedShipping = negativeShippingWins ? null : freeShippingPublished ? 0 : observedShippingCost;
  const shippingAvailable = negativeShippingWins ? false
    : freeShippingPublished || observedShippingCost != null || logistics.shipping_available === true || explicitWillShip.includes(true) ? true
      : explicitWillShip.includes(false) || logistics.pickup_required === true ? false : null;
  const shippingMethod = negativeShippingWins ? 'pickup_only'
    : freeShippingPublished ? 'free_shipping'
      : observedShippingCost != null ? 'shipping'
        : logistics.shipping_method === 'shipping_quote' || explicitWillShip.includes(true) ? 'shipping_quote'
          : explicitWillShip.includes(false) || logistics.pickup_required === true ? 'pickup_only' : 'shipping_quote';
  const shippingCostSource = freeShippingPublished ? 'govdeals_published_free_shipping_text'
    : publishedShippingCost != null ? 'govdeals_api_shipping_option'
    : textShippingCost != null ? 'govdeals_shipping_price_text'
      : null;
  const shippingEvidence = logistics.shipping_evidence;
  const seller = str(row.companyName);
  const auctionId = detail.auctionId != null ? String(detail.auctionId) : null;

  return {
    source: 'govdeals',
    record_type: 'auction_listing',
    external_id: id.externalId,
    asset_id: id.assetId,
    seller_account_id: id.sellerAccountId,
    auction_id: auctionId,
    lot_number: lotNumber,
    listing_url: id.canonicalUrl,
    canonical_url: id.canonicalUrl,
    title,
    description,
    category: str(row.categoryDescription) || '',
    subcategory: '',
    manufacturer: make, brand: make, model, mpn: modelNumber, serial_number: serial, year,
    condition,
    raw_condition: rawCondition,
    current_price: currentPrice,
    buy_now_price: buyNow.value,
    starting_price: opening.value ?? (bidCount === 0 && displayedBid > 0 ? displayedBid : null),
    price_type: priceType,
    bid_increment: bidIncrement,
    bid_count: bidCount,
    reserve_status: reserveNotMet ? 'NOT_MET' : null,
    reserve_met: reserveNotMet ? false : null,
    buyers_premium: feeTotal,
    buyers_premium_source: premiumSource,
    buyers_premium_confidence: feeTotal != null ? 1 : null,
    buyers_premium_percent: premiumPercent,
    tax_estimate: null,
    total_estimated_cost: null,
    estimated_shipping: estimatedShipping,
    shipping_method: shippingMethod,
    shipping_available: shippingAvailable,
    pickup_required: logistics.pickup_required,
    pickup_location: pickupLocation,
    location,
    seller_name: seller, seller_agency: seller, seller_type: null,
    auction_start_time: startIso,
    auction_start_time_source: startTimeSource,
    auction_end_time: endIso,
    auction_status: status,
    time_remaining_seconds: timeRemainingSeconds(endIso, observedAt),
    inspection_available: inspection ? true : null,
    inspection_details: inspection || logistics.inspection_details || null,
    payment_terms: payment || logistics.payment_terms || null,
    removal_requirements: removal || logistics.removal_requirements || null,
    special_instructions: special,
    currency: 'USD',
    image_urls: photos,
    primary_image_url: primaryImage,
    documents: [],
    ...eligibility,
    ...defects,
    source_meta: {
      transport: 'govdeals_api',
      business_id: str(row.businessId),
      price: { value: currentPrice, type: priceType, source: priceSource || 'govdeals_api', buy_now_price: buyNow.value, starting_price: opening.value },
      condition: { value: condition, source: specCondition ? 'govdeals_detail_attributes' : 'govdeals_detail_condition_code', raw: rawCondition },
      location: { value: location || null, source: 'govdeals_detail_api' },
      auction_end_time: { value: endIso, source: 'govdeals_search_api' },
      buyers_premium: { amount: feeTotal, percent: premiumPercent, source: premiumSource, confidence: feeTotal != null ? 1 : null },
      fees: feeBlock,
      asset_id: id.assetId,
      seller_account_id: id.sellerAccountId,
      auction_id: auctionId,
      event_id: auctionId,
      sale_event_title: str(detail.saleEventTitle),
      lot_number: lotNumber,
      bid_count: bidCount,
      reserve_status: reserveNotMet ? 'NOT_MET' : null,
      auction_status: status,
      seller_name: seller,
      shipping_available: shippingAvailable,
      shipping: { estimated_cost: estimatedShipping, source: shippingCostSource },
      shipping_method: shippingMethod,
      shipping_evidence: shippingEvidence,
      serial_number: serial || undefined,
      vin: vin || undefined,
      pickup_required: logistics.pickup_required,
      pickup_location: pickupLocation,
      bidding_eligibility: eligibility.bidding_eligibility,
      bidding_allowed: eligibility.bidding_allowed,
      bidding_restriction_message: eligibility.bidding_restriction_message,
      requires_account_review: eligibility.requires_account_review,
      defects,
    },
    attributes: {
      price_type: priceType,
      bid_count: bidCount,
      auction_start_time_source: startTimeSource,
      shipping_evidence: shippingEvidence,
      serial_number: serial || undefined,
      vin: vin || undefined,
      trusted: {
        Brand: make || undefined, Model: model || undefined, 'Model number': modelNumber || undefined,
        MPN: explicitMpn || undefined, 'Part Number': explicitMpn || undefined,
        manufacturer: make || undefined, model: model || undefined, serial_number: serial || undefined, vin: vin || undefined,
        year: year || undefined, meter_count: meter || undefined, lot_number: lotNumber,
        specs: Object.keys(specs).length ? specs : undefined,
      },
      mined: { ...defects },
    },
    source_record: { search: row, detail, bidbox },
    normalization_status: !startIso || currentPrice == null || !endIso ? 'incomplete' : 'valid',
    pipeline_stage: !startIso ? 'source_incomplete' : 'source_extracted',
    scraped_at: observedAt,
    observed_at: observedAt,
  };
}