/**
 * src/extractors/propertyroom.js
 *
 * PropertyRoom CheerioCrawler — HTTP + HTML parsing (no browser)
 *
 * Strategy:
 *   1. Treat every startUrl + every keyword search as an "index" page.
 *   2. On index pages, collect all item detail links and enqueue them.
 *   3. Paginate index pages up to maxPages.
 *   4. On detail pages, run multi-strategy extraction with fallbacks.
 *   5. Normalise → validate → deduplicate → save to Dataset → webhook.
 *
 * Cost optimisation:
 *   CheerioCrawler uses plain HTTP requests + Cheerio HTML parsing.
 *   No headless browser → 95% cheaper than PlaywrightCrawler.
 *   PropertyRoom is 100% server-rendered, so all data is in the raw HTML.
 *
 * Selectors informed by real PropertyRoom DOM as of 2026-04:
 *   • Images:     .sp-wrap img  (smoothproducts carousel)
 *   • Price:      #MainContent_uxTypeOfPrice / #MainContent_uxPrice
 *   • Attributes: <ul><li>"Key: Value"</li></ul> lists
 *   • End time:   "Ends {date} at {time} (Eastern)" text
 *   • Category:   breadcrumb last link
 *   • JS vars:    LISTING_ID, LISTING_TITLE, LISTING_FORMAT
 *   • Pagination: div.pagination with /c/category/N#scrollcontainer links
 */

import { CheerioCrawler } from 'crawlee';
import { Actor } from 'apify';
import { normalizeRecord, validateRecord, addSupabaseAliases } from '../utils/normalize.js';
import { incrementStat } from '../utils/logging.js';

// ─── URL helpers ─────────────────────────────────────────────────────────────

const DOMAIN = 'https://www.propertyroom.com';

/** Build a keyword search URL. */
function keywordUrl(kw) {
  return `${DOMAIN}/l?q=${encodeURIComponent(kw)}`;
}

/** True if this looks like a listing detail page (has numeric ID segment). */
function isDetailUrl(url) {
  return /\/l\/[^/]+\/\d+/.test(url) || /\/s\/\d+/.test(url);
}

/**
 * Extract a human-readable category from a /c/{slug} URL path.
 * e.g. '/c/electronics' → 'Electronics'
 *      '/c/tools-and-equipment' → 'Tools And Equipment'
 *      '/c/vehicles_cars-trucks-vans' → 'Cars Trucks Vans'
 */
function categoryFromUrl(url) {
  const m = String(url).match(/\/c\/([^/?#]+)/);
  if (!m) return '';
  let slug = m[1];
  // If there's a _ subcategory separator, use the subcategory part
  if (slug.includes('_')) {
    slug = slug.split('_').pop();
  }
  return slug
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/**
 * Extract the numeric listing ID from a detail page URL.
 * @param {string} url
 * @returns {string|null}
 */
function listingIdFromUrl(url) {
  const m = url.match(/\/(\d{5,})(?:[?#]|$)/);
  return m ? m[1] : null;
}

/**
 * Build a stable external_id from a listing ID.
 * @param {string} url
 * @returns {string}
 */
function externalIdFromUrl(url) {
  const id = listingIdFromUrl(url);
  if (id) return `propertyroom-${id}`;
  const parts = new URL(url).pathname.split('/').filter(Boolean);
  return `propertyroom-${parts[parts.length - 1] || 'unknown'}`;
}

// ─── DOM helpers (Cheerio) ───────────────────────────────────────────────────

/**
 * Try a list of CSS selectors, return the first non-empty text match.
 * @param {import('cheerio').CheerioAPI} $
 * @param {string[]} selectors
 * @returns {string}
 */
function firstText($, selectors) {
  for (const sel of selectors) {
    try {
      const el = $(sel).first();
      if (el.length) {
        const text = el.text().trim();
        if (text) return text;
      }
    } catch {
      // selector invalid — try next
    }
  }
  return '';
}

/**
 * Collect ALL image URLs from the HTML using multiple strategies.
 * Does NOT early-return — merges results across all selectors.
 *
 * @param {import('cheerio').CheerioAPI} $
 * @param {string[]} selectors - CSS selectors targeting img elements
 * @returns {string[]}
 */
function allImageSrcs($, selectors) {
  const seen = new Set();
  const results = [];

  const JUNK_IMG_RE = /\/(thumbnails-navigation|icon-magnifying|quick-links|pagination-|logo|favicon|sprite|placeholder|loading|banner)/i;
  const MERCHANT_BANNER_RE = /\/banners\/merchants\//i;

  function add(url) {
    if (!url) return;
    const cleaned = url.trim();
    if (!cleaned || cleaned.startsWith('data:') || seen.has(cleaned)) return;
    if (JUNK_IMG_RE.test(cleaned)) return;
    if (MERCHANT_BANNER_RE.test(cleaned)) return;
    if (cleaned.endsWith('/undefined') || cleaned.endsWith('/null')) return;
    if (/^\/images\//i.test(cleaned)) return;
    if (/^https?:\/\/[^/]+\/images\/\d+$/.test(cleaned)) return;
    seen.add(cleaned);
    results.push(cleaned);
  }

  function bestFromSrcset(srcset) {
    if (!srcset) return '';
    let best = '';
    let bestW = 0;
    for (const entry of srcset.split(',')) {
      const parts = entry.trim().split(/\s+/);
      const url = parts[0] || '';
      const w = parseInt(parts[1], 10) || 0;
      if (url && w > bestW) {
        bestW = w;
        best = url;
      }
    }
    return best || (srcset.split(',')[0] || '').trim().split(/\s+/)[0] || '';
  }

  // Strategy 1: CSS selectors → img element attributes
  for (const sel of selectors) {
    try {
      $(sel).each((_, el) => {
        const $el = $(el);
        add($el.attr('src'));
        add($el.attr('data-src'));
        add($el.attr('data-lazy-src'));
        add($el.attr('data-lazysrc'));
        add($el.attr('data-original'));
        const fromSrcset = bestFromSrcset($el.attr('srcset') || $el.attr('data-srcset'));
        add(fromSrcset);
      });
    } catch {
      // continue
    }
  }

  // Strategy 2: background-image on known gallery containers
  const bgSelectors = [
    '.sp-wrap [style]', '.gallery [style]', '[class*="slide"] [style]',
    '[class*="carousel"] [style]', '[class*="photo"] [style]',
  ];
  for (const sel of bgSelectors) {
    try {
      $(sel).each((_, el) => {
        const style = $(el).attr('style') || '';
        const m = style.match(/url\(["']?(.+?)["']?\)/);
        if (m?.[1]) add(m[1]);
      });
    } catch {
      // continue
    }
  }

  // Strategy 3: JSON-LD Product.image
  try {
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const obj = JSON.parse($(el).html() ?? '');
        const items = Array.isArray(obj) ? obj : [obj];
        for (const item of items) {
          if (item['@type'] === 'Product' || item['@type'] === 'Offer') {
            const imgs = item.image;
            if (typeof imgs === 'string') add(imgs);
            else if (Array.isArray(imgs)) imgs.forEach((u) => add(typeof u === 'string' ? u : u?.url));
          }
        }
      } catch { /* malformed JSON */ }
    });
  } catch { /* no scripts */ }

  // Strategy 4: og:image meta
  try {
    const ogImg = $('meta[property="og:image"]').attr('content');
    if (ogImg) add(ogImg);
  } catch { /* */ }

  return results;
}

/**
 * Extract the first JSON-LD block of a given @type from the HTML.
 * @param {import('cheerio').CheerioAPI} $
 * @param {string} type
 * @returns {object|null}
 */
function extractJsonLd($, type) {
  try {
    let found = null;
    $('script[type="application/ld+json"]').each((_, el) => {
      if (found) return;
      try {
        const obj = JSON.parse($(el).html() ?? '');
        const arr = Array.isArray(obj) ? obj : [obj];
        for (const item of arr) {
          if (item['@type'] === type) { found = item; return; }
        }
      } catch { /* malformed JSON */ }
    });
    return found;
  } catch {
    return null;
  }
}

/**
 * Read a meta tag content value.
 * @param {import('cheerio').CheerioAPI} $
 * @param {string} key
 * @returns {string}
 */
function metaContent($, key) {
  try {
    return $(`meta[name="${key}"], meta[property="${key}"]`).first().attr('content') ?? '';
  } catch {
    return '';
  }
}

/**
 * Extract a number that follows a label in the page text.
 * @param {import('cheerio').CheerioAPI} $
 * @param {string[]} labels
 * @returns {number|null}
 */
function extractNumberAfterLabel($, labels) {
  try {
    const bodyText = $('body').text() || '';
    for (const label of labels) {
      const idx = bodyText.toLowerCase().indexOf(label.toLowerCase());
      if (idx === -1) continue;
      const afterLabel = bodyText.slice(idx + label.length);
      const m = afterLabel.match(/^[:\s]*[\$£€]?\s*([\d,]+\.?\d*)/);
      if (m) {
        const n = parseFloat(m[1].replace(/,/g, ''));
        if (isFinite(n) && n > 0) return n;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Check if a label match is at a word boundary (not inside a longer word).
 * e.g. "Condition" should NOT match inside "Conditioning" or "Conditions".
 */
function isWordBoundaryMatch(text, matchIdx, labelLength) {
  const charBefore = matchIdx > 0 ? text[matchIdx - 1] : ' ';
  const charAfter = text[matchIdx + labelLength];
  const beforeOk = !charBefore || /[^a-zA-Z]/.test(charBefore);
  const afterOk = !charAfter || /[^a-zA-Z]/.test(charAfter);
  return beforeOk && afterOk;
}

/**
 * Extract text that follows a label in the page text.
 * Uses word-boundary matching to avoid partial matches like
 * "Conditioning" → "ing" or "Conditions" → "s".
 *
 * @param {import('cheerio').CheerioAPI} $
 * @param {string[]} labels
 * @returns {string}
 */
function extractTextAfterLabel($, labels) {
  try {
    const bodyText = $('body').text() || '';
    const bodyLower = bodyText.toLowerCase();

    for (const label of labels) {
      const lowerLabel = label.toLowerCase();
      // Search for all occurrences with word boundary check
      let searchFrom = 0;
      while (searchFrom < bodyLower.length) {
        const idx = bodyLower.indexOf(lowerLabel, searchFrom);
        if (idx === -1) break;

        if (isWordBoundaryMatch(bodyLower, idx, lowerLabel.length)) {
          const afterLabel = bodyText.slice(idx + label.length);
          const m = afterLabel.match(/^[:\s]+(.+?)(?:\n|$)/);
          if (m) {
            const val = m[1].trim();
            if (val && val.length < 200) return val;
          }
        }
        searchFrom = idx + 1;
      }
    }

    // Fallback: check leaf elements
    for (const label of labels) {
      const lowerLabel = label.toLowerCase();
      let found = '';
      $('*').each((_, el) => {
        if (found) return;
        const $el = $(el);
        if ($el.children().length > 0) return; // leaf nodes only
        const t = $el.text().trim().toLowerCase();

        // Find the label with word boundary check
        let searchFrom = 0;
        while (searchFrom < t.length) {
          const matchIdx = t.indexOf(lowerLabel, searchFrom);
          if (matchIdx === -1) break;

          if (isWordBoundaryMatch(t, matchIdx, lowerLabel.length)) {
            const fullText = $el.text().trim();
            const afterIdx = matchIdx + lowerLabel.length;
            const rest = fullText.slice(afterIdx).replace(/^[:\s]+/, '').trim();
            if (rest && rest.length > 0 && rest.length < 200) {
              found = rest;
              return;
            }
            // Check next sibling
            const next = $el.next();
            if (next.length) {
              const nxt = next.text().trim();
              if (nxt && nxt.length < 200) {
                found = nxt;
                return;
              }
            }
          }
          searchFrom = matchIdx + 1;
        }
      });
      if (found) return found;
    }
    return '';
  } catch {
    return '';
  }
}

/**
 * Round a number to at most 2 decimal places.
 */
function roundTo2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Read an element's text keeping block structure: paragraphs, divs, list items and
 * table rows become separate lines, and a table row "Brand: | Meta" becomes "Brand: Meta".
 * Plain .text() runs everything together ("Type: SystemBrand: Meta...").
 * @param {import('cheerio').CheerioAPI} $
 * @param {string} selector
 * @returns {string}
 */
export function blockText($, selector) {
  const el = $(selector).first();
  if (!el.length) return '';
  const clone = el.clone();
  clone.find('script, style, noscript').remove();
  clone.find('br').replaceWith('\n');
  clone.find('th, td').each((_, cell) => {
    $(cell).append(' ');
  });
  clone.find('p, div, li, tr, h1, h2, h3, h4, h5, h6, table, ul, ol').each((_, block) => {
    $(block).append('\n');
  });
  return clone
    .text()
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/**
 * Clean up description text.
 */
function cleanDescriptionText(text) {
  if (!text) return '';
  return text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+|\s+$/gm, '')
    .trim();
}

/**
 * Strip boilerplate sections from a PropertyRoom description.
 */
function stripBoilerplate(text) {
  if (!text) return '';
  const BOILERPLATE_HEADINGS = [
    'Shipping and Returns',
    'Payment and Sales Tax',
    'Warranties and Disclaimer',
    'Contact Information',
    'Please Click on the Logo Below',
    'View information on item conditions',
  ];
  let cutIndex = text.length;
  for (const heading of BOILERPLATE_HEADINGS) {
    const idx = text.indexOf(heading);
    if (idx !== -1 && idx < cutIndex) {
      cutIndex = idx;
    }
  }
  if (cutIndex === text.length) return text;
  return text.slice(0, cutIndex).trim();
}

/**
 * Extract a pickup/warehouse location from free-form text.
 */
function extractPickupLocationFromText(text) {
  if (!text) return null;
  const warehouseRe = /(?:warehouse|facility|location)\s+in\s+([A-Za-z][A-Za-z .'-]+,\s*[A-Za-z][a-zA-Z ]*[a-zA-Z])(?:\s+\d{5})?/i;
  const m1 = text.match(warehouseRe);
  if (m1) return normalizeLocationText(m1[1]);
  const pickupRe = /Pick[-\s]?up.*?available.*?in\s+([A-Za-z][A-Za-z .'-]+,\s*[A-Za-z][a-zA-Z ]*[a-zA-Z])(?:\s+\d{5})?/i;
  const m2 = text.match(pickupRe);
  if (m2) return normalizeLocationText(m2[1]);
  return null;
}

function normalizeLocationText(raw) {
  let loc = raw.trim().replace(/\s+/g, ' ');
  loc = loc.replace(/\s+\d{5}$/, '');
  return loc;
}

/**
 * Extract JavaScript variables declared in inline <script> blocks.
 * @param {import('cheerio').CheerioAPI} $
 * @param {string[]} varNames
 * @returns {Record<string, string>}
 */
function extractJsVars($, varNames) {
  try {
    const result = {};
    let allText = '';
    $('script:not([src])').each((_, el) => {
      allText += ($(el).html() ?? '') + '\n';
    });
    for (const name of varNames) {
      const re = new RegExp(`(?:var|let|const)\\s+${name}\\s*=\\s*(?:['"](.+?)['"]|(\\d+\\.?\\d*)|([^;]+))\\s*;`);
      const m = allText.match(re);
      if (m) {
        result[name] = (m[1] ?? m[2] ?? m[3] ?? '').trim();
      }
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * Extract all key-value attributes from the HTML.
 * @param {import('cheerio').CheerioAPI} $
 * @returns {Record<string, string>}
 */
function extractAllAttributes($) {
  const result = {};

  const JUNK_KEY_PATTERNS = /^(home|back|next|previous|sign in|log in|register|add to cart|bid now|buy now|share|print|report|help|menu|search|loading|copyright|follow us|subscribe|×|close|ok|cancel|submit|see all|payment|disclaimer|warranties|time left|time remaining|ends in|number of bids|bids?|high bidder|page views|views)/i;

  function addKV(key, val) {
    let k = (key ?? '').trim().replace(/\s+/g, ' ');
    const v = (val ?? '').trim().replace(/\s+/g, ' ');
    k = k.replace(/[:.;]+$/, '').trim();
    if (!k || !v || k.length > 60 || v.length > 300) return;
    if (JUNK_KEY_PATTERNS.test(k)) return;
    if (/^\d+$/.test(k)) return;
    if (k.includes('@') || k.startsWith('http')) return;
    result[k] = v;
  }

  // Strategy 1: <li> items with "Key: Value" pattern
  $('li').each((_, el) => {
    const $el = $(el);
    if ($el.find('ul, ol, li').length) return; // skip nested lists
    const text = $el.text().trim();
    const colonIdx = text.indexOf(':');
    if (colonIdx > 0 && colonIdx < 60 && text.length < 300) {
      const key = text.slice(0, colonIdx).trim();
      const val = text.slice(colonIdx + 1).trim();
      if (key && val && key.length > 1) {
        addKV(key, val);
      }
    }
  });

  // Strategy 2: Any table with key-value rows
  $('table tr').each((_, el) => {
    const cells = $(el).find('th, td');
    if (cells.length >= 2) {
      const key = cells.eq(0).text().trim();
      const val = cells.eq(1).text().trim();
      if (key.length > 1 && key.length < 60 && val) {
        addKV(key, val);
      }
    }
  });

  // Strategy 3: Any dl/dt/dd definition list
  $('dt').each((_, el) => {
    const $dt = $(el);
    const $dd = $dt.next('dd');
    if ($dd.length) {
      addKV($dt.text().trim(), $dd.text().trim());
    }
  });

  // Strategy 4: Embedded JSON state objects
  try {
    $('script:not([src])').each((_, el) => {
      const text = $(el).html() ?? '';
      if (text.includes('__NEXT_DATA__')) {
        const m = text.match(/__NEXT_DATA__\s*=\s*({[\s\S]+?})\s*;?\s*$/);
        if (m) {
          try {
            const data = JSON.parse(m[1]);
            const props = data?.props?.pageProps ?? {};
            if (props.itemSpecifics && typeof props.itemSpecifics === 'object') {
              for (const [k, v] of Object.entries(props.itemSpecifics)) {
                addKV(k, String(v));
              }
            }
          } catch { /* */ }
        }
      }
    });
  } catch { /* */ }

  return result;
}

// ─── Pricing extraction ──────────────────────────────────────────────────────

/**
 * Parse a dollar text like "US $599.00" → number, or null.
 */
function parseDollarText(text) {
  if (!text) return null;
  const s = text.trim();
  if (/not\s*applicable/i.test(s)) return null;
  const m = s.match(/\$\s*([\d,]+\.?\d*)/);
  if (m) {
    const n = parseFloat(m[1].replace(/,/g, ''));
    return isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Extract structured pricing from a PropertyRoom detail page.
 * @param {import('cheerio').CheerioAPI} $
 * @param {Record<string, string>} jsVars
 */
function extractPricing($, jsVars) {
  let priceLabel = '';
  let priceValue = null;

  // Strategy 1: Specific IDs (most reliable)
  const labelEl = $('#MainContent_uxTypeOfPrice');
  const priceEl = $('#MainContent_uxPrice');

  if (labelEl.length) {
    priceLabel = labelEl.text().trim();
  }
  if (priceEl.length) {
    const text = priceEl.text().trim();
    const m = text.match(/\$\s*([\d,]+\.?\d*)/);
    if (m) priceValue = parseFloat(m[1].replace(/,/g, ''));
  }

  // Strategy 2: Fallback — scan for price label elements
  if (!priceLabel || priceValue === null) {
    const labels = ['Buy Now Price', 'Current Price', 'Current Bid', 'Starting Bid', 'Starting Price'];
    $('li, div, span').each((_, el) => {
      if (priceLabel && priceValue !== null) return;
      const t = $(el).text().trim();
      for (const lbl of labels) {
        if (t.toLowerCase() === lbl.toLowerCase()) {
          if (!priceLabel) priceLabel = t;
          if (priceValue === null) {
            const next = $(el).next();
            if (next.length) {
              const pm = next.text().match(/\$\s*([\d,]+\.?\d*)/);
              if (pm) priceValue = parseFloat(pm[1].replace(/,/g, ''));
            }
          }
          break;
        }
      }
    });
  }

  // Strategy 3: Fallback — div.current-price-propductpage
  if (priceValue === null) {
    const container = $('.current-price-propductpage');
    if (container.length) {
      const m = container.text().match(/\$\s*([\d,]+\.?\d*)/);
      if (m) priceValue = parseFloat(m[1].replace(/,/g, ''));
    }
  }

  // Strategy 4: Fallback — itemprop
  if (priceValue === null) {
    const priceItemprop = $('[itemprop="price"]');
    if (priceItemprop.length) {
      const val = priceItemprop.attr('content') || priceItemprop.text().trim();
      const m = String(val).match(/([\d,]+\.?\d*)/);
      if (m) priceValue = parseFloat(m[1].replace(/,/g, ''));
    }
  }

  const listingFormat = (jsVars.LISTING_FORMAT || '').toLowerCase();
  const label = (priceLabel || '').toLowerCase();
  const value = priceValue !== null && isFinite(priceValue) ? priceValue : null;

  let buy_now_price = null;
  let current_bid = null;
  let starting_bid = null;

  if (label.includes('buy now') || listingFormat === 'fixed price') {
    buy_now_price = value;
  } else if (label.includes('current bid') || label.includes('current price')) {
    current_bid = value;
  } else if (label.includes('starting bid') || label.includes('starting price')) {
    starting_bid = value;
  } else if (value !== null) {
    if (listingFormat === 'auction') {
      current_bid = value;
    } else {
      buy_now_price = value;
    }
  }

  let price_source = 'unknown';
  let current_price = 0;

  if (buy_now_price !== null) {
    current_price = buy_now_price;
    price_source = 'buy_now';
  } else if (current_bid !== null) {
    current_price = current_bid;
    price_source = 'current_bid';
  } else if (starting_bid !== null) {
    current_price = starting_bid;
    price_source = 'starting_bid';
  }

  return { buy_now_price, current_bid, starting_bid, price_source, current_price };
}

// ─── Shipping extraction ─────────────────────────────────────────────────────

/**
 * Extract structured shipping options from a PropertyRoom detail page.
 * @param {import('cheerio').CheerioAPI} $
 */
function extractShippingOptions($) {
  const rawShipping = [];

  // Strategy 1: Specific IDs (most reliable)
  const SLOTS = [
    { id: 'MainContent_lblCustomerPrickupShipPrice', method: 'Customer Pick-up' },
    { id: 'MainContent_lblStandardShipPrice', method: 'Standard Shipping' },
    { id: 'MainContent_lblExpeditedShipPrice', method: 'Expedited Shipping' },
  ];

  for (const slot of SLOTS) {
    const el = $(`#${slot.id}`);
    if (el.length) {
      rawShipping.push({ method: slot.method, rawText: el.text().trim() });
    }
  }

  // Strategy 2: Fallback — scan for shipping-related <li> pairs
  if (rawShipping.length === 0) {
    const shippingMethods = [
      { pattern: /customer\s*pick/i, method: 'Customer Pick-up' },
      { pattern: /standard\s*shipping/i, method: 'Standard Shipping' },
      { pattern: /expedited\s*shipping/i, method: 'Expedited Shipping' },
      { pattern: /express\s*shipping/i, method: 'Express Shipping' },
      { pattern: /freight/i, method: 'Freight' },
    ];

    $('li').each((_, el) => {
      const text = $(el).text().trim();
      for (const sm of shippingMethods) {
        if (sm.pattern.test(text) && text.length < 200) {
          const nextLi = $(el).next('li');
          const priceText = nextLi.length ? nextLi.text().trim() : '';
          rawShipping.push({ method: sm.method, rawText: priceText || text });
        }
      }
    });
  }

  const shipping_options = rawShipping.map((raw) => {
    const price = parseDollarText(raw.rawText);
    const applicable = !/not\s*applicable/i.test(raw.rawText) && price !== null;
    return { method: raw.method, price: applicable ? price : null, applicable };
  });

  const PICKUP_RE = /pick[\s-]*up/i;
  const nonPickupApplicable = shipping_options.filter(
    (o) => o.applicable && Number.isFinite(o.price) && !PICKUP_RE.test(o.method),
  );

  const estimated_shipping = nonPickupApplicable.length > 0
    ? Math.min(...nonPickupApplicable.map((o) => o.price))
    : null;

  return { shipping_options, estimated_shipping };
}

/**
 * Extract the shipping weight shown in the Delivery Options notes panel.
 * PropertyRoom renders this as text like "Shipping Weight: 19 pounds (...)".
 * @param {import('cheerio').CheerioAPI} $
 */
function extractShippingWeight($) {
  const candidates = [];

  const addCandidate = (text) => {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (normalized) candidates.push(normalized);
  };

  // Prefer compact leaf nodes so the note text is not diluted by the whole page.
  $('p, div, span, td, li').each((_, el) => {
    const $el = $(el);
    if ($el.children().length > 4) return;
    const text = $el.text();
    if (/shipping\s*weight/i.test(text)) addCandidate(text);
  });

  addCandidate($('body').text());

  for (const text of candidates) {
    const match = text.match(
      /shipping\s*weight\s*:\s*([\d,.]+)\s*(pounds?|lbs?\.?|ounces?|oz\.?|kilograms?|kgs?\.?|grams?|g)\b/i,
    );
    if (!match) continue;

    const value = parseFloat(match[1].replace(/,/g, ''));
    if (!Number.isFinite(value) || value <= 0) continue;

    const unitRaw = match[2].replace(/\./g, '').toLowerCase();
    let unit = unitRaw;
    let pounds = null;

    if (/^(pound|pounds|lb|lbs)$/.test(unitRaw)) {
      unit = value === 1 ? 'pound' : 'pounds';
      pounds = value;
    } else if (/^(ounce|ounces|oz)$/.test(unitRaw)) {
      unit = value === 1 ? 'ounce' : 'ounces';
      pounds = value / 16;
    } else if (/^(kilogram|kilograms|kg|kgs)$/.test(unitRaw)) {
      unit = value === 1 ? 'kilogram' : 'kilograms';
      pounds = value * 2.2046226218;
    } else if (/^(gram|grams|g)$/.test(unitRaw)) {
      unit = value === 1 ? 'gram' : 'grams';
      pounds = value * 0.0022046226218;
    }

    const noteMatch = text.match(/shipping\s*weight\s*:[\s\S]*?(?=(?:Please\s+carefully|Shipping\s+is\s+only|$))/i);
    const noteText = noteMatch ? noteMatch[0].trim() : `Shipping Weight: ${value} ${unit}`;

    return {
      shipping_weight: `${value} ${unit}`,
      shipping_weight_value: value,
      shipping_weight_unit: unit,
      shipping_weight_lbs: pounds === null ? null : roundTo2(pounds),
      shipping_weight_note: noteText,
    };
  }

  return {
    shipping_weight: '',
    shipping_weight_value: null,
    shipping_weight_unit: '',
    shipping_weight_lbs: null,
    shipping_weight_note: '',
  };
}

// ─── 2026 listing layout ─────────────────────────────────────────────────────

/**
 * Read the fields PropertyRoom's 2026 listing layout exposes: window.* page variables
 * (exact UTC end date, current price), the price block, the stats panel and the
 * shipping tab table. Every value is null when the element is absent (old layout).
 * @param {import('cheerio').CheerioAPI} $
 */
export function extractListingLayout2026($) {
  let scripts = '';
  $('script:not([src])').each((_, el) => {
    scripts += ($(el).html() ?? '') + '\n';
  });
  const pageVar = (name) => {
    const m = scripts.match(new RegExp(`window\\.${name}\\s*=\\s*(?:"([^"]*)"|([^;\\n]+))\\s*;`));
    if (!m) return null;
    return (m[1] ?? m[2] ?? '').trim() || null;
  };
  const money = (text) => {
    const m = String(text ?? '').match(/\$\s*([\d,]+(?:\.\d+)?)/);
    return m ? parseFloat(m[1].replace(/,/g, '')) : null;
  };

  const endIso = pageVar('listingEndDate');
  const endDate = endIso ? new Date(endIso) : null;
  const currentPriceVar = Number.parseFloat(pageVar('listingCurrentPrice') ?? '');

  const priceLabel = $('.price-block .price-label').first().text().trim() || null;
  const priceValue = money($('.price-block .price-value').first().text());
  const bidIncrement = money($('.price-block .increment-value').first().text());

  const stats = {};
  $('.stat-item').each((_, el) => {
    const label = $(el).find('.stat-label').first().text().trim();
    const num = Number.parseInt($(el).find('.stat-number').first().text().replace(/[^\d]/g, ''), 10);
    if (label && Number.isFinite(num)) stats[label] = num;
  });

  const shippingOptions = [];
  $('#tab-shipping tr').each((_, tr) => {
    const cells = $(tr).find('td');
    if (cells.length < 2) return;
    const method = cells.eq(0).text().replace(/\s+/g, ' ').trim();
    const priceText = cells.eq(1).text().replace(/\s+/g, ' ').trim();
    if (!method || /delivery methods|^price$/i.test(method)) return;
    const price = money(priceText);
    const applicable = !/not\s*available|not\s*applicable/i.test(priceText) && price !== null;
    shippingOptions.push({ method, price: applicable ? price : null, applicable, raw: priceText });
  });

  return {
    page_vars: {
      listingId: pageVar('listingId'),
      listingSlug: pageVar('listingSlug'),
      listingEndDate: endIso,
      listingCurrentPrice: Number.isFinite(currentPriceVar) ? currentPriceVar : null,
    },
    end_time_iso: endDate && !Number.isNaN(endDate.getTime()) ? endDate.toISOString() : null,
    price_label: priceLabel,
    price_value: priceValue ?? (Number.isFinite(currentPriceVar) ? currentPriceVar : null),
    bid_increment: bidIncrement,
    stats,
    bid_count: Number.isFinite(stats['Total Bid(s)']) ? stats['Total Bid(s)'] : null,
    shipping_options: shippingOptions,
  };
}

// ─── Shipping self-test (runs once on import) ────────────────────────────────
(function shippingSelfTest() {
  const PICKUP_RE = /pick[\s-]*up/i;
  function computeInbound(options) {
    const valid = options.filter(
      (o) => o.applicable && Number.isFinite(o.price) && !PICKUP_RE.test(o.method),
    );
    return valid.length > 0 ? Math.min(...valid.map((o) => o.price)) : null;
  }

  const cases = [
    {
      label: 'pickup $0 + standard $16.95 + expedited $30.95',
      opts: [
        { method: 'Customer Pick-up', price: 0, applicable: true },
        { method: 'Standard Shipping', price: 16.95, applicable: true },
        { method: 'Expedited Shipping', price: 30.95, applicable: true },
      ],
      expected: 16.95,
    },
    {
      label: 'standard $14.99 only',
      opts: [{ method: 'Standard Shipping', price: 14.99, applicable: true }],
      expected: 14.99,
    },
    {
      label: 'pickup $0 only',
      opts: [{ method: 'Customer Pick-up', price: 0, applicable: true }],
      expected: null,
    },
    {
      label: 'no options',
      opts: [],
      expected: null,
    },
  ];

  for (const { label, opts, expected } of cases) {
    const result = computeInbound(opts);
    if (result !== expected) {
      throw new Error(`[shipping-self-test] FAIL "${label}": expected ${expected}, got ${result}`);
    }
  }
})();

// ─── Detail page extraction ───────────────────────────────────────────────────

/**
 * Extract all fields from a PropertyRoom item detail page.
 *
 * @param {import('cheerio').CheerioAPI} $
 * @param {string} url
 * @param {boolean} debug
 * @param {object} log
 * @param {string} [indexCategory] - Category inferred from the index page URL
 * @returns {object}
 */
export function extractDetailPage($, url, debug, log, indexCategory) {
  // ── Layer 1: JS variables ─────────────────────────────────────────────────
  const jsVars = extractJsVars($, [
    'LISTING_ID', 'LISTING_TITLE', 'LISTING_FORMAT',
    'HAS_FREE_SHIPPING', 'CONTENT_IMAGE_PATH',
  ]);

  const listingId = jsVars.LISTING_ID || listingIdFromUrl(url);
  const jsTitle = jsVars.LISTING_TITLE || '';

  if (debug) {
    log.debug(`JS vars extracted`, { listingId, jsTitle: jsTitle.slice(0, 60), format: jsVars.LISTING_FORMAT });
  }

  // ── Layer 2: JSON-LD ──────────────────────────────────────────────────────
  const productLd = extractJsonLd($, 'Product');
  const offerLd = productLd?.offers ?? extractJsonLd($, 'Offer');

  // ── Layer 3: Meta tags ────────────────────────────────────────────────────
  const ogTitle = metaContent($, 'og:title');
  const ogDescription = metaContent($, 'og:description');
  const ogImage = metaContent($, 'og:image');

  // ── Layer 4 + 5: CSS selectors + label extraction ─────────────────────────
  const title = jsTitle
    || productLd?.name
    || ogTitle
    || firstText($, ['h1', '.item-title', 'h1[class*="title"]', '[itemprop="name"]', '.listing-title']);

  // PropertyRoom's 2026 tabbed layout puts the full description in #tab-description;
  // the JSON-LD/og summaries are only a one-line snippet, so they are fallbacks.
  const description =
    blockText($, '#tab-description')
    || productLd?.description
    || ogDescription
    || firstText($, [
      '.bodyContent', '.disclaimerContent', '[itemprop="description"]',
      '.item-description', '#item-description', '.description-text',
      '.lot-description', '.product-description',
    ]);

  // Category — multi-strategy extraction
  let category = '';

  // Strategy 1: Look for breadcrumb links with subcategory paths (most specific)
  // e.g. /c/electronics_cameras is more specific than /c/electronics
  const subcategoryLinks = $('a[href*="/c/"]').filter((_, el) => {
    const href = $(el).attr('href') || '';
    return href.includes('_'); // subcategory paths have underscores
  });
  if (subcategoryLinks.length > 0) {
    category = subcategoryLinks.last().text().trim();
  }

  // Strategy 2: Top-level breadcrumb /c/ links (excluding global nav duplicates)
  // Pick the first /c/ link that appears inside the main content area
  if (!category) {
    const contentArea = $('#MainContent, .main-content, [role="main"], #content');
    if (contentArea.length) {
      const contentBreadcrumbs = contentArea.find('a[href*="/c/"]');
      if (contentBreadcrumbs.length > 0) {
        category = contentBreadcrumbs.last().text().trim();
      }
    }
  }

  // Strategy 3: Fall back to general breadcrumb selectors
  if (!category) {
    const breadcrumbs = $('.breadcrumb a, nav[aria-label="breadcrumb"] a');
    if (breadcrumbs.length > 0) {
      category = breadcrumbs.last().text().trim();
    }
  }

  // Strategy 4: itemprop / CSS class selectors
  if (!category) {
    category = firstText($, ['[itemprop="category"]', '.item-category']);
  }

  // Strategy 5: Use index page category passed via userData (most reliable)
  if (!category && indexCategory) {
    category = indexCategory;
  }

  // Condition — multi-strategy
  let condition =
    extractTextAfterLabel($, ['Physical Condition', 'Condition', 'Item Condition'])
    || firstText($, ['[itemprop="itemCondition"]', '.item-condition', '.condition-value'])
    || '';

  // Location — multi-strategy
  let location = '';
  let location_source = 'none';

  const labelLocation = extractTextAfterLabel($, ['Shipping From', 'Ships From']);
  if (labelLocation && labelLocation.trim()) {
    location = labelLocation.trim();
    location_source = 'label';
  }

  if (!location) {
    const bodyText = $('body').text() || '';
    const pickupLoc = extractPickupLocationFromText(bodyText);
    if (pickupLoc) {
      location = pickupLoc;
      location_source = 'pickup_text';
    }
  }

  if (!location) {
    const cssLocation = firstText($, ['[itemprop="addressLocality"]', '.item-location', '.seller-location']);
    if (cssLocation && cssLocation.trim()) {
      location = cssLocation.trim();
      location_source = 'css_selector';
    }
  }

  // ── Layer 6: Structured pricing ────────────────────────────────────────────
  const pricingData = extractPricing($, jsVars);
  const layout = extractListingLayout2026($);
  if (!pricingData.current_price && layout.price_value !== null) {
    pricingData.current_price = layout.price_value;
    pricingData.price_source = 'page_price_block';
  }
  // Price type for the required-bid rule: an auction with 0 bids shows its opening bid.
  let priceType = pricingData.price_source;
  if (pricingData.buy_now_price !== null || /buy\s*now/i.test(layout.price_label ?? '')) {
    priceType = 'buy_now';
  } else if (layout.bid_count === 0) {
    priceType = 'starting_bid';
  } else if (layout.bid_count > 0) {
    priceType = 'current_bid';
  }

  // Buyer's premium
  const buyersPremiumRaw = extractNumberAfterLabel($, [
    "Buyer's Premium", 'Buyers Premium', 'Buyer Premium', 'Premium', 'BP:',
  ]);

  // ── Layer 6b: Structured shipping ──────────────────────────────────────────
  let shippingData = extractShippingOptions($);
  if (layout.shipping_options.length) {
    // 2026 layout: the Shipping tab table is the source of truth.
    const PICKUP = /pick[\s-]*up/i;
    const options = layout.shipping_options.map(({ method, price, applicable }) => ({ method, price, applicable }));
    const shippable = options.filter((o) => o.applicable && Number.isFinite(o.price) && !PICKUP.test(o.method));
    shippingData = {
      shipping_options: options,
      estimated_shipping: shippable.length ? Math.min(...shippable.map((o) => o.price)) : null,
    };
  }
  const shippingWeightData = extractShippingWeight($);

  // Shipping method for the required-shipping rule.
  const pickupAvailable = shippingData.shipping_options.some((o) => o.applicable && /pick[\s-]*up/i.test(o.method));
  const shippingMethod = shippingData.estimated_shipping !== null
    ? 'shipping'
    : (pickupAvailable ? 'pickup_only' : null);

  // End time (2026 layout: exact UTC from window.listingEndDate, no time-zone guessing)
  let endTimeRaw = layout.end_time_iso || '';

  // Strategy 1: data attributes
  const timerSels = ['[data-end-time]', '[data-endtime]', '[data-expires]', '[data-countdown]', 'time[datetime]'];
  for (const sel of endTimeRaw ? [] : timerSels) {
    const el = $(sel).first();
    if (el.length) {
      const attr = el.attr('data-end-time') || el.attr('data-endtime') || el.attr('data-expires') || el.attr('datetime');
      if (attr) { endTimeRaw = attr; break; }
    }
  }

  // Strategy 2: "Ends ... at ..." text pattern
  if (!endTimeRaw) {
    const bodyText = $('body').text() || '';
    const endsMatch = bodyText.match(/Ends?\s+([A-Za-z]{3}\s+\d{1,2},?\s+\d{4}\s+at\s+\d{1,2}:\d{2}\s*(?:AM|PM)\s*\(?[A-Za-z]*\)?)/i);
    if (endsMatch) endTimeRaw = endsMatch[1].replace(/[()]/g, '').trim();
  }

  // Strategy 3: broader pattern
  if (!endTimeRaw) {
    const bodyText = $('body').text() || '';
    const m = bodyText.match(/(?:ends?|closes?|closing|auction end)[:\s]+([A-Za-z0-9 :,/\-.]+?(?:AM|PM|EST|EDT|PST|PDT|GMT|UTC|Eastern|Pacific|Central))/i);
    if (m) endTimeRaw = m[1].trim();
  }

  // Images
  const imageSelectors = [
    '.sp-wrap img', '.sp-thumbs img',
    '.gallery img', '.photo-gallery img', '.carousel img', '.slider img', '.thumbnail-list img',
    '[class*="gallery"] img', '[class*="photo"] img', '[class*="image"] img',
    '[class*="slide"] img', '[class*="carousel"] img',
    '.product-image img', '.product-image-container img', '.item-images img',
    '[itemprop="image"]',
    '#MainContent img[src*="content.propertyroom.com"]',
    'img[src*="content.propertyroom.com"]',
  ];
  const imageUrls = allImageSrcs($, imageSelectors);

  // Attributes
  const attributes = extractAllAttributes($);

  // Lot number
  const lotNumber = attributes['Lot'] || attributes['Lot Number'] || attributes['Lot #'] || null;

  // External ID
  const primaryId = listingId || listingIdFromUrl(url) || 'unknown';
  const externalId = lotNumber
    ? `propertyroom-${primaryId}-${lotNumber}`
    : `propertyroom-${primaryId}`;

  // The seller's spec table ("Condition: Used") beats free-text label matching, which on the
  // 2026 layout can latch onto the breadcrumb ("Home › Electronics › ...").
  const specCondition = attributes['Physical Condition'] || attributes['Condition'] || attributes['Item Condition'] || '';
  if (specCondition) {
    condition = specCondition;
  } else if (/[›\n]/.test(condition) || condition.length > 80) {
    condition = '';
  }

  // Use attribute-extracted condition as fallback before deleting from attributes
  if (!condition) {
    condition = attributes['Physical Condition']
      || attributes['Condition']
      || attributes['Item Condition']
      || '';
  }

  // Final fallback: mine condition from description text and meta description.
  // Some sellers (e.g. seller 888889040) only mention condition inline in description
  // like "Brand new", "Used", "Refurbished" without any structured label.
  if (!condition) {
    const descText = (description || '') + ' ' + ($('meta[name="description"]').attr('content') || '');
    const conditionPatterns = [
      // Order matters: most specific first.
      // Use (?:^|[^a-zA-Z]) instead of \b to handle concatenated seller text
      // like "$549.00Brand New" or "wipesBrand NewPlease"
      { re: /(?:^|[^a-zA-Z])(new\s+in\s+(?:sealed\s+)?box)(?:[^a-zA-Z]|$)/i, val: 'New in box' },
      { re: /(?:^|[^a-zA-Z])(new\s*\(?\s*open\s*box\s*\)?)(?:[^a-zA-Z]|$)/i, val: 'New (Open Box)' },
      { re: /(?:^|[^a-zA-Z])(new\s*\(?\s*sealed\s*\)?)(?:[^a-zA-Z]|$)/i, val: 'New (Sealed)' },
      { re: /(?:^|[^a-zA-Z])(new\s+unopened)(?:[^a-zA-Z]|$)/i, val: 'Brand New' },
      { re: /brand\s*new/i, val: 'Brand New' },
      { re: /(?:^|[^a-zA-Z])(refurbished|certified\s+refurbished)(?:[^a-zA-Z]|$)/i, val: 'Refurbished' },
      { re: /(?:^|[^a-zA-Z])(like\s+new)(?:[^a-zA-Z]|$)/i, val: 'Like New' },
      { re: /(?:^|[^a-zA-Z])(for\s+parts|sold\s+for\s+parts)(?:[^a-zA-Z]|$)/i, val: 'Poor' },
      { re: /(?:^|[^a-zA-Z])(used|pre-?owned)(?:[^a-zA-Z]|$)/i, val: 'Used' },
    ];
    for (const { re, val } of conditionPatterns) {
      if (re.test(descText)) {
        condition = val;
        break;
      }
    }
  }

  // Clean attributes
  const cleanedAttrs = { ...attributes };
  const REDUNDANT_ATTR_KEYS = ['Condition', 'Physical Condition', 'Item Condition', 'Notes'];
  for (const key of REDUNDANT_ATTR_KEYS) {
    delete cleanedAttrs[key];
  }

  if (primaryId && primaryId !== 'unknown') {
    cleanedAttrs['auction_id'] = primaryId;
  }
  if (lotNumber) {
    cleanedAttrs['lot_number'] = String(lotNumber);
  }

  cleanedAttrs['price_source'] = pricingData.price_source;
  cleanedAttrs['prices'] = {
    buy_now_price: pricingData.buy_now_price,
    current_bid: pricingData.current_bid,
    starting_bid: pricingData.starting_bid,
  };
  cleanedAttrs['shipping_options'] = shippingData.shipping_options;
  if (shippingWeightData.shipping_weight) {
    cleanedAttrs['shipping_weight'] = shippingWeightData.shipping_weight;
    cleanedAttrs['shipping_weight_lbs'] = shippingWeightData.shipping_weight_lbs;
  }
  cleanedAttrs['location_source'] = location_source;
  cleanedAttrs['price_type'] = priceType;
  if (layout.bid_count !== null) cleanedAttrs['bid_count'] = layout.bid_count;
  if (layout.bid_increment !== null) cleanedAttrs['bid_increment'] = layout.bid_increment;
  cleanedAttrs['shipping_method'] = shippingMethod;
  // PropertyRoom listing pages publish no auction start date; the intake's first_seen_at is the proxy.
  cleanedAttrs['auction_start_time_source'] = 'not_published_by_site';

  const buyersPremium = typeof buyersPremiumRaw === 'number' && isFinite(buyersPremiumRaw) ? buyersPremiumRaw : 0;
  const shippingForTotal = typeof shippingData.estimated_shipping === 'number' ? shippingData.estimated_shipping : 0;
  const totalCost = roundTo2(pricingData.current_price + shippingForTotal + buyersPremium);
  cleanedAttrs['total_cost'] = totalCost;
  cleanedAttrs['currency'] = 'USD';

  const cleanDescription = cleanDescriptionText(description || '');
  const itemDescription = stripBoilerplate(cleanDescription);
  if (itemDescription && itemDescription !== cleanDescription) {
    cleanedAttrs['description_clean'] = itemDescription;
    // Full text incl. PropertyRoom's shipping/payment/warranty boilerplate, kept for reference.
    cleanedAttrs['description_full'] = cleanDescription;
  }

  const rawData = {
    external_id: externalId,
    listing_url: url,
    title,
    category,
    condition,
    // Item-specific text only: the AI decides from this field, so site boilerplate is excluded.
    description: itemDescription || cleanDescription,
    current_price: pricingData.current_price,
    estimated_shipping: shippingData.estimated_shipping,
    shipping_weight: shippingWeightData.shipping_weight || '',
    shipping_weight_lbs: shippingWeightData.shipping_weight_lbs,
    buyers_premium: buyersPremium,
    auction_start_time: '', // not published by PropertyRoom (see attributes.auction_start_time_source)
    auction_end_time: endTimeRaw,
    shipping_method: shippingMethod,
    location,
    image_urls: imageUrls,
    attributes: cleanedAttrs,
    // Everything the lot page exposes, untouched, for the business team's full-data review.
    source_record: {
      page_vars: layout.page_vars,
      price_block: { label: layout.price_label, value: layout.price_value, bid_increment: layout.bid_increment },
      stats: layout.stats,
      shipping_options: layout.shipping_options,
      specs: attributes,
      description_full: cleanDescription,
      end_time_text: $('body').text().match(/Ends?\s+[A-Za-z]{3}\s+\d{1,2},?\s+\d{4}\s+at\s+\d{1,2}:\d{2}\s*(?:AM|PM)\s*\(?[A-Za-z]*\)?/i)?.[0] ?? null,
    },
    source_meta: {
      shipping: {
        options: shippingData.shipping_options,
        estimated_shipping: shippingData.estimated_shipping,
        weight: shippingWeightData.shipping_weight || null,
        weight_lbs: shippingWeightData.shipping_weight_lbs,
        weight_value: shippingWeightData.shipping_weight_value,
        weight_unit: shippingWeightData.shipping_weight_unit || null,
        weight_note: shippingWeightData.shipping_weight_note || null,
      },
    },
  };

  if (debug) {
    log.debug(`Extracted raw fields from ${url}`, {
      external_id: externalId,
      title: title?.slice(0, 80),
      price_source: pricingData.price_source,
      current_price: pricingData.current_price,
      estimated_shipping: shippingData.estimated_shipping,
      shipping_weight: shippingWeightData.shipping_weight || '(none)',
      shipping_weight_lbs: shippingWeightData.shipping_weight_lbs,
      buyers_premium: buyersPremium,
      total_cost: totalCost,
      location_source,
      location: location || '(none)',
      shipping_options_count: shippingData.shipping_options.length,
      imagesCount: imageUrls.length,
      attributesCount: Object.keys(cleanedAttrs).length,
      condition: condition?.slice(0, 40),
      category: category?.slice(0, 40),
      endTime: endTimeRaw?.slice(0, 50),
    });
  }

  return rawData;
}

// ─── Index page helpers ───────────────────────────────────────────────────────

/**
 * Collect all item detail page URLs from an index/search/category page.
 * @param {import('cheerio').CheerioAPI} $
 * @returns {{ url: string, indexPrice: number|null }[]}
 */
function collectDetailUrls($) {
  const seen = new Set();
  const results = [];

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    // Match detail URL patterns
    if (/\/l\/[^/]+\/\d+/.test(href) || /\/s\/\d+/.test(href)) {
      // Build absolute URL and strip query params
      let fullUrl = href;
      if (href.startsWith('/')) {
        fullUrl = DOMAIN + href;
      }
      const clean = fullUrl.split('?')[0].split('#')[0];
      if (!seen.has(clean)) {
        seen.add(clean);

        let indexPrice = null;
        // Traverse up the DOM to find the listing's price block
        let parent = $(el).parent();
        let depth = 0;
        while (parent.length && depth < 5) {
          const text = parent.text() || '';
          const priceMatch = text.match(/\$\s*([\d,]+\.\d{2})/);
          if (priceMatch) {
            const parsed = parseFloat(priceMatch[1].replace(/,/g, ''));
            if (!isNaN(parsed) && parsed >= 0) {
              indexPrice = parsed;
              break;
            }
          }
          parent = parent.parent();
          depth++;
        }

        results.push({ url: clean, indexPrice });
      }
    }
  });

  return results;
}

/**
 * Find the "next page" URL on a listing/search/category page.
 * @param {import('cheerio').CheerioAPI} $
 * @param {string} currentUrl
 * @returns {string|null}
 */
function findNextPageUrl($, currentUrl) {
  // Strategy 1: PropertyRoom pagination — right arrow or next numbered page
  const paginationDiv = $('.pagination, [class*="pagination"]').first();
  if (paginationDiv.length) {
    // Find the right-arrow link
    paginationDiv.find('a[href]').each((_, a) => {
      const $a = $(a);
      const img = $a.find('img');
      if (img.length && /right|next/i.test((img.attr('src') || '') + (img.attr('alt') || ''))) {
        const href = $a.attr('href');
        if (href && !href.endsWith('#') && !href.endsWith('/#')) {
          const fullUrl = href.startsWith('/') ? DOMAIN + href : href;
          // We can't return from .each, so we stash it
          paginationDiv.data('nextUrl', fullUrl.split('#')[0]);
        }
      }
    });
    if (paginationDiv.data('nextUrl')) return paginationDiv.data('nextUrl');

    // Find the next sequential page number
    let foundCurrent = false;
    let nextPageUrl = null;
    paginationDiv.find('a').each((_, a) => {
      if (nextPageUrl) return;
      const $a = $(a);
      const text = $a.text().trim();
      if (!text || !/^\d+$/.test(text)) return;
      const href = $a.attr('href');
      if (!href || href === '#') {
        foundCurrent = true;
        return;
      }
      if (foundCurrent) {
        const full = href.startsWith('/') ? DOMAIN + href : href;
        nextPageUrl = full.split('#')[0];
      }
    });
    if (nextPageUrl) return nextPageUrl;
  }

  // Strategy 2: Canonical <link rel="next">
  const linkNext = $('link[rel="next"]').attr('href');
  if (linkNext) return linkNext.startsWith('/') ? DOMAIN + linkNext : linkNext;

  // Strategy 3: Standard a[rel="next"] or aria-label
  const ariaNext = $('a[rel="next"], a[aria-label="Next"], a[aria-label="Next page"], .pager a.next').first();
  if (ariaNext.length && ariaNext.attr('href')) {
    const h = ariaNext.attr('href');
    return h.startsWith('/') ? DOMAIN + h : h;
  }

  // Strategy 4: Text-based "Next" / ">" / "»"
  if (paginationDiv.length) {
    let found = null;
    paginationDiv.find('a').each((_, a) => {
      if (found) return;
      const $a = $(a);
      const text = $a.text().trim();
      if ((text === '>' || text === '»' || /^next$/i.test(text)) && $a.attr('href')) {
        const h = $a.attr('href');
        found = (h.startsWith('/') ? DOMAIN + h : h).split('#')[0];
      }
    });
    if (found) return found;
  }

  return null;
}

// ─── Crawler factory ──────────────────────────────────────────────────────────

/**
 * Build and return a configured CheerioCrawler instance.
 *
 * @param {{
 *   startUrls: string[],
 *   keywords: string[],
 *   maxPages: number,
 *   maxConcurrency: number,
 *   requestTimeoutSecs: number,
 *   maxRequestRetries: number,
 *   proxyEnabled: boolean,
 *   proxyGroups: string[],
 *   debug: boolean,
 *   dataset: import('apify').Dataset,
 *   dedupeManager: import('../utils/dedupe.js').DedupeManager,
 *   webhookManager: import('../utils/webhook.js').WebhookManager | null,
 *   seenExternalIds?: Set<string>,
 *   log: ReturnType<import('../utils/logging.js').createLogger>,
 * }} opts
 * @returns {CheerioCrawler}
 */
export function createPropertyRoomCrawler(opts) {
  const {
    startUrls,
    keywords,
    maxPages,
    maxConcurrency,
    requestTimeoutSecs,
    maxRequestRetries,
    proxyEnabled,
    proxyGroups,
    debug,
    dataset,
    dedupeManager,
    webhookManager,
    seenExternalIds,
    log,
    maxItemsPerRun = 0,
  } = opts;

  let detailSavedCount = 0;

  // ── Build initial request list ───────────────────────────────────────────
  const initialRequests = [
    ...startUrls.map((url) => ({
      url: typeof url === 'string' ? url : url.url,
      userData: { type: 'index', depth: 1 },
    })),
    ...keywords.map((kw) => ({
      url: keywordUrl(kw),
      userData: { type: 'index', depth: 1, keyword: kw },
    })),
  ];

  // ── Crawler ──────────────────────────────────────────────────────────────
  const crawler = new CheerioCrawler({
    // CheerioCrawler can handle much higher concurrency — no browser tabs
    maxConcurrency: Math.max(maxConcurrency, 10),
    requestHandlerTimeoutSecs: Math.min(requestTimeoutSecs, 60),
    maxRequestRetries,

    // Add standard headers to look like a normal browser request
    preNavigationHooks: [
      ({ request }) => {
        request.headers = {
          ...request.headers,
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        };
      },
    ],

    async requestHandler({ $, request }) {
      const { url } = request;
      const userData = request.userData ?? {};
      const pageType = userData.type ?? (isDetailUrl(url) ? 'detail' : 'index');

      log.debug(`Handling ${pageType}: ${url}`);

      // ── INDEX PAGE ────────────────────────────────────────────────────────
      if (pageType === 'index') {
        const depth = userData.depth ?? 1;

        // Extract category from this index page URL (e.g. /c/electronics → 'Electronics')
        const indexCategory = userData.indexCategory || categoryFromUrl(url);

        const detailItems = collectDetailUrls($);
        log.info(`Index page — found ${detailItems.length} items`, { url, depth, indexCategory: indexCategory || '(none)' });
        incrementStat('pagesVisited');

        if (detailItems.length === 0) {
          log.warning(`No listings detected on index page`, { url });
        }

        for (const item of detailItems) {
          const detailUrl = item.url;
          const indexPrice = item.indexPrice;
          const extId = externalIdFromUrl(detailUrl);

          // Track every listing the actor saw on this run (regardless of dedupe)
          if (seenExternalIds && extId) seenExternalIds.add(extId);

          // Queue-level dedupe: skip if already queued this run
          if (dedupeManager.isQueued(extId)) {
            log.debug(`Skipping already-queued item: ${extId}`);
            incrementStat('itemsSkipped');
            continue;
          }
          dedupeManager.markQueued(extId);

          // Deep Skip: Bail if we have seen it and the price hasn't changed.
          // Older deployed actors may not have this optional dedupe method yet.
          const safeToSkip = typeof dedupeManager.shouldEarlySkip === 'function'
            ? await dedupeManager.shouldEarlySkip(extId, indexPrice)
            : false;
          if (safeToSkip) {
            log.debug(`Early dropping detail page load (unchanged price): ${extId}`);
            continue;
          }

          await crawler.addRequests([{
            url: detailUrl,
            uniqueKey: extId,
            userData: { type: 'detail', indexCategory },
          }]);
        }
        incrementStat('itemsFound', detailItems.length);

        // Pagination
        if (maxPages === 0 || depth < maxPages) {
          const nextUrl = findNextPageUrl($, url);
          if (nextUrl && nextUrl !== url) {
            log.debug(`Enqueueing next page (depth ${depth + 1}): ${nextUrl}`);
            await crawler.addRequests([{
              url: nextUrl,
              uniqueKey: `index-${nextUrl}`,
              userData: { type: 'index', depth: depth + 1, keyword: userData.keyword, indexCategory },
            }]);
          }
        }
        return;
      }

      // ── DETAIL PAGE ───────────────────────────────────────────────────────
      if (pageType === 'detail') {
        // Extract raw data
        let rawData;
        try {
          rawData = extractDetailPage($, url, debug, log, userData.indexCategory);
        } catch (err) {
          log.error(`Extraction error on ${url}: ${err.message}`);
          incrementStat('errors');
          return;
        }

        // Normalize
        let record;
        try {
          record = normalizeRecord(rawData, 'propertyroom');
        } catch (err) {
          log.error(`Normalisation failed for ${url}: ${err.message}`);
          incrementStat('errors');
          return;
        }

        // Validate schema
        const validation = validateRecord(record);
        if (!validation.valid) {
          log.error(`Schema validation failed for ${url}`, {
            errors: validation.errors,
            external_id: record.external_id,
          });
          incrementStat('errors');
          return;
        }

        // ── Fingerprint-aware incremental dedupe ────────────────────────
        const shouldIngest = await dedupeManager.shouldProcess(
          record.external_id,
          record.content_hash,
        );
        if (!shouldIngest) {
          log.info(`Skipping unchanged/fresh listing`, {
            id: record.external_id,
            title: record.title?.slice(0, 60),
          });
          incrementStat('itemsSkipped');
          return;
        }
        await dedupeManager.markSeenWithFingerprint(
          record.external_id,
          record.content_hash,
          { price: record.current_price }
        );

        // ── Safety cap: maxItemsPerRun ──────────────────────────────────
        if (maxItemsPerRun > 0 && detailSavedCount >= maxItemsPerRun) {
          log.info(`Reached maxItemsPerRun cap (${maxItemsPerRun}), stopping crawler`);
          crawler.autoscaledPool?.abort();
          return;
        }
        detailSavedCount += 1;

        // Add Supabase-compatible alias fields
        addSupabaseAliases(record);

        // Persist to Dataset
        await dataset.pushData(record);
        incrementStat('itemsSaved');

        // Webhook (optional)
        if (webhookManager) {
          await webhookManager.add(record);
        }

        // Per-item summary log
        log.info(`Saved item`, {
          id: record.external_id,
          title: record.title?.slice(0, 60),
          price: record.current_price,
          images: record.image_urls.length,
          attrs: Object.keys(record.attributes).length,
          condition: record.condition?.slice(0, 30) || '(none)',
        });

        incrementStat('pagesVisited');
      }
    },

    failedRequestHandler({ request, error }) {
      log.error(`Request failed after retries: ${request.url}`, {
        error: error?.message?.slice(0, 200),
      });
      incrementStat('errors');
    },
  });

  // Attach proxy config asynchronously
  const originalRun = crawler.run.bind(crawler);
  crawler.run = async function () {
    if (proxyEnabled) {
      try {
        const proxyConfig = await Actor.createProxyConfiguration({
          groups: proxyGroups?.length ? proxyGroups : ['DATACENTER'],
          countryCode: 'US',
        });
        crawler.proxyConfiguration = proxyConfig;
      } catch (err) {
        log.warning(`Proxy setup failed — running without proxy: ${err.message}`);
      }
    }
    return originalRun(initialRequests);
  };

  return crawler;
}