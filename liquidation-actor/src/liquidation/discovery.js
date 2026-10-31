import { load } from 'cheerio';
import { canonicalizeLiquidationUrl, isLiquidationUrl, liquidationSearchUrl } from './url.js';

export const LIQUIDATION_ACTIVE = liquidationSearchUrl();
export const LIQUIDATION_CLOSING = 'https://www.liquidation.com/auction/search?flag=new&sort=closing_time';
export const LIQUIDATION_PRICE_DESC = 'https://www.liquidation.com/auction/search?ascending=0&flag=new&sort=current_bid';
export const LIQUIDATION_QUANTITY_DESC = 'https://www.liquidation.com/auction/search?ascending=0&flag=new&sort=number_of_items_per_lot';
export const LIQUIDATION_COMPLETED = 'https://www.liquidation.com/auction/search?flag=closed';
export const LIQUIDATION_CATEGORY_INDEX = 'https://www.liquidation.com/c/allcategories.html';

function absolute(raw, base) { try { return new URL(raw, base).toString(); } catch { return null; } }
function text(v) { return String(v || '').replace(/\s+/g,' ').trim(); }

// Empty unfiltered search can still expose populated category search routes.
// Follow at most three observed categories within the requested global scope;
// never broaden an operator's keyword, seller, category, or other filter.
export function emptyGlobalCategoryFallback(parsed, pageUrl, keyword = '') {
  const u = new URL(pageUrl);
  if (keyword || parsed.items?.length || !/^\/auction\/search$/i.test(u.pathname)) return [];
  if ([...u.searchParams].some(([key]) => !['flag','sort','ascending','_page'].includes(key))) return [];
  if (u.searchParams.get('flag') === 'closed') return [];
  const seen = new Set(); const out = [];
  for (const link of parsed.discoveryLinks || []) {
    if (!isLiquidationUrl(link.url)) continue;
    const candidate = new URL(link.url);
    const category = candidate.searchParams.get('searchparam_category1');
    if (!category || candidate.searchParams.get('flag') === 'closed' || seen.has(category)) continue;
    seen.add(category); out.push(link.url);
    if (out.length === 3) break;
  }
  return out;
}

export function exhaustiveSeedRequests({ includeCompleted = false } = {}) {
  const out = [
    { url: LIQUIDATION_ACTIVE, partition: 'global_active' },
    { url: LIQUIDATION_CLOSING, partition: 'closing_time' },
    { url: LIQUIDATION_PRICE_DESC, partition: 'price_desc' },
    { url: LIQUIDATION_QUANTITY_DESC, partition: 'quantity_desc' },
    { url: LIQUIDATION_CATEGORY_INDEX, partition: 'category_index' },
  ];
  if (includeCompleted) out.push({ url: LIQUIDATION_COMPLETED, partition: 'completed' });
  return out;
}

function partitionForSearchUrl(u, label, options = {}) {
  const { includeSellerPartitions = true, includeCategoryPartitions = true, includeCompleted = false } = options;
  if (!/^\/auction\/search$/i.test(u.pathname)) return null;
  if ((u.searchParams.get('flag') || '').toLowerCase() === 'closed' && !includeCompleted) return null;
  const l = text(label).toLowerCase();
  const seller = u.searchParams.get('searchparam_seller') || u.searchParams.get('seller') || u.searchParams.get('searchparam_dimension_seller');
  if (seller && includeSellerPartitions) return `seller:${seller}`;
  const category = u.searchParams.get('searchparam_category1') || u.searchParams.get('searchparam_category2') || u.searchParams.get('category') || u.searchParams.get('searchparam_category');
  if (category && includeCategoryPartitions) return `category:${category}`;
  const dimension = u.searchParams.get('searchparam_dimension');
  if (dimension) return `dimension:${dimension}`;
  const location = u.searchParams.get('searchparam_location') || u.searchParams.get('location');
  if (location) return `location:${location}`;
  const warehouse = u.searchParams.get('searchparam_warehouse') || u.searchParams.get('warehouse');
  if (warehouse) return `warehouse:${warehouse}`;
  const shipping = u.searchParams.get('searchparam_shipping') || u.searchParams.get('shipping');
  if (shipping) return `shipping:${shipping}`;
  const auctionType = u.searchParams.get('searchparam_auctiontype') || u.searchParams.get('auctionType');
  if (auctionType) return `auction_type:${auctionType}`;
  const condition = u.searchParams.get('searchparam_condition') || u.searchParams.get('condition');
  if (condition) return `condition:${condition}`;
  if (u.searchParams.has('_page')) return 'pagination';
  if (/closing/.test(l) || u.searchParams.get('sort') === 'closing_time') return 'closing_time';
  if (u.searchParams.get('sort') === 'current_bid') return 'price_sort';
  if (u.searchParams.get('sort') === 'number_of_items_per_lot') return 'quantity_sort';
  if ((u.searchParams.get('flag') || '').toLowerCase() === 'closed') return 'completed';
  return 'global_active';
}

export function parseDiscoveryLinks(html, pageUrl, options = {}) {
  const $ = load(html); const out=[]; const seen=new Set();
  const add=(raw,label='')=>{
    const href=absolute(raw,pageUrl); if(!href||!isLiquidationUrl(href)) return;
    let u; try { u=new URL(href); } catch { return; }
    const partition=partitionForSearchUrl(u,label,options); if(!partition) return;
    const c=canonicalizeLiquidationUrl(href); if(c===canonicalizeLiquidationUrl(pageUrl)||seen.has(c)) return;
    seen.add(c); out.push({url:c,partition,type:'index'});
  };
  $('a[href]').each((_,el)=>add($(el).attr('href'),$(el).text()));
  $('option[value]').each((_,el)=>{const v=$(el).attr('value'); if(v && !/^\s*(?:#|javascript:|0|-1)/i.test(v)) add(v,$(el).text());});
  // Liquidation search facets are also rendered as checkbox/radio inputs.
  // Prefer explicit data-url/formaction values; otherwise reconstruct only verified
  // auction/search query controls without inventing new routes.
  $('input[type=checkbox][value],input[type=radio][value]').each((_,el)=>{
    const e=$(el), direct=e.attr('data-url')||e.attr('formaction');
    if(direct){ add(direct,e.attr('name')||e.attr('value')); return; }
    const name=String(e.attr('name')||'').trim(), value=String(e.attr('value')||'').trim();
    if(!name||!value||!/^(searchparam_|seller$|category$|warehouse$|shipping$|condition$|auctionType$)/i.test(name)) return;
    let base; try{base=new URL(pageUrl);}catch{return;}
    if(!/^\/auction\/search$/i.test(base.pathname)) return;
    base.searchParams.set(name,value);
    base.searchParams.delete('_page');
    add(base.toString(),`${name}:${value}`);
  });
  return out;
}