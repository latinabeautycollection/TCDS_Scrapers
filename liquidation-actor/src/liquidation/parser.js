import { load } from 'cheerio';
import { cleanText, money, integer, parseMoneyCurrency, parseLiquidationDate, inferAuctionStatus, timeRemainingSeconds } from './text.js';
import { parseAuctionIdentity, canonicalizeLiquidationUrl } from './url.js';
import { detectEligibility } from './eligibility.js';
import { extractLogisticsSignals } from './logistics.js';
import { parseDiscoveryLinks } from './discovery.js';
import { productFields } from './productFields.js';

function absolute(raw, base){try{return new URL(raw,base).toString();}catch{return null;}}
function esc(s){return String(s).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}
function rootAfter(root,label,stops=[]){const stop=stops.map(esc).join('|');const m=root.match(new RegExp(`${esc(label)}\\s*:?\\s*(.+?)${stop?`(?=${stop})`:'$'}`,'i'));return cleanText(m?.[1]||'');}
function labeledValue(root, labels, stops=[]){for(const l of labels){const v=rootAfter(root,l,stops);if(v)return v;}return null;}
function parsePercent(v){const m=String(v||'').match(/(\d+(?:\.\d+)?)\s*%/);return m?Number(m[1]):null;}
function canonicalCondition(raw){const s=cleanText(raw); if(!s)return 'UNKNOWN'; if(/^new$/i.test(s))return 'NEW'; if(/shelf pulls/i.test(s))return 'SHELF_PULLS'; if(/returns/i.test(s))return 'RETURNS'; if(/refurbished/i.test(s))return 'REFURBISHED'; if(/used/i.test(s))return 'USED'; if(/scratch|dent/i.test(s))return 'SCRATCH_AND_DENT'; if(/damaged/i.test(s))return 'DAMAGED'; if(/salvage/i.test(s))return 'SALVAGE'; return 'UNKNOWN';}
function listingType(raw){const s=cleanText(raw).toUpperCase(); if(/MIXED/.test(s))return 'MIXED_FORMAT'; if(/SEALED/.test(s))return 'SEALED_BID'; if(/FIXED/.test(s))return 'FIXED_PRICE'; if(/STANDARD|REGULAR/.test(s))return 'STANDARD_AUCTION'; return 'UNKNOWN';}
function purchaseModes(type){if(type==='MIXED_FORMAT')return ['SEALED_BID','BUY_NOW']; if(type==='SEALED_BID')return ['SEALED_BID']; if(type==='FIXED_PRICE')return ['BUY_NOW']; if(type==='STANDARD_AUCTION')return ['AUCTION']; return [];}
function nearestCardText($,a){const cs=[a.closest('[class*=auction]'),a.closest('[class*=result]'),a.closest('article'),a.closest('li'),a.parent().parent().parent(),a.parent().parent(),a.parent()];for(const c of cs){const t=cleanText(c.text());if(t&&t.length>=20)return t;}return cleanText(a.text());}
function detailHref(raw){try{const u=new URL(raw,'https://www.liquidation.com');return /^\/auction\/view$/i.test(u.pathname)&&/^\d+$/.test(u.searchParams.get('id')||'');}catch{return false;}}

export function parseSearchPage(html,pageUrl,discoveryOptions={}){
  const $=load(html),seen=new Set(),items=[];
  $('a[href]').each((_,el)=>{
    const a=$(el),raw=a.attr('href')||''; if(!detailHref(raw))return;
    const href=absolute(raw,pageUrl),id=href&&parseAuctionIdentity(href); if(!id||seen.has(id.externalId))return;
    const anchorText=cleanText(a.text()); if(/bid now|watchlist|compare/i.test(anchorText)) return;
    seen.add(id.externalId); const card=nearestCardText($,a);
    const priceMatch=card.match(/Current Bid\s*:\s*(?:(?:US\s*)?\$|C\$|CAD\s*\$?|USD\s*\$?)\s*[\d,.]+(?:\s*\([A-Z]{3}\))?/i);
    const parsedPrice=parseMoneyCurrency(priceMatch?.[0]);
    const currentPrice=parsedPrice.amount;
    const bidCount=integer(card.match(/\(\s*\d+\s*Bids?\s*\)/i)?.[0]||card.match(/\b\d+\s*Bids?\b/i)?.[0]);
    const location=cleanText(card.match(/Location\s*:\s*([^|]+?)(?=Current Bid|CLOSING|Qty|Number of|$)/i)?.[1]||'')||null;
    const condition=cleanText(card.match(/(?:Qty\s*:\s*[\d,]+\s*\|\s*)(New|Returns|Shelf Pulls|Refurbished|Used|Damaged|Salvage|Scratch and Dent)/i)?.[1]||'')||null;
    const qty=integer(card.match(/Qty\s*:\s*[\d,]+/i)?.[0]);
    const packages=integer(card.match(/Number of (?:Packages|Pallets)\s*:\s*[\d,]+/i)?.[0]);
    const closeRaw=cleanText(card.match(/CLOSING\s*:\s*(.+?)(?=Location|Current Bid|Qty|Number of|$)/i)?.[1]||'');
    const auctionEndTime=parseLiquidationDate(closeRaw);
    items.push({...id,listingUrl:id.canonicalUrl,title:anchorText||null,currentPrice,currency:parsedPrice.currency,bidCount,location,condition,quantity:qty,packages,auctionEndTime,indexText:card});
  });
  const pagination=[],pseen=new Set();
  $('a[href]').each((_,el)=>{const href=absolute($(el).attr('href'),pageUrl);if(!href)return;let u;try{u=new URL(href);}catch{return;}if(!/(^|\.)liquidation\.com$/i.test(u.hostname)||!/^\/auction\/search$/i.test(u.pathname)||!u.searchParams.has('_page'))return;const c=canonicalizeLiquidationUrl(href);if(!pseen.has(c)){pseen.add(c);pagination.push(c);}});
  const countText=cleanText($('.searchResultsContainer .countClass').first().text());
  const resultCount=/^[\d,]+$/.test(countText)?Number(countText.replace(/,/g,'')):null;
  const explicitEmpty=items.length===0 && resultCount===0 && /didn.t find any auctions|no auctions|no results/i.test(cleanText($('.noSearchText').text()));
  return {items,pagination,resultCount,explicitEmpty,discoveryLinks:parseDiscoveryLinks(html,pageUrl,discoveryOptions)};
}

export function looksLikeErrorPage(html){
  const $=load(html);const t=cleanText($.root().text()),title=cleanText($('title').first().text());
  const signal=/Auction Id\s*\d+/i.test(t)||/\/auction\/view\?id=\d+/i.test(html)||/Search Results/i.test(t);
  if(/access denied|request blocked|temporarily unavailable|service unavailable|forbidden|maintenance|system error|unexpected error/i.test(`${title} ${t}`)&&!signal)return true;
  if(/captcha|verify you are human|security check|challenge/i.test(t)&&!signal)return true;
  return !t&&!signal;
}

function itemScope($){const selectors=['#auctionData','#auction-details','.auction-details','.auction-detail','#auctionDetail','main'];for(const s of selectors){const e=$(s).first();if(e.length&&cleanText(e.text()).length>100)return e;}return $('body');}
function itemDocuments($,url){const out=[],seen=new Set();$('a[href]').each((_,el)=>{const a=$(el),txt=cleanText(a.text()),href=absolute(a.attr('href'),url);if(!href||seen.has(href))return;if(/manifest|download/i.test(txt)||/aucimg\/.*m\d+\.html|csv_manifest/i.test(href)){seen.add(href);out.push({title:txt||'Manifest',url:href,type:/csv_manifest/i.test(href)?'csv':'html_manifest'});}});return out;}

// ---- V1.1.2 helpers (selectors verified against a recorded live lot page) ----
function blockText($, nodes) {
  const parts = [];
  nodes.forEach((n) => {
    const c = $(n).clone();
    c.find('script,style,noscript').remove();
    c.find('br').replaceWith('\n');
    c.find('p,div,li,tr,h1,h2,h3,h4,h5,h6,ul,ol,table').append('\n');
    parts.push(c.text());
  });
  return parts.join('\n').replace(/\u00a0/g, ' ').split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
// Seller-written description lives in #description_table (itemprop=description).
function descriptionFromDom($) {
  const box = $('#description_table').first();
  if (!box.length) return null;
  const txt = blockText($, [box[0]]);
  return txt || null;
}
// The lot's own photos are only in an inline script: auctionView_images.push({"image_url": "/shared/auction/images/photos/<n>/widget/<id>_widget.jpg", ...}).
// The <img> carousels on the page belong to OTHER lots ("More From This Seller"), so never read those.
function extractImages(html, pageUrl) {
  const out = [], seen = new Set();
  const re = /"image_url"\s*:\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const href = absolute(m[1].replace(/\\\//g, '/'), pageUrl);
    if (!href || !/\.(?:jpe?g|png|webp)(?:[?#]|$)/i.test(href) || seen.has(href)) continue;
    seen.add(href); out.push(href);
  }
  return out.slice(0, 20);
}
// Breadcrumb: #breadcrumbCategory (top level) and #breadcrumbSubCategories (sub level).
function categoriesFromDom($) {
  const top = cleanText($('#breadcrumbCategory a').first().text()) || null;
  const sub = cleanText($('#breadcrumbSubCategories > a').first().text()) || null;
  return { category: top, subcategory: sub };
}
// #auctionStats: a row of labels (Views, Bids, Bidders, Watching) followed by a row of numbers.
function statsFromDom($) {
  const rows = $('#auctionStats .row').toArray();
  for (let i = 0; i < rows.length - 1; i += 1) {
    const labels = $(rows[i]).children().toArray().map((c) => cleanText($(c).text()));
    if (labels.join('|') === 'Views|Bids|Bidders|Watching') {
      const vals = $(rows[i + 1]).children().toArray().map((c) => integer(cleanText($(c).text())));
      return { views: vals[0] ?? null, bids: vals[1] ?? null, bidders: vals[2] ?? null, watching: vals[3] ?? null };
    }
  }
  return null;
}

// Label/value rows inside the lot box: <div class="row"><div>Location</div><div>Deer Park, NY</div></div>.
// Never search the whole page for these labels: "Location", "Seller" and "Closed" also appear in the site nav/footer.
function rowValue($, label) {
  const box = $('#auctionData').first();
  if (!box.length) return null;
  let value = null;
  box.find('.row').each((_, r) => {
    if (value !== null) return;
    const kids = $(r).children().toArray();
    if (kids.length >= 2 && cleanText($(kids[0]).text()) === label) value = cleanText($(kids[1]).text()) || null;
  });
  return value;
}
function labelValuePairs($) {
  const pairs = [];
  const lot = $('#auctionData').first();
  const root = lot.length ? lot : $('body');
  const shippingDetails = $('#shipping_details').first();
  const add = (label, value) => {
    const cleanLabel = cleanText(label);
    const cleanValue = cleanText(value);
    if (!cleanLabel || !cleanValue) return;
    if (!pairs.some((pair) => pair.label === cleanLabel && pair.value === cleanValue)) pairs.push({ label: cleanLabel, value: cleanValue });
  };
  root.find('.row').each((_, row) => {
    const cells = $(row).children().toArray();
    if (cells.length >= 2) add($(cells[0]).text(), cells.slice(1).map((cell) => cleanText($(cell).text())).join(' '));
  });
  root.find('table tr').each((_, row) => {
    const cells = $(row).children('th,td').toArray();
    if (cells.length >= 2) add($(cells[0]).text(), cells.slice(1).map((cell) => cleanText($(cell).text())).join(' | '));
  });
  root.find('dl').each((_, list) => {
    const children = $(list).children().toArray();
    for (let i = 0; i < children.length - 1; i += 1) {
      if ($(children[i]).is('dt')) add($(children[i]).text(), $(children[i + 1]).text());
    }
  });
  if (shippingDetails.length) {
    shippingDetails.find('.row').each((_, row) => {
      const cells = $(row).children().toArray();
      if (cells.length >= 2) add($(cells[0]).text(), cells.slice(1).map((cell) => cleanText($(cell).text())).join(' '));
    });
    shippingDetails.find('table tr').each((_, row) => {
      const cells = $(row).children('th,td').toArray();
      if (cells.length >= 2) add($(cells[0]).text(), cells.slice(1).map((cell) => cleanText($(cell).text())).join(' | '));
    });
  }
  const statRows = $('#auctionStats .row').toArray();
  if (statRows.length >= 2) {
    const labels = $(statRows[0]).children().toArray().map((cell) => cleanText($(cell).text()));
    const values = $(statRows[1]).children().toArray().map((cell) => cleanText($(cell).text()));
    if (labels.length === values.length) labels.forEach((label, index) => add(label, values[index]));
  }
  return pairs;
}
function pageVariables($) {
  const out = [];
  $('script').each((index, script) => {
    const raw = $(script).html() || '';
    if (/(?:auction|bid|price|start|end|close|date|time)/i.test(raw)) out.push({ index, raw });
  });
  return out;
}
function startTimeEvidence(pageText, pairs, variables, observedAt) {
  const pair = pairs.find(({ label }) => /^(?:(?:auction|bidding)\s+)?(?:start(?:s| date| time)?|opening date|opens)$/i.test(label));
  const textMatch = pageText.match(/(?:Auction\s+Starts?|Bidding\s+Starts?|Opening\s+Date|Auction\s+Start\s+Date|Opens)\s*:?\s*(.+?)(?=(?:CLOSES|CLOSED ON|Current Bid|WINNING BID|Minimum Bid|Auction Type|Shipping Terms)|$)/i);
  const variableMatch = variables.flatMap(({ raw }) => [...raw.matchAll(/([\w$]*(?:auction)?(?:start|open)[\w$]*(?:date|time)?)["']?\s*[:=]\s*["']([^"']{4,80})["']/gi)])
    .map((match) => ({ raw: match[2] }))
    .find(({ raw }) => parseLiquidationDate(raw, observedAt));
  const raw = pair?.value || textMatch?.[1] || variableMatch?.raw || null;
  const parsed = raw ? parseLiquidationDate(raw, observedAt) : null;
  return { raw, parsed, source: parsed ? 'published_by_site' : raw ? 'published_but_unparsed' : 'not_published_by_site' };
}
const shortOrNull = (v, max = 160) => (v && v.length <= max ? v : null);

export function parseDetailPage(html,url,observedAt=new Date().toISOString()){
  const $=load(html),identity=parseAuctionIdentity(url); if(!identity)throw new Error('LIQUIDATION_DETAIL_ID_MISSING');
  const scope=itemScope($),root=cleanText(scope.text()),pageText=cleanText($('body').text());
  const title=cleanText($('h1').first().text()); if(!title)throw new Error('LIQUIDATION_DETAIL_TITLE_MISSING');
  const auctionId=cleanText(root.match(/Auction Id\s+(\d+)/i)?.[1]||pageText.match(/Auction Id\s+(\d+)/i)?.[1]||identity.auctionId);
  const moneyToken='(?:(?:US\\s*)?\\$|C\\$|CAD\\s*\\$?|USD\\s*\\$?)\\s*[\\d,.]+(?:\\s*\\([A-Z]{3}\\))?';
  let bidCount=null;
  const stats=statsFromDom($);
  if(stats&&stats.bids!=null) bidCount=stats.bids;
  // A sealed-bid counter is shown as the word "Sealed" rather than a count.
  // Do not turn it into zero or borrow a count from another lot elsewhere on the page.
  if(bidCount==null&&!$('#auctionStats').length){const countMatch=root.match(/\b(\d+)\s+Bids?\b/i);if(countMatch)bidCount=Number(countMatch[1]);else if(/\bNo Bids\b/i.test(root))bidCount=0;}
  const currentBidMatch=root.match(new RegExp(`(?:Current Bid|WINNING BID)\\s*:?\\s*${moneyToken}`,'i'));
  const buyNowMatch=root.match(new RegExp(`Buy Now(?: Price)?\\s*:?\\s*${moneyToken}`,'i'));
  const fixedPriceMatch=root.match(new RegExp(`Fixed Price\\s*:?\\s*${moneyToken}`,'i'));
  const openingMatch=root.match(new RegExp(`(?:Starting|Opening) Bid\\s*:?\\s*${moneyToken}`,'i'));
  const minRe=new RegExp(`(?:Minimum Bid\\s*:?\\s*|Enter\\s*)(${moneyToken})(?:\\s+or more)?`,'i');
  const minMatch=root.match(minRe);
  const minimumBid=money(minMatch?.[0]);
  const typeText=cleanText(root.match(/Auction Type\s+(Standard|Fixed Price|Sealed Bid|Mixed Format)/i)?.[1]||pageText.match(/Auction Type\s+(Standard|Fixed Price|Sealed Bid|Mixed Format)/i)?.[1]||'');
  const type=listingType(typeText);
  const noBids=bidCount===0||(bidCount==null&&!currentBidMatch&&minimumBid!=null);
  let chosenPriceMatch=currentBidMatch||null;
  let priceType=currentBidMatch?'current_bid':null;
  if(type==='FIXED_PRICE'){
    chosenPriceMatch=buyNowMatch||fixedPriceMatch||currentBidMatch;
    priceType=chosenPriceMatch?'buy_now':null;
  }else if(noBids&&type==='STANDARD_AUCTION'){
    const displayedBid=money(currentBidMatch?.[0]);
    const candidate=(displayedBid!=null&&displayedBid>0?displayedBid:null)??money(openingMatch?.[0])??minimumBid;
    if(candidate!=null&&candidate>0){chosenPriceMatch=[String(candidate)];priceType='starting_bid';}
    else if(buyNowMatch){chosenPriceMatch=buyNowMatch;priceType='buy_now';}
  }else if(!chosenPriceMatch&&minimumBid!=null&&minimumBid>0){chosenPriceMatch=[String(minimumBid)];priceType='starting_bid';}
  else if(!chosenPriceMatch&&buyNowMatch){chosenPriceMatch=buyNowMatch;priceType='buy_now';}
  else if(!chosenPriceMatch&&openingMatch){chosenPriceMatch=openingMatch;priceType='starting_bid';}
  const priceParsed=chosenPriceMatch?.[0]&&/^\d/.test(chosenPriceMatch[0])
    ? {amount:Number(chosenPriceMatch[0]),currency:null}
    : parseMoneyCurrency(chosenPriceMatch?.[0]);
  if(priceParsed.amount===0&&minimumBid>0&&noBids){priceParsed.amount=minimumBid;priceType='starting_bid';}
  else if(priceParsed.amount===0){priceParsed.amount=null;priceType=null;}
  const boxEl=$('#auctionData').first();
  const boxText=boxEl.length?cleanText(boxEl.text()):pageText;
  const closedRaw=boxText.match(/CLOSED ON\s+([^\n]+?\b(?:ET|EST|EDT))/i)?.[1]||pageText.match(/CLOSED ON\s+([^\n]+?\b(?:ET|EST|EDT))/i)?.[1];
  const closeRaw=boxText.match(/\(?CLOSES\s+([^\)]+)\)?/i)?.[1]||pageText.match(/\(?CLOSES\s+([^\)]+)\)?/i)?.[1];
  const auctionEndRaw=closedRaw||closeRaw||'';
  const auctionEndTime=parseLiquidationDate(auctionEndRaw,observedAt);
  // Status only from explicit signals: the page's boilerplate says "winning bidder" on every lot, so never match that text.
  const statusSignal=[closedRaw?`CLOSED ON ${closedRaw}`:'',/\bthis (?:auction|lot) (?:has been|was|is) (?:cancelled|canceled)\b/i.test(boxText.slice(0,900))?'cancelled':''].join(' ');
  const auctionStatus=inferAuctionStatus(statusSignal,auctionEndTime,new Date(observedAt));
  const location=shortOrNull(rowValue($,'Location')||cleanText(boxText.match(/Location\s+(.+?)(?=Seller\s|Detailed Seller Ratings|Condition\s|$)/i)?.[1]||'')||null);
  const seller=shortOrNull(cleanText((rowValue($,'Seller')||boxText.match(/Seller\s+(.+?)(?=\(View Seller Rating\)|Detailed Seller Ratings|Condition\s|$)/i)?.[1]||'').replace(/\s*\(View Seller Rating\).*$/i,''))||null,120);
  const conditionRaw=cleanText(root.match(/Condition\s+(Scratch and Dent|Damaged|Salvage|Shelf Pulls|Returns|Refurbished|Used|New)\b/i)?.[1]||'')||null;
  const shippingTerms=cleanText(root.match(/Shipping Terms\s+(.+?)(?=Shipping Estimate|Total Weight|Quantity In Lot|Est Retail|Bid Price|Buyer'?s Premium|Auction Type|$)/i)?.[1]||'')||null;
  const quantity=integer(root.match(/Quantity In Lot\s+[\d,]+/i)?.[0]);
  const variance=Number(root.match(/Quantity Variance\s*(\d+(?:\.\d+)?)\s*%/i)?.[1]||NaN);
  const weight=cleanText(root.match(/Total Weight\s+(.+?)(?=Quantity In Lot|Shipping Estimate|Minimum Shipping Fee|Buyer'?s Premium|Auction Type|$)/i)?.[1]||'')||null;
  const premiumPct=parsePercent(root.match(/Buyer'?s Premium\s+\d+(?:\.\d+)?\s*%/i)?.[0]);
  const auctionTypeRaw=typeText;
  let modes=purchaseModes(type);
  const instructionScope=cleanText(scope.find('[class*=auction],[class*=bid],[class*=detail],[class*=summary]').text()) || root;
  if ((type==='SEALED_BID' || type==='MIXED_FORMAT') && /with\s+a\s+Buy Now\s+option|Buy Now\s+option/i.test(instructionScope)) {
    modes=[...new Set([...modes,'BUY_NOW'])];
  }
  const descriptionFlat=cleanText(root.match(/Product Description\s+(?:View Manifest\s*)?(.+?)(?=Shipping Details|Terms & Conditions|Additional Auctions by|Sponsored Ads|$)/i)?.[1]||'')||null;
  const description=descriptionFromDom($)||descriptionFlat;
  const images=extractImages(html,url);
  const cats=categoriesFromDom($);
  const shippingDetails=$('#shipping_details').first();
  const shippingScope=shippingDetails.length?cleanText(shippingDetails.text()):'';
  const logistics=extractLogisticsSignals([root,shippingScope].filter(Boolean).join(' '));
  const pairs=labelValuePairs($);
  const productPairs = [...pairs];
  $('#description_table tr').each((_, row) => {
    const cells = $(row).children('td,th');
    if (cells.length === 2) productPairs.push({ label: cleanText(cells.eq(0).text()), value: cleanText(cells.eq(1).text()) });
  });
  const product = productFields(productPairs, description, title);
  const rowShippingOptions=pairs.filter(({label})=>/shipping|freight|pickup/i.test(label))
    .map(({label,value})=>({label,value,amount:parseMoneyCurrency(value).amount}))
    .filter((option)=>option.amount!=null);
  const shippingOptions=[...new Map([...logistics.shipping_options,...rowShippingOptions].map((option)=>[JSON.stringify(option),option])).values()];
  const shippingAmounts=shippingOptions.map((option)=>option.amount).filter((value)=>Number.isFinite(value)&&value>=0);
  const estimatedShipping=logistics.shipping_method==='pickup_only'?null:logistics.shipping_method==='free_shipping'?0:shippingAmounts.length?Math.min(...shippingAmounts):null;
  if(estimatedShipping!=null&&logistics.shipping_method!=='pickup_only') logistics.shipping_method=estimatedShipping===0?'free_shipping':'shipping';
  const variables=pageVariables($);
  const startTime=startTimeEvidence(root,pairs,variables,observedAt);
  const docs=itemDocuments($,url);
  const manifestHtml=docs.find(d=>d.type==='html_manifest')?.url||null;
  const manifestCsv=docs.find(d=>d.type==='csv')?.url||null;
  const fulfilledBy=cleanText(root.match(/Fulfilled by\s+(?:a\s+)?(.+?)(?=Time Left|CLOSED ON|Current Bid|WINNING BID|$)/i)?.[1]||'')||null;
  const sellerType=/marketplace seller/i.test(fulfilledBy||root)?'MARKETPLACE_SELLER':/liquidation\.com warehouse/i.test(fulfilledBy||root)?'LIQUIDATION_WAREHOUSE':null;
  const sellerStats={
    selling_for: cleanText(root.match(/Selling for:\s*(.+?)(?=Lifetime Completed Transactions|Past 90 Days|$)/i)?.[1]||'')||null,
    lifetime_completed_transactions: cleanText(root.match(/Lifetime Completed Transactions:\s*([^\n]+?)(?=Past 90 Days|Completed Transactions|$)/i)?.[1]||'')||null,
    percent_cancelled_transactions: Number(root.match(/Percent cancelled transactions\s*\|?\s*(\d+(?:\.\d+)?)%/i)?.[1]||NaN),
    average_days_to_ship: Number(root.match(/Average days to ship\s*\|?\s*(\d+(?:\.\d+)?)/i)?.[1]||NaN),
    percent_honored_disputes: Number(root.match(/Percent of honored disputes\s*\|?\s*(\d+(?:\.\d+)?)%/i)?.[1]||NaN),
  };
  for(const k of Object.keys(sellerStats)) if(typeof sellerStats[k]==='number'&&!Number.isFinite(sellerStats[k])) sellerStats[k]=null;
  const msrpRaw=money(root.match(/(?:MSRP|Est Retail(?: Per Unit)?)\s*\$\s*[\d,.]+/i)?.[0]);const msrp=msrpRaw>0?msrpRaw:null;
  const bidPerUnit=money(root.match(/Bid Price Per Unit\s*\$\s*[\d,.]+/i)?.[0]);
  const packageCount=integer(root.match(/Number of Packages\s+\d+/i)?.[0]);
  const palletCount=integer(root.match(/Number of Pallets\s+\d+/i)?.[0]);
  const currency=priceParsed.currency || parseMoneyCurrency(minMatch?.[0]).currency || 'USD';
  const geoCountry=/\b(?:ON|QC|BC|AB|MB|SK|NB|NS|PE|NL|YT|NT|NU)\b|Canada/i.test(location||'')?'CA':'US';
  const eligibility=detectEligibility(pageText);
  const lower=String(description||'').toLowerCase();
  return {
    source:'liquidation',source_type:'wholesale_liquidation',record_type:'auction_listing',external_id:identity.externalId,asset_id:auctionId,auction_id:auctionId,lot_number:null,
    listing_url:identity.canonicalUrl,canonical_url:identity.canonicalUrl,title,description,category:cats.category,subcategory:cats.subcategory,bidder_count:stats?.bidders??null,view_count:stats?.views??null,watcher_count:stats?.watching??null,
    condition:canonicalCondition(conditionRaw),raw_condition:conditionRaw,condition_notes:conditionRaw,
    ...product,
    listing_type:type,available_purchase_modes:modes,current_price:priceParsed.amount,buy_now_price:money(buyNowMatch?.[0]),price_type:priceType,price_status:noBids&&type==='STANDARD_AUCTION'?'NO_BIDS_YET':auctionStatus==='ENDED'&&priceParsed.amount!=null?'FINAL_SOLD_PRICE':type==='FIXED_PRICE'?'FIXED_PRICE':type==='SEALED_BID'&&priceParsed.amount==null?'SEALED_BID_HIDDEN':priceType==='starting_bid'?'STARTING_BID':priceParsed.amount!=null?'CURRENT_BID':'NOT_YET_PUBLISHED',
    starting_price:priceType==='starting_bid'?priceParsed.amount:null,minimum_bid:minimumBid,bid_increment:null,bid_count:bidCount,reserve_status:null,reserve_met:null,
    buyers_premium:premiumPct!=null&&priceParsed.amount!=null?Math.round(priceParsed.amount*premiumPct)/100:null,buyers_premium_pct:premiumPct,buyers_premium_source:premiumPct!=null?(priceParsed.amount!=null?'DERIVED_FROM_CURRENT_OBSERVED_PRICE':'PUBLISHED_PERCENTAGE'):null,buyers_premium_confidence:premiumPct!=null?(priceParsed.amount!=null?0.75:1):null,
    tax_estimate:null,estimated_shipping:estimatedShipping,total_estimated_cost:null,currency,
    shipping_method:logistics.shipping_method,
    shipping_evidence:logistics.shipping_evidence,
    auction_start_time:startTime.parsed,auction_start_time_source:startTime.source,auction_end_time:auctionEndTime,auction_status:auctionStatus,time_remaining_seconds:timeRemainingSeconds(auctionEndTime,observedAt),auction_extension_possible:null,
    location,country:geoCountry,seller_name:seller,seller_agency:seller,seller_type:sellerType,
    shipping_available:logistics.shipping_available,pickup_required:logistics.pickup_required,pickup_location:logistics.pickup_location,inspection_available:null,inspection_details:null,
    payment_terms:logistics.payment_terms,removal_deadline:null,removal_requirements:logistics.removal_requirements,quantity,unit_count:quantity,images,documents:docs,
    known_damage:/damaged|broken|non-functioning|nonfunctional/i.test(lower),missing_parts:/missing parts|incomplete/i.test(lower),mechanical_issue:null,electrical_issue:null,cosmetic_damage:/scratch|dent|cosmetic/i.test(lower),not_tested:/not tested|untested|not individually inspected/i.test(lower),working_condition_unknown:/unknown|unverified|not individually inspected/i.test(lower),parts_only:/parts only/i.test(lower),salvage:/salvage/i.test(lower),
    scraped_at:observedAt,observed_at:observedAt,
    source_meta:{transport:'liquidation_html',auction_id:auctionId,auction_type_raw:auctionTypeRaw,listing_type:type,available_purchase_modes:modes,bid_count:bidCount,minimum_bid:minimumBid,buyers_premium_pct:premiumPct,quantity,quantity_variance_pct:Number.isFinite(variance)?variance:null,shipping_terms:shippingTerms,minimum_shipping_fee:logistics.minimum_shipping_fee,shipping_weight:weight,shipping_restrictions:logistics.shipping_restrictions,package_count:packageCount,pallet_count:palletCount,estimated_retail_value:msrp,bid_price_per_unit:bidPerUnit,manifest_available:docs.length>0,manifest_html_url:manifestHtml,manifest_csv_url:manifestCsv,fulfilled_by:fulfilledBy,seller_stats:sellerStats},
    source_record:{page_url:url,page_html:String(html),label_values:pairs,full_description:description,description_html:$('#description_table').first().html()||null,shipping_options:shippingOptions,shipping_terms:logistics.shipping_terms,auction_start_time_raw:startTime.raw,auction_end_time_raw:auctionEndRaw,price_text:{current_bid:currentBidMatch?.[0]||null,minimum_bid:minMatch?.[0]||null,minimum_offer:minimumBid!=null?String(minimumBid):null,opening_bid:openingMatch?.[0]||null,buy_now:buyNowMatch?.[0]||null,fixed_price:fixedPriceMatch?.[0]||null},page_variables:variables},
    ...eligibility,
  };
}


function headerKey(v){return cleanText(v).toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'');}
export function parseManifestHtml(html, manifestUrl, parent = {}) {
  const $=load(html); const rows=[];
  $('table').each((_,table)=>{
    const headers=[]; $(table).find('tr').first().find('th,td').each((__,cell)=>headers.push(headerKey($(cell).text())));
    if(!headers.length || !headers.some(h=>/sku|upc|description|product|quantity|qty|retail/.test(h))) return;
    $(table).find('tr').slice(1).each((rowIndex,tr)=>{
      const cells=[]; $(tr).find('td').each((__,cell)=>cells.push(cleanText($(cell).text())));
      if(!cells.length || cells.every(v=>!v)) return;
      const data={}; headers.forEach((h,i)=>{ if(h) data[h]=cells[i]??null; });
      const sku=data.sku||data.item_sku||data.product_sku||data.item_number||null;
      const upc=data.upc||data.upc_code||data.barcode||null;
      const description=data.description||data.product_description||data.product||data.item_description||data.title||null;
      const quantity=integer(data.quantity||data.qty||data.units||data.unit_quantity||null);
      const retail=parseMoneyCurrency(data.retail_price||data.retail||data.msrp||data.extended_retail||null);
      const notes=data.notes||data.note||data.comments||data.condition_notes||null;
      const lineNo=rowIndex+1;
      if(!sku&&!upc&&!description&&quantity==null&&retail.amount==null) return;
      rows.push({
        line_no:lineNo, sku, upc, description, quantity, retail_price:retail.amount, retail_currency:retail.currency||parent.currency||null, notes,
        raw:data, manifest_url:manifestUrl, auction_id:parent.auction_id||null, parent_external_id:parent.external_id||null, parent_listing_url:parent.listing_url||null,
      });
    });
  });
  return rows;
}