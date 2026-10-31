/**
 * Municibid is a Next.js site. Its server-rendered HTML embeds the listing data as JSON in <script> tags
 * (self.__next_f.push). Verified on the real browse page (24 listings): each listing is a flat object
 * {id, title, subtitle, currentPrice, bidCount, endsAtUtc, primaryImageUrl, location, distanceMiles,
 *  sellerUserName, agencyName, reservePrice, sold, hasVideo}. endsAtUtc is UTC without a "Z" ("2026-10-12T16:00:00").
 * The visible "ENDS IN" countdown is filled in by the browser, so the HTML text has no end time.
 * No third-party dependencies: unit-testable offline.
 */

export function unescapePayload(html) {
  const scripts = [...String(html ?? '').matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  return scripts.join('').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

/** Map of listingId (string) -> listing object, parsed from the embedded payload. */
export function parsePayloadListings(html) {
  const map = new Map();
  try {
    const payload = unescapePayload(html);
    for (const m of payload.matchAll(/\{"id":\d+,"title":[^{}]*?"endsAtUtc":[^{}]*\}/g)) {
      try {
        const o = JSON.parse(m[0]);
        if (o && o.id != null && !map.has(String(o.id))) map.set(String(o.id), o);
      } catch { /* skip malformed object */ }
    }
    // Decode Next flight strings before parsing JSON; tolerate nested fields and key order.
    const texts = [String(html), payload];
    for (const m of String(html).matchAll(/self\.__next_f\.push\(\[\d+,\s*("(?:[^"\\]|\\.)*")\s*\]\)/g)) {
      try { texts.push(JSON.parse(m[1])); } catch {}
    }
    for (const text of texts) {
      // Municibid detail pages also render the live bidding widget as
      // {listingId, initial:{currentPrice,bidCount,endsAtUtc,...}}. This is
      // authoritative for the current bid and end time, including ended lots.
      for (const state of text.matchAll(/"listingId"\s*:\s*(\d+)\s*,\s*"initial"\s*:\s*(\{[^{}]*\})/g)) {
        try {
          const initial = JSON.parse(state[2]);
          map.set(String(state[1]), { ...(map.get(String(state[1])) || {}), ...initial, id: Number(state[1]) });
        } catch { /* malformed or nested state is handled by other payload paths */ }
      }
      const stack = []; let quoted = false, escaped = false;
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue; }
        if (c === '"') { quoted = true; continue; }
        if (c === '{') stack.push(i);
        if (c === '}' && stack.length) {
          const start = stack.pop();
          try {
            const o = JSON.parse(text.slice(start, i + 1));
            if (o && o.id != null && typeof o.title === 'string') map.set(String(o.id), o);
          } catch {}
        }
      }
    }
  } catch { /* payload unavailable */ }
  return map;
}

/** "2026-10-12T16:00:00" (UTC, no zone) -> "2026-10-12T16:00:00.000Z" */
export function toIsoUtc(value) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  const d = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(s) ? s : `${s}Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** "PITTSBURGH, PA" -> "Pittsburgh, PA" (state stays upper-case). */
export function titleCaseLocation(loc) {
  const s = String(loc ?? '').trim();
  const m = s.match(/^(.+?),\s*([A-Za-z]{2})$/);
  if (!m) return s || null;
  const city = m[1].toLowerCase().replace(/(^|[\s\-'.])([a-z])/g, (_, a, b) => a + b.toUpperCase());
  return `${city}, ${m[2].toUpperCase()}`;
}

/**
 * Detail page: find this listing's endsAtUtc/description in the payload.
 * Prefer the object whose id matches; otherwise accept the only endsAtUtc on the page.
 */
export function findPayloadListing(html, listingId) {
  const map = parsePayloadListings(html);
  if (map.has(String(listingId))) return map.get(String(listingId));
  return null;
}

/** Longest string value for any of the given keys in the payload (e.g. a description). Null if none. */
export function payloadString(html, keys = ['description', 'itemDescription', 'longDescription', 'descriptionHtml']) {
  try {
    const payload = unescapePayload(html);
    let best = null;
    for (const key of keys) {
      const re = new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`, 'g');
      for (const m of payload.matchAll(re)) {
        let v = m[1];
        try { v = JSON.parse(`"${m[1]}"`); } catch { /* keep raw */ }
        if (typeof v === 'string' && v.length > (best?.length ?? 0)) best = v;
      }
    }
    return best;
  } catch { return null; }
}

/** Description cleanup: drop the map/"Related Auctions" boilerplate that follows or replaces the real text. */
export function cleanMunicibidDescription(text) {
  let t = String(text ?? '');
  t = t.split(/Related Auctions You Might Be Interested In/i)[0];
  t = t.replace(/Item Location\s*Approximate location based on the seller[’']s zip code\.?\s*Explore other active listings on the map\.?\s*Listing status\s*This listing\s*Other active listings/gi, '');
  t = t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  // Generic page-metadata sentence ("Government surplus auction by <agency> on Municibid."), not a lot description.
  if (/^Government surplus auction by .{2,120} on Municibid\.?$/i.test(t)) return null;
  return t || null;
}

/** Only the item's own gallery: _largesize photos. Related-listing thumbnails (_thumbcrop) and PDFs are excluded. */
export function splitMedia(urls) {
  const photos = []; const documents = []; const seen = new Set();
  for (const u of urls || []) {
    if (!u || seen.has(u)) continue; seen.add(u);
    if (/\.pdf(?:\?|$)/i.test(u)) { documents.push(u); continue; }
    if (!/\.(?:jpe?g|png|webp)(?:\?|$)/i.test(u)) continue;
    if (/_thumbcrop|_thumb\b|_thumbnail/i.test(u)) continue;
    photos.push(u);
  }
  return { photos, documents };
}

/** HTML fragment -> clean text with line breaks (for descriptions found in the payload). */
export function htmlToText(html) {
  return String(html ?? '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#0?39;|&apos;/gi, "'");
}