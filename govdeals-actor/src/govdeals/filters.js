function norm(v) { return String(v ?? '').trim().toLowerCase(); }

export function recordMatchesFilters(raw, filters = {}, now = new Date()) {
  const price = raw.current_price;
  if (filters.minPrice != null && price != null && price < filters.minPrice) return false;
  if (filters.maxPrice != null && price != null && price > filters.maxPrice) return false;

  if (Array.isArray(filters.states) && filters.states.length) {
    const loc = norm(raw.location);
    if (!filters.states.some((s) => new RegExp(`(?:,|\\b)\\s*${String(s).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\b`, 'i').test(raw.location || ''))) return false;
    if (!loc) return false;
  }
  if (Array.isArray(filters.postalCodes) && filters.postalCodes.length) {
    const loc = norm(raw.location);
    if (!filters.postalCodes.some((z) => loc.includes(norm(z)))) return false;
  }
  if (Array.isArray(filters.sellerNames) && filters.sellerNames.length) {
    const seller = norm(raw.seller_name);
    if (!filters.sellerNames.some((s) => seller.includes(norm(s)))) return false;
  }
  if (Array.isArray(filters.categories) && filters.categories.length) {
    const hay = `${norm(raw.category)} ${norm(raw.subcategory)} ${norm(raw.title)}`;
    if (!filters.categories.some((c) => hay.includes(norm(c)))) return false;
  }
  if (Array.isArray(filters.sellerIds) && filters.sellerIds.length && !filters.sellerIds.map(String).includes(String(raw.seller_account_id ?? ''))) return false;

  const status = raw.auction_status;
  if (filters.includeEnded === false && status === 'ENDED') return false;
  if (filters.includeUpcoming === false && status === 'UPCOMING') return false;

  if (raw.auction_end_time) {
    const hours = (new Date(raw.auction_end_time).getTime() - now.getTime()) / 3_600_000;
    if (filters.auctionEndingWithinHours != null && hours > filters.auctionEndingWithinHours) return false;
    if (filters.auctionEndingAfterHours != null && hours < filters.auctionEndingAfterHours) return false;
  }
  return true;
}