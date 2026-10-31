const BASE = 'https://www.liquidation.com';

export function liquidationSearchUrl() { return `${BASE}/auction/search?flag=new`; }
export function publicSearchUrl() { return liquidationSearchUrl(); }
export function buildKeywordUrl(keyword) {
  const u = new URL('/auction/search', BASE);
  u.searchParams.set('flag','new');
  u.searchParams.set('searchparam_words', String(keyword || '').trim());
  return u.toString();
}

export function parseAuctionIdentity(rawUrl) {
  try {
    const u = new URL(rawUrl, BASE);
    if (!/^\/auction\/view$/i.test(u.pathname)) return null;
    const id = u.searchParams.get('id');
    if (!/^\d+$/.test(id || '')) return null;
    return {
      auctionId: id,
      listingId: id,
      externalId: `liquidation-${id}`,
      canonicalUrl: `${BASE}/auction/view?id=${id}`,
    };
  } catch { return null; }
}

export function canonicalizeLiquidationUrl(raw) {
  const u = new URL(raw, BASE);
  const identity = parseAuctionIdentity(u.toString());
  if (identity) return identity.canonicalUrl;
  u.protocol = 'https:';
  u.hostname = 'www.liquidation.com';
  u.hash = '';
  for (const key of [...u.searchParams.keys()]) {
    if (/^(utm_|gclid|fbclid|session|sid|campaign)/i.test(key)) u.searchParams.delete(key);
  }
  const entries = [...u.searchParams.entries()].sort(([a,av],[b,bv]) => a.localeCompare(b) || av.localeCompare(bv));
  u.search = '';
  for (const [k,v] of entries) u.searchParams.append(k,v);
  return u.toString();
}

export function isDetailUrl(url) { return !!parseAuctionIdentity(url); }
export function isLiquidationUrl(url) {
  try { return /(^|\.)liquidation\.com$/i.test(new URL(url, BASE).hostname); }
  catch { return false; }
}