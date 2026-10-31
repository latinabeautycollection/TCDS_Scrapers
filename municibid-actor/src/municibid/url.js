const BASE = 'https://municibid.com';

export function municibidBrowseUrl() { return `${BASE}/browse`; }
export function publicSearchUrl() { return municibidBrowseUrl(); }

// Municibid keyword search parameters are not relied upon for certification.
// TARGETED keyword runs start at /browse and filter discovered titles locally.
export function buildKeywordUrl() { return `${BASE}/browse`; }

export function parseAuctionIdentity(rawUrl) {
  try {
    const u = new URL(rawUrl, BASE);
    const m = u.pathname.match(/^\/listing\/(\d+)(?:\/[^/?#]+)?\/?$/i);
    if (!m) return null;
    const listingId = m[1];
    return {
      auctionId: listingId,
      listingId,
      externalId: `municibid-${listingId}`,
      canonicalUrl: `${BASE}/listing/${listingId}`,
    };
  } catch { return null; }
}

export function canonicalizeMunicibidUrl(raw) {
  const u = new URL(raw, BASE);
  const identity = parseAuctionIdentity(u.toString());
  if (identity) return identity.canonicalUrl;
  u.protocol = 'https:';
  u.hostname = 'municibid.com';
  u.hash = '';
  for (const key of [...u.searchParams.keys()]) {
    if (/^(utm_|gclid|fbclid|session|sid|campaign)/i.test(key)) u.searchParams.delete(key);
  }
  // Deterministic query order keeps request/recovery keys stable.
  const entries = [...u.searchParams.entries()].sort(([a,av],[b,bv]) => a.localeCompare(b) || av.localeCompare(bv));
  u.search = '';
  for (const [k,v] of entries) u.searchParams.append(k,v);
  return u.toString();
}

export function isDetailUrl(url) { return !!parseAuctionIdentity(url); }

export function isMunicibidUrl(url) {
  try { return /(^|\.)municibid\.com$/i.test(new URL(url, BASE).hostname); }
  catch { return false; }
}