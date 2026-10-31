const PUBLIC_BASE = 'https://www.govdeals.com'; // prod-seo redirects to www and serves an empty Angular shell
const SEARCH_PATH = '/en/search';

export function buildKeywordUrl(keyword) {
  const u = new URL(SEARCH_PATH, PUBLIC_BASE);
  u.searchParams.set('kWord', String(keyword || '').trim());
  return u.toString();
}

export function canonicalizeGovDealsUrl(raw) {
  const u = new URL(raw, PUBLIC_BASE);
  u.hash = '';
  for (const key of [...u.searchParams.keys()]) {
    if (/^(utm_|gclid|fbclid|session|sid|campaign)/i.test(key)) u.searchParams.delete(key);
  }
  return u.toString();
}

export function parseAssetIdentity(rawUrl) {
  const u = new URL(rawUrl, PUBLIC_BASE);
  const m = u.pathname.match(/\/asset\/(\d+)\/(\d+)/i);
  if (!m) return null;
  const assetId = m[1];
  const sellerAccountId = m[2];
  return {
    assetId,
    sellerAccountId,
    externalId: `govdeals-${sellerAccountId}-${assetId}`,
    canonicalUrl: `${PUBLIC_BASE}/en/asset/${assetId}/${sellerAccountId}`,
    lotNumberDerived: `${sellerAccountId}-${assetId}`,
  };
}

/** Accept detail URLs, the exported external_id form, and assetId/accountId strings. */
export function parseRecheckIdentity(value) {
  if (value && typeof value === 'object') {
    const assetId = String(value.assetId ?? value.asset_id ?? '').trim();
    const accountId = String(value.accountId ?? value.account_id ?? value.sellerAccountId ?? '').trim();
    return assetIdentityFromIds(assetId, accountId);
  }
  const text = String(value ?? '').trim();
  if (!text) return null;
  try {
    const fromUrl = parseAssetIdentity(text);
    if (fromUrl) return fromUrl;
  } catch { /* parse supported ID forms below */ }
  const external = text.match(/^govdeals[-:]([0-9]+)[-:]([0-9]+)$/i);
  if (external) return assetIdentityFromIds(external[2], external[1]); // external_id is accountId first
  const pair = text.match(/^([0-9]+)[\/:]([0-9]+)$/);
  if (pair) return assetIdentityFromIds(pair[1], pair[2]); // URL-style assetId/accountId
  return null;
}

function assetIdentityFromIds(assetId, sellerAccountId) {
  if (!/^\d+$/.test(assetId) || !/^\d+$/.test(sellerAccountId)) return null;
  return {
    assetId,
    sellerAccountId,
    externalId: `govdeals-${sellerAccountId}-${assetId}`,
    canonicalUrl: `${PUBLIC_BASE}/en/asset/${assetId}/${sellerAccountId}`,
    lotNumberDerived: `${sellerAccountId}-${assetId}`,
  };
}

export function isDetailUrl(url) {
  return !!parseAssetIdentity(url);
}

export function isGovDealsUrl(url) {
  try {
    const u = new URL(url, PUBLIC_BASE);
    return /(^|\.)govdeals\.com$/i.test(u.hostname);
  } catch {
    return false;
  }
}

export function publicSearchUrl() {
  return `${PUBLIC_BASE}${SEARCH_PATH}`;
}