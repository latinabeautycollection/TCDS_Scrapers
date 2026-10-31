const PUBLIC_BASE = 'https://www.publicsurplus.com';
const SEARCH_PATH = '/sms/browse/search';

export function publicSearchUrl() {
  const u = new URL(SEARCH_PATH, PUBLIC_BASE);
  u.searchParams.set('posting', 'y');
  return u.toString();
}

export function buildKeywordUrl(keyword) {
  const u = new URL(SEARCH_PATH, PUBLIC_BASE);
  u.searchParams.set('Submit4', 'Search');
  u.searchParams.set('posting', 'y');
  u.searchParams.set('keyWord', String(keyword || '').trim());
  return u.toString();
}

export function parseAuctionIdentity(rawUrl) {
  const u = new URL(rawUrl, PUBLIC_BASE);
  const auctionId = u.searchParams.get('auc');
  if (!auctionId || !/^\d+$/.test(auctionId)) return null;
  return {
    auctionId,
    externalId: `publicsurplus-${auctionId}`,
    canonicalUrl: `${PUBLIC_BASE}/sms/auction/view?auc=${auctionId}`,
  };
}

export function canonicalizePublicSurplusUrl(raw) {
  const u = new URL(raw, PUBLIC_BASE);
  const identity = parseAuctionIdentity(u.toString());
  if (identity) return identity.canonicalUrl;
  u.protocol = 'https:';
  u.hostname = 'www.publicsurplus.com';
  u.hash = '';
  for (const key of [...u.searchParams.keys()]) {
    if (/^(utm_|gclid|fbclid|session|sid|campaign)/i.test(key)) u.searchParams.delete(key);
  }
  return u.toString();
}

export function isDetailUrl(url) {
  return !!parseAuctionIdentity(url);
}

export function isPublicSurplusUrl(url) {
  try {
    const u = new URL(url, PUBLIC_BASE);
    return /(^|\.)publicsurplus\.com$/i.test(u.hostname);
  } catch {
    return false;
  }
}