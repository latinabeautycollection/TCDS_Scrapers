import { load } from 'cheerio';
import { cleanText, integer, money, parsePublicSurplusDate, inferAuctionStatus, timeRemainingSeconds } from './text.js';
import { parseAuctionIdentity, canonicalizePublicSurplusUrl } from './url.js';
import { detectEligibility } from './eligibility.js';
import { extractLogisticsSignals } from './logistics.js';
import { parseDiscoveryLinks } from './discovery.js';
import { isItemPhotoUrl, normalizeCondition, normalizeBlockText, classifyPublicSurplusShipping } from './fieldRules.js';

function absoluteUrl(raw, base) {
  try { return new URL(raw, base).toString(); } catch { return null; }
}

function nearestCardText($, anchor) {
  const candidates = [
    anchor.closest('article'), anchor.closest('li'), anchor.closest('tr'), anchor.closest('[class*="auction"]'),
    anchor.closest('[class*="item"]'), anchor.closest('[class*="card"]'), anchor.parent().parent().parent(), anchor.parent().parent(), anchor.parent(),
  ];
  for (const c of candidates) {
    const t = cleanText(c.text());
    if (t && t.length >= 15) return t;
  }
  return cleanText(anchor.text());
}

function looksLikeAuctionAnchor(href) {
  return /\/auction\/view/i.test(href || '') && /[?&]auc=\d+/i.test(href || '');
}

export function parseSearchPage(html, pageUrl, discoveryOptions = {}) {
  const $ = load(html);
  const seen = new Set();
  const items = [];

  $('a[href]').each((_, el) => {
    const a = $(el);
    const rawHref = a.attr('href') || '';
    if (!looksLikeAuctionAnchor(rawHref)) return;
    const href = absoluteUrl(rawHref, pageUrl);
    const identity = href && parseAuctionIdentity(href);
    if (!identity || seen.has(identity.externalId)) return;
    seen.add(identity.externalId);

    const cardText = nearestCardText($, a);
    let title = cleanText(a.text() || a.attr('title') || '');
    title = title.replace(new RegExp(`^#?${identity.auctionId}\\s*[-–:]?\\s*`, 'i'), '').trim();
    if (!title) title = cleanText(cardText.match(new RegExp(`#${identity.auctionId}\\s*[-–]\\s*(.+?)(?=Price:|Time Left:|Ends:|$)`, 'i'))?.[1] || '');
    const currentPrice = money(cardText.match(/Price\s*:\s*\$\s*[\d,.]+/i)?.[0]);
    // Card thumbnail (real item photo on CloudFront). Used only as a fallback when the detail page has none.
    const cardImg = [a.find('img').first(), a.closest('.auction-item').find('img').first()]
      .map((im) => absoluteUrl(im.attr('src') || im.attr('data-src') || '', pageUrl)).find((u) => u && isItemPhotoUrl(u)) || null;
    const state = cardText.match(/(?:^|\s)([A-Z]{2})(?=\s+#?\d+|\s*$)/)?.[1] || null;
    const timeLeft = cleanText(cardText.match(/(?:Time Left|Ends)\s*:\s*([^#]+?)(?=Price:|$)/i)?.[1] || '');

    items.push({
      ...identity,
      listingUrl: canonicalizePublicSurplusUrl(href),
      title: title || null,
      currentPrice,
      imageUrl: cardImg,
      location: state,
      timeLeft: timeLeft || null,
      indexText: cardText,
    });
  });

  const pagination = [];
  const pSeen = new Set();
  $('a[href]').each((_, el) => {
    const href = absoluteUrl($(el).attr('href'), pageUrl);
    if (!href) return;
    let u;
    try { u = new URL(href); } catch { return; }
    if (!/(^|\.)publicsurplus\.com$/i.test(u.hostname)) return;
    if (!/\/browse\/search/i.test(u.pathname)) return;
    if (!u.searchParams.has('page')) return;
    const canon = canonicalizePublicSurplusUrl(href);
    if (!pSeen.has(canon)) { pSeen.add(canon); pagination.push(canon); }
  });

  const discoveryLinks = parseDiscoveryLinks(html, pageUrl, discoveryOptions);
  return { items, pagination, discoveryLinks };
}

function sectionTextFromRoot(text, startLabel, stopLabels = []) {
  const escapedStart = startLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const stops = stopLabels.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const re = new RegExp(`(?:^|\\n)${escapedStart}\\b\\s*:?[\\s|]*([\\s\\S]+?)${stops ? `(?=\\n(?:${stops})|$)` : '$'}`, 'i');
  return cleanText(text.match(re)?.[1] || '');
}

function blockText($, node) {
  // Keep paragraph and list line breaks (intake guide). Falls back to flat text if anything goes wrong.
  try {
    const $c = $(node).clone();
    $c.find('script,style,noscript').remove();
    $c.find('br').replaceWith('\n');
    $c.find('td,th').each((_, el) => { $(el).append(' | '); });
    $c.find('p,div,li,tr,h1,h2,h3,h4,h5,h6,ul,ol,table').each((_, el) => { $(el).append('\n'); });
    return normalizeBlockText($c.text());
  } catch {
    return cleanText($(node).text());
  }
}

function extractDescription($, rootText) {
  let description = '';
  $('h1,h2,h3,h4,h5,strong,b,div,span').each((_, el) => {
    if (description) return;
    const t = cleanText($(el).text());
    if (!/^Description$/i.test(t)) return;
    const parent = $(el).parent();
    const candidates = [$(el).next(), parent.next(), parent];
    for (const c of candidates) {
      const ct = cleanText(c.text());
      if (ct && !/^Description$/i.test(ct) && ct.length > 5) { description = blockText($, c) || ct; break; }
    }
  });
  if (!description) description = sectionTextFromRoot(rootText, 'Description', ['Computer Translation', 'Standard Disclaimer', 'Questions', 'Terms and Conditions']);
  return normalizeBlockText(description);
}

function extractImages($, pageUrl) {
  const out = [];
  const seen = new Set();
  $('img[src], img[data-src], a[href]').each((_, el) => {
    const raw = $(el).attr('data-src') || $(el).attr('src') || $(el).attr('href');
    if (!raw) return;
    const abs = absoluteUrl(raw, pageUrl);
    if (!abs || !/^https?:/i.test(abs)) return;
    if (!isItemPhotoUrl(abs)) return; // drops site flags/logos/UI icons (V1.2.1)
    if (!seen.has(abs)) { seen.add(abs); out.push(abs); }
  });
  return out;
}

function extractLabelValues($) {
  const pairs = [];
  const add = (label, value, source) => {
    const l = cleanText(label).replace(/\s*:\s*$/, '');
    const v = cleanText(value);
    if (l && v) pairs.push({ label: l, value: v, source });
  };
  $('table tr').each((_, row) => {
    const cells = $(row).find('th,td').toArray().map((cell) => cleanText($(cell).text())).filter(Boolean);
    if (cells.length > 1) add(cells[0], cells.slice(1).join(' | '), 'table');
    else if (cells.length === 1) {
      const match = cells[0].match(/^([^:]{1,100}):\s*(.+)$/);
      if (match) add(match[1], match[2], 'table');
    }
  });
  $('dt').each((_, el) => add($(el).text(), $(el).next('dd').text(), 'definition_list'));
  $('label').each((_, el) => {
    const label = cleanText($(el).text());
    const forId = $(el).attr('for');
    const control = forId ? $(`#${forId}`) : $(el).find('input,select,textarea').first();
    const value = control.attr('value') ?? control.val() ?? control.text();
    add(label, value, 'form_label');
  });
  const lines = blockText($, $.root()).split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*([^:|]{1,100}):\s*(.+?)\s*$/);
    if (match) add(match[1], match[2], 'page_text');
    const bidLabel = line.match(/^\s*(#\s*of\s*Bids)\s+(\d+)\s*$/i);
    if (bidLabel) add(bidLabel[1], bidLabel[2], 'page_text');
  }
  return pairs;
}

function extractPageVariables($) {
  return $('script').toArray().map((el, index) => {
    const content = $(el).html() ?? '';
    return { index, type: $(el).attr('type') ?? null, id: $(el).attr('id') ?? null, content };
  }).filter((script) => /price|bid|auction|start|end|date|ship|lot/i.test(script.content));
}

function extractShippingOptions($, shippingSection) {
  const options = [];
  $('[id], [class], [name]').each((_, el) => {
    const marker = [$(el).attr('id'), $(el).attr('class'), $(el).attr('name')].filter(Boolean).join(' ');
    if (!/ship|freight|delivery|postage/i.test(marker)) return;
    const content = cleanText($(el).text());
    if (content && content.length <= 2000) options.push({ source: marker, text: content });
  });
  $('option').each((_, el) => {
    const text = cleanText($(el).text());
    if (text && /ship|freight|delivery|postage|pickup|pick-up/i.test(text)) options.push({ source: 'select_option', text });
  });
  return { section_text: shippingSection || null, displayed_options: options };
}

function extractShippingCosts(text) {
  return [...String(text ?? '').matchAll(/\$\s*([\d,]+(?:\.\d{1,2})?)/g)]
    .map((match) => Number.parseFloat(match[1].replace(/,/g, '')))
    .filter((amount) => Number.isFinite(amount) && amount >= 0);
}

function detectDefects(text) {
  const t = cleanText(text).toLowerCase();
  return {
    missing_parts: /missing|no (?:plow|spreader|battery|key|parts?)/.test(t) ? true : null,
    known_damage: /damage|damaged|broken|rust|dent|crack|hole/.test(t) ? true : null,
    mechanical_issue: /mechanical|engine|transmission|drivetrain|brake|not running|won't start|wont start/.test(t) ? true : null,
    electrical_issue: /electrical|battery|charging|wiring/.test(t) ? true : null,
    cosmetic_damage: /scratch|dent|rust|cosmetic|paint|body/.test(t) ? true : null,
    not_tested: /not tested|untested|unknown working|working condition unknown/.test(t) ? true : null,
    working_condition_unknown: /condition unknown|unknown condition|working condition unknown/.test(t) ? true : null,
    screen_damage: /cracked screen|screen damage|broken screen/.test(t) ? true : null,
    water_damage: /water damage|liquid damage/.test(t) ? true : null,
    locked_device: /activation lock|icloud lock|locked device/.test(t) ? true : null,
    parts_only: /parts only|for parts|salvage/.test(t) ? true : null,
    salvage: /salvage/.test(t) ? true : null,
  };
}

function parseBuyerPremium(text, currentPrice) {
  const direct = /Buyer(?:['’]s|s)?\s+Premium\s*:?\s*(?:of\s+)?(?:A\s+)?(\d+(?:\.\d+)?)\s*%/gi;
  const reversed = /(\d+(?:\.\d+)?)\s*%\s+Buyer(?:['’]s|s)?\s+Premium/gi;
  const candidates = [];
  for (const pattern of [direct, reversed]) {
    for (const m of text.matchAll(pattern)) {
      const pct = Number.parseFloat(m[1]);
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) continue;
      // Some terms label a line "TAX & BUYER PREMIUM" before giving the sales-tax rate,
      // then state the actual premium later. Do not treat the tax rate as the premium.
      const afterRate = text.slice(m.index + m[0].length, m.index + m[0].length + 30);
      if (/^\s*Sales\s+tax\b/i.test(afterRate)) continue;
      candidates.push({ pct, index: m.index });
    }
  }
  candidates.sort((a, b) => a.index - b.index);
  const m = candidates.length ? candidates[0] : null;
  if (!m) return { pct: null, amount: null, source: null, confidence: null };
  const pct = m.pct;
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return { pct: null, amount: null, source: null, confidence: null };
  const amount = currentPrice == null ? null : Math.round(currentPrice * (pct / 100) * 100) / 100;
  return { pct, amount, source: 'DERIVED_FROM_PUBLISHED_PERCENTAGE', confidence: 0.98 };
}

function pickupAgency(block) {
  const b = cleanText(block);
  if (!b) return null;
  const beforeAddress = b.split(/\[|\b\d{1,6}\s+[A-Za-z]/)[0].trim();
  return beforeAddress || null;
}

export function looksLikeErrorPage(html) {
  const $ = load(html);
  const text = cleanText($.root().text());
  const title = cleanText($('title').first().text());
  const hasAuctionSignal = /Auction #\d+/i.test(text) || /auc=\d+/i.test(html);
  if (/access denied|request blocked|temporarily unavailable|service unavailable|forbidden|maintenance|site unavailable|system error|unexpected error/i.test(`${title} ${text}`)) return true;
  if (/captcha|verify you are human|security check|challenge/i.test(text) && !hasAuctionSignal) return true;
  if (/sign in|log in|login/i.test(title) && !hasAuctionSignal) return true;
  if (!text && !hasAuctionSignal) return true;
  return false;
}

export function parseDetailPage(html, pageUrl, observedAt = new Date().toISOString()) {
  const originalHtml = String(html ?? '');
  const $ = load(html);
  const pageVariables = extractPageVariables($);
  $('script,style,noscript').remove(); // V1.2.3: inline JS (sendOffer/testCookie) was leaking into removal text
  const pageLines = blockText($, $.root());
  const text = cleanText(pageLines);
  const identity = parseAuctionIdentity(pageUrl);
  if (!identity) throw new Error(`PUBLICSURPLUS_IDENTITY_NOT_FOUND:${pageUrl}`);

  // Prefer the dedicated auction heading. Flattened page text also contains
  // status badges and seller links immediately after it, contaminating some
  // closed-auction titles.
  const heading = cleanText($('.nav-sub-head .text-wrap').first().text() || $('h1,h2').first().text());
  const title = cleanText(heading.replace(/^Auction\s*#\d+\s*[-–:]?\s*/i, ''));
  if (!title) throw new Error(`PUBLICSURPLUS_TITLE_NOT_FOUND:${identity.auctionId}`);

  const dateTimePattern = '([A-Z][a-z]{2}\\s+\\d{1,2},\\s+\\d{4}\\s+\\d{1,2}:\\d{2}(?::\\d{2})?\\s*(?:AM|PM)(?:\\s+(?:EST|EDT|CST|CDT|MST|MDT|PST|PDT|UTC|GMT|Eastern|Central|Mountain|Pacific))?)';
  const endRaw = text.match(new RegExp(`Auction (?:Ends|Ended)\\s+${dateTimePattern}`, 'i'))?.[1] || null;
  const endTime = parsePublicSurplusDate(endRaw);
  const currentPriceRaw = text.match(/(?:Current Price|Current Bid|Final Price)\s*:?\s*\$\s*[\d,.]+/i)?.[0] || null;
  let currentPrice = money(currentPriceRaw);
  const bidIncrement = money(text.match(/Increment\s*:\s*\$\s*[\d,.]+/i)?.[0]);
  const minimumBid = money(text.match(/Minimum bid\s*:\s*\$\s*[\d,.]+/i)?.[0]);
  const startingPriceRaw = text.match(/(?:Starting|Opening)\s+bid\s*:\s*\$\s*[\d,.]+/i)?.[0] || null;
  const startingPrice = money(startingPriceRaw);
  const buyNowRaw = text.match(/(?:Buy\s*Now|Buy\s*It\s*Now)\s*:?\s*\$\s*[\d,.]+/i)?.[0] || null;
  const buyNowPrice = money(buyNowRaw);
  const bidCount = integer(text.match(/#\s*of\s*Bids\s*:?\s*\d+/i)?.[0]) ?? (/\b(?:No bids|No bids have been placed)\b/i.test(text) ? 0 : null);
  const fixedPrice = /fixed price/i.test(text) || $('[alt*="Fixed Price" i]').length > 0;
  const listingType = fixedPrice ? 'FIXED_PRICE' : (bidCount != null || bidIncrement != null || minimumBid != null ? 'AUCTION' : 'UNKNOWN');
  const currency = cleanText(text.match(/Currency\s*:\s*([A-Z]{3})/i)?.[1] || 'USD');
  const region = cleanText(text.match(/Region\s*:\s*([A-Z]{2})\b/i)?.[1] || '');
  const pickupBlock = normalizeBlockText(pageLines.match(/Pick-up Location\s*:?[ \n]*([\s\S]+?)(?=Auction Contact|Payment|Shipping|Bid on Item|$)/i)?.[1] || '');
  const sellerName = pickupAgency(pickupBlock);
  const description = extractDescription($, pageLines);
  const labelValues = extractLabelValues($);
  const conditionRaw = cleanText(description.match(/Condition\s*:\s*([^\n]{1,100}?)(?=\s{2,}|\n|Computer Translation|$)/i)?.[1]
    || text.match(/Condition\s*:\s*([A-Za-z][A-Za-z /-]{0,80})/i)?.[1] || '');
  const condition = normalizeCondition(conditionRaw);
  const labelled = (label) => {
    const values = [...description.matchAll(new RegExp('(?:^|[\\s|])' + label + '\\s*:\\s*([^\\n|]+?)(?=\\s+(?:Make|Brand|Model|Model\\s*(?:No\\.?|Number|#)|MPN|Part\\s*(?:No\\.?|Number|#)|Catalog(?:ue)?\\s*(?:No\\.?|Number|#)|Serial(?: Num(?:ber)?)?|Condition)\\s*:|[|\\n]|$)', 'gi'))].map(m => cleanText(m[1]));
    const unique = [...new Set(values.filter(Boolean))];
    return unique.length === 1 ? unique[0] : null;
  };
  const pageLabelled = (...names) => {
    const nameSet = new Set(names.map((name) => name.toLowerCase()));
    return labelValues.find(({ label, value }) => nameSet.has(cleanText(label).toLowerCase()) && cleanText(value))?.value ?? null;
  };
  const brand = labelled('(?:Make|Brand)');
  const model = labelled('Model') ?? pageLabelled('Model');
  const explicitMpn = labelled('(?:MPN|Part\\s*(?:No\\.?|Number)|Part\\s*#|Model\\s*(?:No\\.?|Number)|Model\\s*#|Catalog(?:ue)?\\s*(?:No\\.?|Number|#))')
    ?? pageLabelled('MPN', 'Part No.', 'Part Number', 'Part #', 'Model No.', 'Model Number', 'Model #', 'Catalog No.', 'Catalog Number', 'Catalogue Number');
  const serialNumber = labelled('(?:Serial(?:\\s*(?:Number|No\\.?|#))?|S/N|SN#)') ?? pageLabelled('Serial Number', 'Serial #', 'Serial', 'S/N', 'SN#');
  const vin = labelled('VIN') ?? pageLabelled('VIN', 'Vehicle Identification Number');
  // Published model codes may contain spaces (for example "7410 i5").
  const candidate = explicitMpn ?? (model && /\d/.test(model) && /^[a-z0-9][a-z0-9._/ -]{0,79}$/i.test(model) ? model : null);
  const mpn = candidate && !/^(?:n\/?a|none|unknown|not specified|not available)$/i.test(candidate) && ![serialNumber, vin].filter(Boolean).some(value => String(value).toLowerCase() === String(candidate).toLowerCase()) ? candidate : null;
  const startRaw = text.match(new RegExp(`Auction (?:Starts|Started|Begins)\\s*:?\\s*${dateTimePattern}`, 'i'))?.[1];
  const startTime = startRaw ? parsePublicSurplusDate(startRaw) : null;
  const startTimeSource = startRaw
    ? (startTime ? 'publicsurplus_detail_html' : 'publicsurplus_detail_html_unresolved')
    : /\bAuction\s+(?:Starts|Started|Begins)\b/i.test(text)
      ? 'publicsurplus_detail_html_unparsed'
      : 'not_published_by_site';
  const shippingSection = sectionTextFromRoot(pageLines, 'Shipping', ['Bid on Item', 'Region:', 'How to place a bid', 'High Bidder', 'Auction Contact', 'Auction Results', 'Payment', 'Pick-up Location', 'Description', 'Auction Ends', 'Auction Ended', 'Terms and Conditions']);
  const paymentSection = sectionTextFromRoot(pageLines, 'Payment', ['Shipping', 'Bid on Item', 'Description', 'Auction Contact', 'Pick-up Location']);
  const logisticsText = cleanText([pickupBlock, shippingSection, paymentSection, description, text].join(' '));
  const logistics = extractLogisticsSignals(logisticsText);
  const shippingCosts = extractShippingCosts(shippingSection);
  const shipping = classifyPublicSurplusShipping({ title, description, shippingText: shippingSection, pickupText: pickupBlock, shippingCosts });
  const shippingMethod = shipping.shipping_method;
  const estimatedShipping = shipping.estimated_shipping;
  const shippingEvidence = shipping.shipping_evidence;
  logistics.shipping_available = ['shipping', 'shipping_quote', 'free_shipping'].includes(shippingMethod);
  logistics.pickup_required = shippingMethod === 'pickup_only';
  if (listingType === 'FIXED_PRICE') currentPrice ??= buyNowPrice;
  const priceType = listingType === 'FIXED_PRICE' && currentPrice != null
    ? 'buy_now'
    : bidCount > 0 && currentPrice != null ? 'current_bid'
      : bidCount === 0 && (startingPrice != null || minimumBid != null || currentPrice != null) ? 'starting_bid'
        : currentPrice != null ? 'current_bid' : null;
  const originalDescription = description;
  const shippingOptions = extractShippingOptions($, shippingSection);
  const sourceRecord = {
    original_html: originalHtml,
    label_values: labelValues,
    full_description: originalDescription,
    shipping_options: shippingOptions,
    page_variables: pageVariables,
  };
  const eligibility = detectEligibility(text);
  const premium = parseBuyerPremium(text, currentPrice);
  const reserveStatus = /reserve has been met/i.test(text) ? 'MET' : /reserve has not been met|reserve not met/i.test(text) ? 'NOT_MET' : null;
  const bidDeposit = cleanText(text.match(/Bid Deposit\s*:\s*(REQUIRED|May Apply|NOT REQUIRED|Not Required)/i)?.[1] || '');
  const extensionPossible = /this auction might extend/i.test(text);
  const status = inferAuctionStatus(text, endTime, new Date(observedAt));
  const images = extractImages($, pageUrl);
  const defects = detectDefects(`${title} ${description} ${condition}`);

  return {
    source: 'publicsurplus',
    record_type: 'auction_listing',
    listing_type: listingType,
    external_id: identity.externalId,
    asset_id: identity.auctionId,
    auction_id: identity.auctionId,
    lot_number: identity.auctionId,
    listing_url: identity.canonicalUrl,
    canonical_url: identity.canonicalUrl,
    title,
    description,
    category: cleanText(pageLines.match(/(?:^|\n)Category\s*:[ \t]*([^\n|]+)/i)?.[1]) || null,
    subcategory: cleanText(pageLines.match(/(?:^|\n)Subcategory\s*:[ \t]*([^\n|]+)/i)?.[1]) || null,
    condition,
    raw_condition: conditionRaw || null,
    current_price: currentPrice,
    price_type: priceType,
    buy_now_price: buyNowPrice,
    starting_price: startingPrice,
    minimum_bid: minimumBid,
    bid_increment: bidIncrement,
    bid_count: bidCount,
    reserve_status: reserveStatus,
    reserve_met: reserveStatus === 'MET' ? true : reserveStatus === 'NOT_MET' ? false : null,
    buyers_premium: premium.amount,
    buyers_premium_pct: premium.pct,
    buyers_premium_source: premium.source,
    buyers_premium_confidence: premium.confidence,
    tax_estimate: null,
    estimated_shipping: estimatedShipping,
    shipping_method: shippingMethod,
    shipping_evidence: shippingEvidence,
    total_estimated_cost: null,
    shipping_available: logistics.shipping_available,
    pickup_required: logistics.pickup_required,
    pickup_location: pickupBlock || null,
    location: pickupBlock || region || '',
    seller_name: sellerName,
    seller_agency: sellerName,
    seller_type: 'government',
    auction_start_time: startTime,
    auction_start_time_source: startTimeSource,
    auction_end_time: endTime,
    auction_status: status,
    time_remaining_seconds: timeRemainingSeconds(endTime, observedAt),
    auction_extension_possible: extensionPossible,
    inspection_available: /inspection|viewing of auction/i.test(text) ? true : null,
    inspection_details: logistics.inspection_details,
    payment_terms: paymentSection || logistics.payment_terms,
    removal_requirements: logistics.removal_requirements,
    bid_deposit: bidDeposit || null,
    currency,
    image_urls: images,
    documents: [],
    ...eligibility,
    ...defects,
    source_meta: {
      transport: 'publicsurplus_html',
      auction_id: identity.auctionId,
      price: { value: currentPrice, source: 'publicsurplus_detail_html', raw: currentPriceRaw },
      price_type: priceType,
      starting_price: { value: startingPrice, source: startingPriceRaw ? 'publicsurplus_detail_html' : null, raw: startingPriceRaw },
      buy_now_price: { value: buyNowPrice, source: buyNowRaw ? 'publicsurplus_detail_html' : null, raw: buyNowRaw },
      auction_start_time: { value: startTime, source: startTimeSource, raw: startRaw || null },
      auction_end_time: { value: endTime, source: 'publicsurplus_detail_html', raw: endRaw },
      condition: { value: condition, source: 'publicsurplus_detail_html', raw: conditionRaw || null },
      location: { value: pickupBlock || region || null, source: 'publicsurplus_detail_html' },
      seller_name: sellerName,
      bid_count: bidCount,
      bid_increment: bidIncrement,
      minimum_bid: minimumBid,
      reserve_status: reserveStatus,
      bid_deposit: bidDeposit || null,
      extension_possible: extensionPossible,
      listing_type: listingType,
      buyers_premium_pct: premium.pct,
      buyers_premium_source: premium.source,
      shipping_available: logistics.shipping_available,
      pickup_required: logistics.pickup_required,
      shipping: { method: shippingMethod, estimated_cost: estimatedShipping, source: shippingMethod === 'free_shipping' ? 'publicsurplus_free_shipping_text' : shippingMethod === 'shipping' ? 'publicsurplus_shipping_section' : shippingEvidence ? 'publicsurplus_detail_text' : null, costs: shippingMethod === 'free_shipping' ? [0] : shippingCosts, evidence: shippingEvidence },
      time_remaining_seconds: timeRemainingSeconds(endTime, observedAt),
      defects,
    },
    brand, model, mpn, serial_number: serialNumber, vin,
    attributes: { serial_number: serialNumber, vin, price_type: priceType, bid_count: bidCount, auction_start_time_source: startTimeSource, shipping_evidence: shippingEvidence, trusted: { Brand: brand, Model: model, 'Model number': mpn, MPN: mpn }, mined: {} },
    source_record: sourceRecord,
  };
}