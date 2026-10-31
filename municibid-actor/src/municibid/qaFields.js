import { load } from 'cheerio';
import { createHash } from 'node:crypto';
import { cleanText, money, parseMunicibidDate } from './text.js';
import { normalizeBlockText } from './fieldRules.js';
import { findPayloadListing, toIsoUtc } from './payload.js';

// Prefer a bounded label/value row. Never consume the rest of the page as a value.
export function publishedValue($, labels) {
  const accepted = new Set(labels.map(x => x.toLowerCase()));
  let result = null;
  $('dt,th,label,strong,b,span,div,td').each((_, el) => {
    if (result) return;
    const node = $(el);
    if (node.children().length > 2) return;
    const text = cleanText(node.text());
    if (text.length > 250) return;
    const label = text.replace(/:$/, '').toLowerCase();
    if (accepted.has(label)) {
      const next = cleanText(node.next().text());
      if (next && next.length <= 180) result = next;
    } else {
      for (const key of labels) {
        if (text.toLowerCase().startsWith(key.toLowerCase() + ':')) {
          const value = text.slice(key.length + 1).trim();
          if (value && value.length <= 180) result = value;
        }
      }
    }
  });
  return result;
}

export function detailEvidence($, html, id) {
  const payload = findPayloadListing(html, id);
  const start = publishedValue($, ['Start Date', 'Auction Start', 'Auction Start Date']);
  const rawCondition = publishedValue($, ['Condition', 'Item Condition']);
  const shipping = publishedValue($, ['Shipping Cost', 'Shipping Fee', 'Shipping Price', 'Delivery Cost', 'Delivery Fee']);
  const startSource = start ? 'listing_page' : payload?.startsAtUtc ? 'embedded_page_data' : 'not_published_by_site';
  return {
    payload,
    start: start ? parseMunicibidDate(start) : toIsoUtc(payload?.startsAtUtc),
    rawStart: start || payload?.startsAtUtc || null,
    startSource,
    condition: rawCondition || null,
    shippingCost: shipping && /^\$\s*[\d,.]+(?:\s*USD)?$/i.test(shipping) ? money(shipping) : null,
    shippingText: shipping,
  };
}

// Keep the source fields needed to audit extraction. Exact HTML remains in Apify KV storage;
// this structured snapshot makes labels, descriptions, logistics and price/date page state
// available directly on each dataset record without copying the full framework document.
export function collectSourceRecord(html) {
  const $ = load(html);
  const labelValues = [];
  $('dt, tr, label').each((_, el) => {
    const row = $(el);
    if (el.tagName === 'dt') {
      const label = cleanText(row.text());
      const value = cleanText(row.next('dd').text());
      if (label || value) labelValues.push({ label, value: value || null });
    } else if (el.tagName === 'tr') {
      const cells = row.children('th,td').toArray().map(cell => cleanText($(cell).text())).filter(Boolean);
      if (cells.length >= 2) labelValues.push({ label: cells[0], value: cells.slice(1).join(' | ') });
    } else {
      const label = cleanText(row.text());
      const value = cleanText(row.next().text());
      if (label && value) labelValues.push({ label, value });
    }
  });
  const shippingOptions = [];
  $('body *').each((_, el) => {
    if ($(el).children().length) return;
    const text = cleanText($(el).text());
    if (text && /ship|shipping|delivery|pickup|pick up|freight/i.test(text)) shippingOptions.push(text);
  });
  const pageVariables = [];
  $('script').each((_, el) => {
    const text = $(el).html() || '';
    if (/(?:price|bid|shipping|pickup|start|end|date|time|auction)/i.test(text)) {
      // Full scripts remain in the archived exact HTML. Keep the dataset
      // snapshot bounded instead of duplicating large framework payloads.
      pageVariables.push({ type: $(el).attr('type') || 'text/javascript', id: $(el).attr('id') || null,
        content: text.slice(0, 1024), content_truncated: text.length > 1024,
        original_length: text.length, sha256: createHash('sha256').update(text).digest('hex'),
        full_content_source: 'archived_original_html' });
    }
  });
  const descriptionNode = $('h1,h2,h3,h4,h5,strong,b').filter((_, el) => /^Item Description$/i.test(cleanText($(el).text()))).first();
  const descriptionBlocks = [];
  if (descriptionNode.length) {
    let node = descriptionNode.next(); let guard = 0;
    while (node.length && guard++ < 30 && !/^H[1-5]$/i.test(node[0]?.tagName || '')) {
      if (/^(SCRIPT|STYLE|NOSCRIPT)$/i.test(node[0]?.tagName || '')) { node = node.next(); continue; }
      const clone = node.clone(); clone.find('script,style,noscript').remove();
      clone.find('br').replaceWith('\n');
      const block = clone.text().replace(/\r\n?/g, '\n').trim();
      if (block) descriptionBlocks.push(block);
      node = node.next();
    }
  }
  return {
    label_values: labelValues,
    full_description: descriptionBlocks.join('\n'),
    shipping_options: [...new Set(shippingOptions)],
    page_variables: pageVariables,
    original_html_preserved_in_archive: true,
  };
}

export function descriptionFromPayload($, payload) {
  for (const key of ['description', 'itemDescription', 'longDescription', 'descriptionHtml']) {
    if (typeof payload?.[key] !== 'string' || !payload[key].trim()) continue;
    const node = $('<div>').html(payload[key]);
    node.find('script,style,noscript').remove();
    node.find('br').replaceWith('\n');
    node.find('p,div,li,tr,h1,h2,h3').append('\n');
    return normalizeBlockText(node.text());
  }
  return null;
}
export function ownGalleryImages(html, title, firstImage) {
  if (!firstImage) return [];
  const chunks = [];
  for (const m of String(html).matchAll(/self\.__next_f\.push\(\[\d+,\s*("(?:[^"\\]|\\.)*")\s*\]\)/g)) {
    try { chunks.push(JSON.parse(m[1])); } catch {}
  }
  for (const m of chunks.join('').matchAll(/\{"images":\[(?:"(?:[^"\\]|\\.)*"\s*,?\s*)*\],"alt":"(?:[^"\\]|\\.)*"\}/g)) {
    try {
      const props=JSON.parse(m[0]);
      if (props.alt === title && props.images[0] === firstImage && props.images.every(u=>/^https:\/\/storagemunicibidpro\.blob\.core\.windows\.net\//i.test(u))) return props.images;
    } catch {}
  }
  return [];
}