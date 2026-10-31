import { DETAIL_URL_PATTERNS, PROPERTYROOM_CONSTANTS } from './selectors.js';

export function keywordUrl(keyword) {
  return `${PROPERTYROOM_CONSTANTS.DOMAIN}/l?q=${encodeURIComponent(keyword)}`;
}

export function isDetailUrl(url) {
  return DETAIL_URL_PATTERNS.some((re) => re.test(url));
}

export function listingIdFromUrl(url) {
  const match = url.match(/\/(\d{5,})(?:[?#]|$)/);
  return match ? match[1] : null;
}

export function externalIdFromUrl(url) {
  const listingId = listingIdFromUrl(url);
  if (listingId) return `propertyroom-${listingId}`;

  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    return `propertyroom-${parts[parts.length - 1] || 'unknown'}`;
  } catch {
    return 'propertyroom-unknown';
  }
}

export function normalizeDetailUrl(url) {
  return String(url).split('?')[0].split('#')[0];
}