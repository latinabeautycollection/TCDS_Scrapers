import { load } from 'cheerio';
import { canonicalizeMunicibidUrl, isMunicibidUrl } from './url.js';

export const MUNICIBID_ACTIVE = 'https://municibid.com/browse';
export const MUNICIBID_NEWEST = 'https://municibid.com/browse?sort=newest';
export const MUNICIBID_POPULAR = 'https://municibid.com/browse?sort=mostBids';
export const MUNICIBID_MAP = 'https://municibid.com/map';
export const MUNICIBID_STATES = 'https://municibid.com/auctions';
export const MUNICIBID_COMPLETED = 'https://municibid.com/browse?status=completed';

function absolute(raw, base) { try { return new URL(raw, base).toString(); } catch { return null; } }
function text(v) { return String(v || '').replace(/\s+/g,' ').trim(); }

export function exhaustiveSeedRequests({ includeCompleted = false } = {}) {
  const out = [
    { url: MUNICIBID_ACTIVE, partition: 'global_active' },
    { url: MUNICIBID_NEWEST, partition: 'newest' },
    { url: MUNICIBID_POPULAR, partition: 'most_bids' },
    { url: MUNICIBID_MAP, partition: 'map_active' },
    { url: MUNICIBID_STATES, partition: 'states' },
  ];
  if (includeCompleted) out.push({ url: MUNICIBID_COMPLETED, partition: 'completed' });
  return out;
}

function classify(href, label = '', { includeSellerPartitions = true, includeCategoryPartitions = true, includeCompleted = false } = {}) {
  let u; try { u = new URL(href); } catch { return null; }
  if (!isMunicibidUrl(href)) return null;
  const path = u.pathname.replace(/\/$/,'');
  const lower = label.toLowerCase();
  if (/^\/listing\/\d+/i.test(path)) return null;
  if (path === '/map') return [{ url: href, partition: 'map_active', type: 'index' }];
  if (path === '/auctions') return [{ url: href, partition: 'states', type: 'index' }];
  if (/^\/auctions\/[a-z]{2}$/i.test(path)) {
    return [{ url: href, partition: `state:${path.split('/').pop().toUpperCase()}`, type: 'index' }];
  }
  if (!path.startsWith('/browse')) return null;
  if (u.searchParams.get('status') === 'completed' && !includeCompleted) return null;
  if (u.searchParams.get('sort') === 'newest' || /newest auctions/.test(lower)) return [{ url: href, partition: 'newest', type: 'index' }];
  if (u.searchParams.get('sort') === 'mostBids' || /most popular/.test(lower)) return [{ url: href, partition: 'most_bids', type: 'index' }];
  if (u.searchParams.has('seller') && includeSellerPartitions) return [{ url: href, partition: `seller:${u.searchParams.get('seller')}`, type: 'index' }];
  if (u.searchParams.has('region')) return [{ url: href, partition: `region_query:${u.searchParams.get('region')}`, type: 'index' }];
  if ((u.searchParams.has('category') || u.searchParams.has('cat')) && includeCategoryPartitions) {
    const categoryId=u.searchParams.get('category')||u.searchParams.get('cat');
    return [{ url: href, partition: `category_query:${categoryId}`, type: 'index' }];
  }
  if (/\/browse\/r\d+/i.test(path)) return [{ url: href, partition: `region:${path}`, type: 'index' }];
  if (/\/browse\/c\d+/i.test(path) && includeCategoryPartitions) return [{ url: href, partition: `category:${path}`, type: 'index' }];
  if (/\/browse\/.*c\d+/i.test(path) && includeCategoryPartitions) return [{ url: href, partition: `category_region:${path}`, type: 'index' }];
  if (path === '/browse') return [{ url: href, partition: u.searchParams.get('status') === 'completed' ? 'completed' : 'global_active', type: 'index' }];
  return [{ url: href, partition: `browse:${path}`, type: 'index' }];
}

export function parseDiscoveryLinks(html, pageUrl, options = {}) {
  const $ = load(html); const out=[]; const seen=new Set();
  const add=(url,partition,type='index')=>{
    if (!url || !isMunicibidUrl(url)) return;
    const c=canonicalizeMunicibidUrl(url);
    if (c===canonicalizeMunicibidUrl(pageUrl) || seen.has(c)) return;
    seen.add(c); out.push({url:c,partition,type});
  };
  const classifyAdd=(href,label='')=>{ for (const item of classify(href,label,options)||[]) add(item.url,item.partition,item.type); };
  $('a[href]').each((_,el)=>classifyAdd(absolute($(el).attr('href'),pageUrl),text($(el).text())));
  $('option[value]').each((_,el)=>{
    const raw=$(el).attr('value'); if (!raw || /^\s*(?:#|javascript:|0|-1)/i.test(raw)) return;
    classifyAdd(absolute(raw,pageUrl),text($(el).text()));
  });
  $('form[action]').each((_,el)=>classifyAdd(absolute($(el).attr('action'),pageUrl),text($(el).text())));
  return out;
}