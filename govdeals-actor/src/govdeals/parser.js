import { load } from 'cheerio';
import { cleanText, integer, money, parseUtcParenthetical, parseDateLoose, inferAuctionStatus, timeRemainingSeconds } from './text.js';
import { parseAssetIdentity, canonicalizeGovDealsUrl } from './url.js';
import { detectEligibility } from './eligibility.js';
import { extractLogisticsSignals } from './logistics.js';

function allText($) { return cleanText($.root().text()); }

function absoluteUrl(raw, base) {
  try { return new URL(raw, base).toString(); } catch { return null; }
}

function nearestCardText($, anchor) {
  const candidates = [
    anchor.closest('article'), anchor.closest('li'), anchor.closest('[class*="card"]'),
    anchor.closest('[class*="asset"]'), anchor.parent().parent().parent(), anchor.parent().parent(), anchor.parent(),
  ];
  for (const c of candidates) {
    const t = cleanText(c.text());
    if (t && t.length >= 20) return t;
  }
  return cleanText(anchor.text());
}

export function parseSearchPage(html, pageUrl) {
  const $ = load(html);
  const seen = new Set();
  const items = [];

  $('a[href*="/asset/"]').each((_, el) => {
    const a = $(el);
    const href = absoluteUrl(a.attr('href'), pageUrl);
    const id = href && parseAssetIdentity(href);
    if (!id || seen.has(id.externalId)) return;
    seen.add(id.externalId);

    const cardText = nearestCardText($, a);
    const title = cleanText(a.attr('title') || a.text());
    const lot = cardText.match(/Lot#:\s*([\w-]+)/i)?.[1] || id.lotNumberDerived;
    const event = cardText.match(/Event ID\s*#?:\s*(GD-Event\s*\d+)/i)?.[1] || null;
    const currentPrice = money(cardText.match(/USD\s*[\d,.]+/i)?.[0]);
    const endTime = parseUtcParenthetical(cardText);
    const location = cardText.match(/([A-Za-z .'-]+,\s*[A-Za-z .'-]+,\s*(?:USA|Canada))/i)?.[1] || null;

    items.push({
      ...id,
      listingUrl: canonicalizeGovDealsUrl(href),
      title: title || null,
      lotNumber: lot,
      eventId: event,
      currentPrice,
      auctionEndTime: endTime,
      location: location ? cleanText(location) : null,
      indexText: cardText,
    });
  });

  const pagination = [];
  $('a[href]').each((_, el) => {
    const href = absoluteUrl($(el).attr('href'), pageUrl);
    if (!href) return;
    try {
      const u = new URL(href);
      if (!/govdeals\.com$/i.test(u.hostname)) return;
      if (!/\/search/i.test(u.pathname)) return;
      const text = cleanText($(el).text()).toLowerCase();
      if (/^(next|>|›|»)$/.test(text) || /page|offset|cursor|start/i.test(u.search)) pagination.push(href);
    } catch { /* ignore */ }
  });

  return { items, pagination: [...new Set(pagination)] };
}

function sectionText($, headingPattern) {
  const headings = $('h2,h3,h4,h5').filter((_, el) => headingPattern.test(cleanText($(el).text())));
  const h = headings.first();
  if (!h.length) return null;
  const parts = [];
  let node = h.next();
  while (node.length) {
    if (/^H[1-5]$/i.test(node[0]?.tagName || '')) break;
    const t = cleanText(node.text());
    if (t) parts.push(t);
    node = node.next();
    if (parts.join(' ').length > 12000) break;
  }
  return parts.length ? cleanText(parts.join(' ')) : null;
}

function extractTablePairs($) {
  const pairs = {};
  $('tr').each((_, tr) => {
    const cells = $(tr).find('th,td').map((__, c) => cleanText($(c).text())).get().filter(Boolean);
    if (cells.length >= 2 && cells[0].length < 100) pairs[cells[0].replace(/\s*:$/, '')] = cells.slice(1).join(' | ');
  });
  $('dt').each((_, dt) => {
    const key = cleanText($(dt).text()).replace(/\s*:$/, '');
    const value = cleanText($(dt).next('dd').text());
    if (key && value) pairs[key] = value;
  });
  return pairs;
}

function textAfterLabel(text, label, max = 220) {
  const re = new RegExp(`${label}\\s*:?\\s*([^]{0,${max}})`, 'i');
  const m = text.match(re);
  if (!m) return null;
  return cleanText(m[1].split(/(?:Seller|Description|Inspection|Payment|Removal|Special Instructions|Bid History)/i)[0]);
}

function extractImages($, pageUrl, title) {
  const out = [];
  const seen = new Set();
  $('img[src],img[data-src],source[srcset]').each((_, el) => {
    const raw = $(el).attr('data-src') || $(el).attr('src') || ($(el).attr('srcset') || '').split(',')[0]?.trim().split(/\s+/)[0];
    const alt = cleanText($(el).attr('alt'));
    const u = raw && absoluteUrl(raw, pageUrl);
    if (!u || !/^https?:/i.test(u)) return;
    if (/logo|icon|avatar|spinner|tracking|pixel|placeholder|favicon/i.test(u)) return;
    if (alt && title && alt !== title && /logo|icon|govdeals/i.test(alt)) return;
    if (!seen.has(u)) { seen.add(u); out.push(u); }
  });
  return out;
}

function detectDefects(text) {
  const lower = text.toLowerCase();
  const flag = (re) => re.test(lower) ? true : null;
  return {
    missing_parts: flag(/missing\s+(?:part|parts|component)/),
    known_damage: flag(/damaged|damage|broken|crack|dent/),
    mechanical_issue: flag(/mechanical issue|engine.*(?:bad|issue|problem)|does not run|not running/),
    electrical_issue: flag(/electrical issue|electrical problem|does not power|no power/),
    cosmetic_damage: flag(/cosmetic|scratch|scuff|dent/),
    not_tested: flag(/not tested|untested|has not been tested/),
    working_condition_unknown: flag(/unknown condition|condition.*unknown|operability.*unknown/),
    key_available: /(?:\b2 keys\b|\b1 key\b|keys? included|comes with.*keys?)/i.test(text) ? true : null,
    screen_damage: flag(/cracked screen|screen.*crack|broken screen/),
    water_damage: flag(/water damage|liquid damage/),
    locked_device: flag(/activation lock|icloud lock|locked device|passcode locked/),
    parts_only: flag(/parts only|for parts/),
    salvage: flag(/salvage/),
  };
}

export function parseDetailPage(html, pageUrl, observedAt = new Date().toISOString()) {
  const $ = load(html);
  const identity = parseAssetIdentity(pageUrl);
  if (!identity) throw new Error(`GovDeals detail URL missing /asset/{assetId}/{sellerAccountId}: ${pageUrl}`);
  const text = allText($);
  const title = cleanText($('h1').first().text() || $('title').first().text().replace(/\|\s*GovDeals.*$/i, ''));
  if (!title) throw new Error('GovDeals detail page missing title');

  const pairs = extractTablePairs($);
  const priceMatch = text.match(/\$\s*[\d,.]+\s*USD\s*\(\s*\d+\s*Bids?\s*\)/i);
  const currentPrice = money(priceMatch?.[0] || text.match(/(?:Current Bid|High Bid)[^$]{0,40}\$\s*[\d,.]+/i)?.[0]);
  const bidCount = integer(priceMatch?.[0]?.match(/\((\d+)\s*Bids?/i)?.[1]);
  const bidIncrement = money(text.match(/\$\s*[\d,.]+\s*USD\s*Bid Increment/i)?.[0]);
  const endTime = parseDateLoose(text.match(/(?:Closed|Closes|Closing|Ends?)\s*:?\s*\([^)]*(?:UTC|GMT)[^)]*\)/i)?.[0]);
  const status = inferAuctionStatus(text, endTime, new Date(observedAt));
  const location = textAfterLabel(text, 'Location', 180);
  const seller = textAfterLabel(text, 'Seller', 180);
  const description = sectionText($, /^Description$/i) || null;
  const inspection = sectionText($, /^Inspection$/i);
  const payment = sectionText($, /^Payment$/i);
  const removal = sectionText($, /^Removal$/i);
  const specialInstructions = sectionText($, /^Special Instructions$/i);
  const sellerInfo = sectionText($, /^Seller Information$/i);
  const logisticsText = cleanText([description, inspection, payment, removal, specialInstructions, sellerInfo].filter(Boolean).join(' '));
  const logistics = extractLogisticsSignals(logisticsText || text);
  const eligibility = detectEligibility(text);
  const lotNumber = pairs['Lot Number'] || text.match(/Lot Number\s*\|?\s*([\w-]+)/i)?.[1] || identity.lotNumberDerived;
  const conditionRaw = pairs.Condition || text.match(/Condition\s*\|?\s*([^|]{1,100}?)(?=Lot Number|Inventory ID|\n|$)/i)?.[1] || null;
  const condition = conditionRaw ? cleanText(conditionRaw) : 'UNKNOWN';
  const inventoryId = pairs['Inventory ID'] || null;
  const manufacturer = pairs.Manufacturer || null;
  const model = pairs.Model || null;
  const serialNumber = pairs['Serial Number'] || null;
  const year = pairs['Year of Manufacture'] || pairs.Year || null;
  const accountType = pairs['Account Type'] || text.match(/Account Type\s*:?\s*(Government|Business|Individual)/i)?.[1] || null;
  const taxAmount = money(text.match(/Tax Amount\s*USD\s*[\d,.]+/i)?.[0]);
  const soldAmount = money(text.match(/Sold Amount\s*USD\s*[\d,.]+/i)?.[0]);
  const totalPrice = money(text.match(/Total Price\s*USD\s*[\d,.]+/i)?.[0]);
  const reserveStatus = /reserve not met/i.test(text) ? 'NOT_MET' : /reserve met/i.test(text) ? 'MET' : null;
  const images = extractImages($, pageUrl, title);

  const itemLocation = sellerInfo?.match(/Item Location:\s*([^]{0,220}?)(?=Account Type:|Inspection|$)/i)?.[1] || null;
  const finalLocation = cleanText(itemLocation || location || '');
  const defects = detectDefects(cleanText([title, description, condition].filter(Boolean).join(' ')));

  return {
    source: 'govdeals',
    record_type: 'auction_listing',
    external_id: identity.externalId,
    asset_id: identity.assetId,
    seller_account_id: identity.sellerAccountId,
    auction_id: null,
    lot_number: cleanText(lotNumber),
    listing_url: identity.canonicalUrl,
    canonical_url: identity.canonicalUrl,
    title,
    description: cleanText(description || ''),
    category: '',
    subcategory: '',
    manufacturer: cleanText(manufacturer || '') || null,
    brand: cleanText(manufacturer || '') || null,
    model: cleanText(model || '') || null,
    serial_number: cleanText(serialNumber || '') || null,
    year: cleanText(year || '') || null,
    condition,
    raw_condition: cleanText(conditionRaw || '') || null,
    current_price: currentPrice,
    bid_increment: bidIncrement,
    bid_count: bidCount,
    reserve_status: reserveStatus,
    reserve_met: reserveStatus === 'MET' ? true : reserveStatus === 'NOT_MET' ? false : null,
    buyers_premium: soldAmount != null && currentPrice != null && soldAmount >= currentPrice ? Math.round((soldAmount - currentPrice) * 100) / 100 : null,
    buyers_premium_source: soldAmount != null && currentPrice != null && soldAmount >= currentPrice ? 'DERIVED_FROM_SOLD_AMOUNT' : null,
    buyers_premium_confidence: soldAmount != null && currentPrice != null && soldAmount >= currentPrice ? 0.95 : null,
    tax_estimate: taxAmount,
    total_estimated_cost: totalPrice,
    estimated_shipping: null,
    shipping_available: logistics.shipping_available,
    pickup_required: logistics.pickup_required,
    pickup_location: finalLocation || null,
    location: finalLocation,
    seller_name: cleanText(seller || '') || null,
    seller_agency: cleanText(seller || '') || null,
    seller_type: cleanText(accountType || '') || null,
    auction_start_time: null,
    auction_end_time: endTime,
    auction_status: status,
    time_remaining_seconds: timeRemainingSeconds(endTime, observedAt),
    inspection_available: inspection ? true : null,
    inspection_details: cleanText(inspection || logistics.inspection_details || '') || null,
    payment_terms: cleanText(payment || logistics.payment_terms || '') || null,
    removal_requirements: cleanText(removal || logistics.removal_requirements || '') || null,
    special_instructions: cleanText(specialInstructions || '') || null,
    currency: 'USD',
    image_urls: images,
    documents: [],
    ...eligibility,
    ...defects,
    source_meta: {
      transport: 'govdeals_html',
      price: { value: currentPrice, source: 'govdeals_detail_html', raw: priceMatch?.[0] || null },
      condition: { value: condition, source: 'govdeals_detail_html', confidence: conditionRaw ? 1 : 0, raw: conditionRaw },
      location: { value: finalLocation || null, source: 'govdeals_detail_html', raw: itemLocation || location || null },
      auction_end_time: { value: endTime, source: 'govdeals_detail_html', raw: text.match(/(?:Closed|Closes|Closing|Ends?)\s*:?\s*\([^)]*(?:UTC|GMT)[^)]*\)/i)?.[0] || null },
      shipping: { available: logistics.shipping_available, pickup_required: logistics.pickup_required, source: 'govdeals_detail_html' },
      buyers_premium: { amount: soldAmount != null && currentPrice != null && soldAmount >= currentPrice ? Math.round((soldAmount - currentPrice) * 100) / 100 : null, source: 'DERIVED_FROM_SOLD_AMOUNT', confidence: soldAmount != null && currentPrice != null && soldAmount >= currentPrice ? 0.95 : null },
      asset_id: identity.assetId,
      seller_account_id: identity.sellerAccountId,
      lot_number: cleanText(lotNumber),
      inventory_id: inventoryId,
      bid_count: bidCount,
      bid_increment: bidIncrement,
      reserve_status: reserveStatus,
      auction_status: status,
      time_remaining_seconds: timeRemainingSeconds(endTime, observedAt),
      seller_name: cleanText(seller || '') || null,
      seller_type: cleanText(accountType || '') || null,
      shipping_available: logistics.shipping_available,
      pickup_required: logistics.pickup_required,
      pickup_location: finalLocation || null,
      payment_terms: cleanText(payment || logistics.payment_terms || '') || null,
      removal_requirements: cleanText(removal || logistics.removal_requirements || '') || null,
      special_instructions: cleanText(specialInstructions || '') || null,
      bidding_eligibility: eligibility.bidding_eligibility,
      bidding_allowed: eligibility.bidding_allowed,
      bidding_restriction_message: eligibility.bidding_restriction_message,
      defects,
      sold_amount: soldAmount,
      tax_amount: taxAmount,
      total_price: totalPrice,
    },
    attributes: {
      trusted: {
        manufacturer: manufacturer || undefined,
        model: model || undefined,
        serial_number: serialNumber || undefined,
        year: year || undefined,
        inventory_id: inventoryId || undefined,
        lot_number: lotNumber || undefined,
      },
      mined: { ...defects },
    },
    normalization_status: currentPrice == null || !endTime ? 'valid_with_warnings' : 'valid',
    pipeline_stage: 'source_extracted',
    scraped_at: observedAt,
    observed_at: observedAt,
  };
}

export function looksLikeErrorPage(html) {
  const $ = load(html);
  const text = allText($).toLowerCase();
  if (/access denied|forbidden|verify you are human|captcha/.test(text)) return true;
  if (/we couldn't find that page/.test(text) && !/asset id|description|lot number/.test(text)) return true;
  return false;
}