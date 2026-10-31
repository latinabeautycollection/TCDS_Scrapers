import { load } from 'cheerio';
import { canonicalizePublicSurplusUrl, isPublicSurplusUrl } from './url.js';

export const PUBLICSURPLUS_HOME = 'https://www.publicsurplus.com/sms/browse/home';
export const PUBLICSURPLUS_ACTIVE = 'https://www.publicsurplus.com/sms/browse/search?posting=y';
export const PUBLICSURPLUS_NEW = 'https://www.publicsurplus.com/sms/browse/search?endHours=-1&highlight=Y&posting=y&startHours=24';
export const PUBLICSURPLUS_CLOSING = 'https://www.publicsurplus.com/sms/browse/search?endHours=24&highlight=Y&posting=y&startHours=-1';

function absolute(raw, base) { try { return new URL(raw, base).toString(); } catch { return null; } }
function text(v) { return String(v || '').replace(/\s+/g, ' ').trim(); }

function companionSearch(url) {
  try {
    const u = new URL(url);
    if (!/\/browse\/home$/i.test(u.pathname)) return null;
    u.pathname = u.pathname.replace(/\/browse\/home$/i, '/browse/search');
    u.search = 'posting=y';
    return canonicalizePublicSurplusUrl(u.toString());
  } catch { return null; }
}

export function exhaustiveSeedRequests() {
  return [
    { url: PUBLICSURPLUS_ACTIVE, partition: 'global_active' },
    { url: PUBLICSURPLUS_HOME, partition: 'home_regions' },
    { url: PUBLICSURPLUS_NEW, partition: 'new_24h' },
    { url: PUBLICSURPLUS_CLOSING, partition: 'closing_24h' },
  ];
}

function classifyBrowseUrl(href, label, { includeAgencyPartitions }) {
  let u; try { u = new URL(href); } catch { return null; }

  if (/\/sms\/all,[a-z]{2,3}\/browse\/home$/i.test(u.pathname)) {
    const regionKey = u.pathname.split('/')[2] || 'unknown';
    return [
      { url: href, partition: `region:${regionKey}`, type: 'index' },
      ...(companionSearch(href) ? [{ url: companionSearch(href), partition: `region_search:${regionKey}`, type: 'index' }] : []),
    ];
  }

  if (includeAgencyPartitions && /\/sms\/[^/]+,[a-z]{2,3}\/browse\/home$/i.test(u.pathname) && !/\/sms\/all,/i.test(u.pathname)) {
    const agencyKey = u.pathname.split('/')[2] || 'unknown';
    return [
      { url: href, partition: `agency:${agencyKey}`, type: 'index' },
      ...(companionSearch(href) ? [{ url: companionSearch(href), partition: `agency_search:${agencyKey}`, type: 'index' }] : []),
    ];
  }

  if (/\/browse\/search$/i.test(u.pathname)) {
    if (/new auctions/i.test(label) || u.searchParams.get('startHours') === '24') return [{ url: href, partition: 'new_24h', type: 'index' }];
    if (/closing soon/i.test(label) || u.searchParams.get('endHours') === '24') return [{ url: href, partition: 'closing_24h', type: 'index' }];
    if (/view all auctions/i.test(label)) return [{ url: href, partition: `view_all:${u.pathname}`, type: 'index' }];
  }
  return null;
}

/**
 * Extract current Public Surplus browse navigation from anchors, select/option
 * controls and form actions. Only verified Public Surplus URLs are emitted.
 */
export function parseDiscoveryLinks(html, pageUrl, { includeAgencyPartitions = true } = {}) {
  const $ = load(html);
  const out = [];
  const seen = new Set();
  const add = (url, partition, type = 'index') => {
    if (!url || !isPublicSurplusUrl(url)) return;
    const canonical = canonicalizePublicSurplusUrl(url);
    if (canonical === canonicalizePublicSurplusUrl(pageUrl) || seen.has(canonical)) return;
    seen.add(canonical);
    out.push({ url: canonical, partition, type });
  };
  const classifyAndAdd = (href, label = '') => {
    if (!href || !isPublicSurplusUrl(href)) return;
    for (const item of classifyBrowseUrl(href, label, { includeAgencyPartitions }) || []) add(item.url, item.partition, item.type);
  };

  $('a[href]').each((_, el) => {
    const href = absolute($(el).attr('href'), pageUrl);
    classifyAndAdd(href, text($(el).text()));
  });

  // Public Surplus can expose region/agency navigation through selects/options.
  $('option[value]').each((_, el) => {
    const raw = $(el).attr('value');
    if (!raw || /^\s*(?:0|-1|#|javascript:)/i.test(raw)) return;
    const href = absolute(raw, pageUrl);
    classifyAndAdd(href, text($(el).text()));
  });

  // Some pages use forms whose action itself is a browse/search surface.
  $('form[action]').each((_, el) => {
    const href = absolute($(el).attr('action'), pageUrl);
    classifyAndAdd(href, text($(el).text()));
  });

  return out;
}