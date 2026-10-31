import { detailEvidence, descriptionFromPayload, publishedValue, ownGalleryImages, collectSourceRecord } from './qaFields.js';
import { productFields } from './productFields.js';
import { classifyShipping } from './shippingEvidence.js';
import { load } from 'cheerio';
import { cleanText, money, integer, parseMunicibidDate, inferAuctionStatus, timeRemainingSeconds } from './text.js';
import { parseAuctionIdentity, canonicalizeMunicibidUrl } from './url.js';
import { detectEligibility } from './eligibility.js';
import { extractLogisticsSignals } from './logistics.js';
import { parseDiscoveryLinks } from './discovery.js';
import { normalizeBlockText } from './fieldRules.js';
import { parsePayloadListings, findPayloadListing, payloadString, toIsoUtc, titleCaseLocation, cleanMunicibidDescription, splitMedia, htmlToText } from './payload.js';

function absolute(raw, base){try{return new URL(raw,base).toString();}catch{return null;}}
function nearestCardText($,a){
  const cs=[a.closest('article'),a.closest('li'),a.closest('[class*=auction]'),a.closest('[class*=listing]'),a.closest('[class*=card]'),a.parent().parent().parent(),a.parent().parent(),a.parent()];
  for(const c of cs){const t=cleanText(c.text());if(t&&t.length>=12)return t;} return cleanText(a.text());
}
function listingHref(href){return /^\/listing\/\d+(?:\/|$)/i.test(href||'')||/municibid\.com\/listing\/\d+/i.test(href||'');}

export function parseSearchPage(html,pageUrl,discoveryOptions={}){
  const $=load(html);const seen=new Set(),items=[];
  $('a[href]').each((_,el)=>{
    const a=$(el),raw=a.attr('href')||''; if(!listingHref(raw))return;
    const href=absolute(raw,pageUrl),id=href&&parseAuctionIdentity(href);if(!id||seen.has(id.externalId))return;
    seen.add(id.externalId); const card=nearestCardText($,a);
    // Real card: <article class="listing-row"> ... <h3 class="listing-row__title"><a>Title</a></h3> ... (the first anchor is the photo link, with no text)
    let title=cleanText(a.closest('article,li,.listing-row').find('.listing-row__title,h3').first().text()||a.text()||a.attr('title')||'');
    if(!title||/^view$/i.test(title)) title=cleanText(card.split(/Bid\(s\):|Current Bid:/i)[0]||'');
    const currentPrice=money(card.match(/Current Bid\s*:\s*\$[\d,.]+/i)?.[0]);
    const bidCount=integer(card.match(/Bid\(s\)\s*:\s*\d+/i)?.[0]);
    const locSeller=card.match(/([A-Za-z .'-]+,\s*[A-Z]{2})\s*[|·]\s*([^|]+?)(?=Bid\(s\):|Current Bid:|ENDS IN|$)/i);
    items.push({...id,listingUrl:canonicalizeMunicibidUrl(href),title:title||null,currentPrice,bidCount,location:locSeller?.[1]?.trim()||null,sellerName:locSeller?.[2]?.trim()||null,indexText:card});
  });
  // Real listing data from the embedded Next.js payload (end time is NOT in the visible HTML).
  const payloadMap=parsePayloadListings(html);
  for(const it of items){
    const o=payloadMap.get(String(it.listingId||it.externalId?.replace(/^municibid-/,'')||''));
    if(!o)continue;
    it.auctionEndTime=toIsoUtc(o.endsAtUtc); it.agencyName=o.agencyName||null; it.sellerUserName=o.sellerUserName||null;
    it.payloadLocation=titleCaseLocation(o.location); it.payloadCurrentPrice=o.currentPrice??null; it.payloadBidCount=o.bidCount??null;
    it.primaryImageUrl=o.primaryImageUrl||null; it.reservePrice=o.reservePrice??null;
    if(it.payloadLocation) it.location=it.payloadLocation;
    if(o.title&&(!it.title||it.title.length>o.title.length+40)) it.title=o.title;
  }
  const pagination=[],pseen=new Set();
  $('a[href]').each((_,el)=>{const href=absolute($(el).attr('href'),pageUrl);if(!href)return;let u;try{u=new URL(href);}catch{return;}if(!/(^|\.)municibid\.com$/i.test(u.hostname))return;if(!/^\/browse/i.test(u.pathname))return;if(!u.searchParams.has('page'))return;const c=canonicalizeMunicibidUrl(href);if(!pseen.has(c)){pseen.add(c);pagination.push(c);}});
  return {items,pagination,discoveryLinks:parseDiscoveryLinks(html,pageUrl,discoveryOptions)};
}

function blockText($, node) {
  // Keep paragraph and list line breaks (intake guide); falls back to flat text if anything goes wrong.
  try {
    const $c = $(node).clone();
    $c.find('script,style,noscript').remove();
    $c.find('br').replaceWith('\n');
    $c.find('p,div,li,tr,h1,h2,h3,h4,h5,h6,ul,ol,table').each((_, el) => { $(el).append('\n'); });
    return normalizeBlockText($c.text());
  } catch {
    return cleanText($(node).text());
  }
}

function sectionByHeading($, re){
  let out=''; $('h1,h2,h3,h4,h5,strong,b').each((_,el)=>{if(out)return;const h=cleanText($(el).text());if(!re.test(h))return;const parts=[];let n=$(el).next();let guard=0;while(n.length&&guard++<20){if(/^H[1-5]$/i.test(n[0]?.tagName||''))break;const t=blockText($,n);if(t)parts.push(t);n=n.next();} if(parts.length)out=normalizeBlockText(parts.join('\n'));}); return out;
}
function rootAfter(root,label,stops=[]){const esc=label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');const stop=stops.map(s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|');const m=root.match(new RegExp(`${esc}\\s*:?\\s*(.+?)${stop?`(?=${stop})`:'$'}`,'i'));return cleanText(m?.[1]||'');}

function labeledValue(root, labels, stops = []) {
  for (const label of labels) {
    const v = rootAfter(root, label, stops);
    if (v) return v;
  }
  return null;
}
function numberFromLabel(root, labels, stops = []) {
  const v=labeledValue(root,labels,stops); if(!v) return null;
  const m=v.replace(/,/g,'').match(/(-?\d+(?:\.\d+)?)/); return m?Number(m[1]):null;
}


export function looksLikeErrorPage(html){
  const $=load(html);
  $('script,style,noscript').remove(); // framework state (e.g. "forbidden":"$undefined") is not page text
  const text=cleanText($.root().text()), title=cleanText($('title').first().text());
  const signal=/Listing\s*#\s*\d+/i.test(text)||/\/listing\/\d+/i.test(html)||/Browse Government Surplus Auctions/i.test(text);
  // Real listing pages carry these labels. Error words ("maintenance", "forbidden"...) are common inside item descriptions
  // (e.g. "maintenance records"), so they only count when the page has no listing content. A title match always counts.
  const listingContent=/Listing\s*#\s*\d+|Current (?:Price|highest bid|Bid)|Starting Bid|Item Description|Bid History|Payment Details|Bid\(s\)\s*:/i.test(text);
  const errorWords=/access denied|request blocked|temporarily unavailable|service unavailable|forbidden|maintenance|site unavailable|system error|unexpected error/i;
  if(errorWords.test(title))return true;
  if(errorWords.test(text)&&!listingContent)return true;
  if(/captcha|verify you are human|security check|challenge/i.test(text)&&!signal)return true;
  if(/sign in|log in|login/i.test(title)&&!signal)return true;
  return !text&&!signal;
}

export function parseDetailPage(html,url,observedAt=new Date().toISOString()){
  const $=load(html);
  $('script,style,noscript').remove(); // inline JS must not leak into text fields
  const identity=parseAuctionIdentity(url);
  if(!identity)throw new Error('MUNICIBID_DETAIL_ID_MISSING');
  // Related listings must not supply economics, descriptions, or media.
  $('h1,h2,h3,h4').each((_, el) => { if (/^Related Auctions/i.test(cleanText($(el).text()))) { $(el).nextAll().remove(); $(el).remove(); } });
  const root=cleanText(blockText($,$.root()));
  const heading=cleanText($('h1').first().text()); if(!heading)throw new Error('MUNICIBID_DETAIL_TITLE_MISSING');
  const listingId=cleanText(root.match(/Listing\s*#\s*(\d+)/i)?.[1]||identity.listingId);
  const headerMatch=root.match(new RegExp(`Listing\\s*#\\s*${listingId}\\s+(.+?)(?=Current highest bid|Watch|Image:)`,'i'));
  const header=cleanText(headerMatch?.[1]||'');
  const location=cleanText($('.detail-meta__loc').first().text()).replace(/\s+US$/i,'') || cleanText(header.match(/(.+?,\s*[A-Z]{2}\s+US)/i)?.[1]||'').replace(/\s+US$/i,'')||null;
  const links=$('a[href]').toArray().map(el=>({t:cleanText($(el).text()),h:$(el).attr('href')}));
  let seller=cleanText($('.detail-meta__seller').first().text()) || links.find(x=>x.t&&x.t!=='Follow'&&x.h&&/browse\?seller=|[?&]seller=/i.test(x.h))?.t||null;
  if(!seller&&header&&location){
    seller=cleanText(header.replace(new RegExp(location.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\s*US?','i'),'')).replace(/Follow$/i,'').trim()||null;
  }
  const evidence=detailEvidence($,html,listingId);
  const sourceRecord=collectSourceRecord(html);
  if (!sourceRecord.full_description) {
    for (const key of ['description','itemDescription','longDescription','descriptionHtml']) {
      if (typeof evidence.payload?.[key] === 'string' && evidence.payload[key].trim()) { sourceRecord.full_description=evidence.payload[key]; break; }
    }
  }
  const payloadCurrentPrice=evidence.payload?.currentPrice!=null&&Number.isFinite(Number(evidence.payload.currentPrice))?Number(evidence.payload.currentPrice):null;
  const currentPrice=payloadCurrentPrice ?? money(root.match(/Current Price\s*:?\s*\$\s*[\d,.]+/i)?.[0]||root.match(/Current (?:highest )?bid\s*:?\s*\$\s*[\d,.]+/i)?.[0]);
  const startingPrice=money(root.match(/Starting Bid\s*:?\s*\$\s*[\d,.]+/i)?.[0]);
  const payloadBidCount=evidence.payload?.bidCount!=null&&Number.isFinite(Number(evidence.payload.bidCount))?Number(evidence.payload.bidCount):null;
  const bidCount=payloadBidCount ?? integer(root.match(/Bid History\s*\d+\s*Bid/i)?.[0]||root.match(/(?:Bid\(s\)|Bids|Bid Count)\s*:\s*\d+/i)?.[0]);
  // Accept only a positive, explicitly labeled buy-now amount; policy text mentioning a $0 cap is not a price.
  const buyNowMatch=root.match(/(?:Buy Now|Buy It Now)\s*(?:Price)?\s*:?\s*\$\s*([\d,]+(?:\.\d{2})?)/i);
  const buyNowPrice=buyNowMatch ? Number(buyNowMatch[1].replace(/,/g,'')) : null;
  const resolvedPrice=buyNowPrice>0 && currentPrice==null && !(bidCount>0) ? buyNowPrice : (bidCount===0 ? (startingPrice ?? currentPrice) : (currentPrice ?? startingPrice));
  const priceType=buyNowPrice>0 && resolvedPrice===buyNowPrice && currentPrice==null ? 'buy_now' : (bidCount===0 ? 'starting_bid' : 'current_bid');
  const feePctRaw=root.match(/Buyer.?s (?:Fee|Premium)\s*:?\s*(\d+(?:\.\d+)?)\s*%/i)?.[1]; const feePct=feePctRaw?Number(feePctRaw):null;
  const buyersPremium=currentPrice!=null&&feePct!=null?Math.round(currentPrice*(feePct/100)*100)/100:null;
  let reserveStatus=null,reserveMet=null;
  if(/No Reserve/i.test(root)){reserveStatus='NO_RESERVE';reserveMet=true;} else if(/Reserve (?:Price )?Not Met|Reserve not met/i.test(root)){reserveStatus='RESERVE_NOT_MET';reserveMet=false;} else if(/Reserve (?:Price )?Met|Reserve met/i.test(root)){reserveStatus='RESERVE_MET';reserveMet=true;}
  const startRaw=cleanText(root.match(/Start Date\s+(.+?)(?=End Date|Bid History)/i)?.[1]||'');
  const endRaw=cleanText(root.match(/End Date\s+(.+?)(?=Bid History|High Bidder|Watchers|Page Views|Payment Details)/i)?.[1]||root.match(/This auction ends in\s+(\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}:\d{2}\s*(?:AM|PM))/i)?.[1]||'');
  const auctionStartTime=evidence.start || parseMunicibidDate(startRaw); let auctionEndTime=parseMunicibidDate(endRaw);
  // The visible page has no end time (the countdown is filled in by the browser); the embedded payload has endsAtUtc.
  if(!auctionEndTime){ try{ const pl=findPayloadListing(html,listingId); if(pl?.endsAtUtc) auctionEndTime=toIsoUtc(pl.endsAtUtc); }catch{} }
  let description=sectionByHeading($,/^Item Description$/i)||rootAfter(root,'Item Description',['Seller’s Terms & Conditions','Seller\'s Terms & Conditions','Additional Information on this Auction','Questions & Answers']);
  let condition=evidence.condition;
  const payment=sectionByHeading($,/^Payment Details$/i)||rootAfter(root,'Payment Details',['Item Description','Seller’s Terms & Conditions','Additional Information on this Auction']);
  const terms=sectionByHeading($,/Seller.?s Terms & Conditions/i)||rootAfter(root,"Seller's Terms & Conditions",['Additional Information on this Auction','Questions & Answers']);
  const logistics=extractLogisticsSignals(root);
  if ($('.detail-meta').length) {
    logistics.pickup_location=publishedValue($,['Pickup Location Details']);
    logistics.inspection_details=publishedValue($,['In person item inspection information']);
    logistics.inspection_available=logistics.inspection_details ? true : null;
  }
  // Only a published numeric shipping charge is a cost. 'Shipping available' is not a quote.
  const shippingPriceText=root.match(/(?:Shipping (?:Cost|Fee|Price)|Delivery (?:Cost|Fee))\s*:?\s*\$\s*[\d,.]+/i)?.[0];
  const estimatedShipping=evidence.shippingCost;
  const images=[];const seenImg=new Set();$('img[src],a[href]').each((_,el)=>{const raw=$(el).attr('src')||$(el).attr('href');if(!raw)return;const abs=absolute(raw,url);if(!abs||seenImg.has(abs))return;if(!/storagemunicibidpro\.blob\.core\.windows\.net/i.test(abs))return;seenImg.add(abs);images.push(abs);});
  const customId=publishedValue($,['Custom ID']) || cleanText(root.match(/Custom ID\s+(.+?)(?=Will Item results|Will you ship|In person item inspection|Pickup Location Details|Questions & Answers|Condition:|$)/i)?.[1]||'')||null;
  const extension=root.match(/May be extended by\s*(\d+)\s*minutes?/i); const extensionMinutes=extension?Number(extension[1]):null;
  // Description: drop the map / "Related Auctions" boilerplate; if nothing real is left, try the embedded payload; else null (never the title).
  description=cleanMunicibidDescription(description);
  if(!description) description=cleanMunicibidDescription(descriptionFromPayload($,evidence.payload));
  description=description||'';
  const product = productFields($, description, evidence.payload, heading);
  condition = condition || product.condition;
  const shipping = classifyShipping({ title: heading, description, terms,
    answer: publishedValue($, ['Will you ship this item']), cost: estimatedShipping,
    costText: evidence.shippingText ? `Shipping Cost: ${evidence.shippingText}` : shippingPriceText || '',
    extraText: (sourceRecord.shipping_options || []).join('\n') });
  const fullText=cleanText([description,terms,condition].filter(Boolean).join(' ')); const lower=fullText.toLowerCase();
  const modern = $('.detail-meta').length > 0;
  const value = labels => publishedValue($, labels);
  const numeric = labels => { const v=value(labels); return v && /^[\d,]+(?:\.\d+)?$/.test(v) ? Number(v.replace(/,/g,'')) : null; };
  const crumbs = $('.breadcrumb a[href*="/browse/c"]').map((_,el)=>cleanText($(el).text())).get();
  const categoryLink=links.find(x=>x.t&&x.h&&/\/browse\/c\d+/i.test(x.h));
  const category=modern ? (crumbs[0] || value(['Category'])) : (categoryLink?.t||labeledValue(root,['Category'],['Subcategory','Condition','Custom ID','Payment Details']));
  const subcategory=modern ? (crumbs[1] || value(['Subcategory'])) : (labeledValue(root,['Subcategory'],['Condition','Custom ID','Payment Details']));
  const year=modern ? (value(['Year'])) : (labeledValue(root,['Year'],['Make','Manufacturer','Model','VIN','Mileage','Hours','Serial Number','Custom ID']));
  const make=modern ? (value(['Make'])) : (labeledValue(root,['Make'],['Model','VIN','Mileage','Hours','Serial Number','Custom ID']));
  const manufacturer=modern ? (value(['Manufacturer','Brand']) || make) : (labeledValue(root,['Manufacturer'],['Model','Model Number','VIN','Serial Number','Custom ID'])||make);
  const model=modern ? (value(['Model'])) : (labeledValue(root,['Model'],['Model Number','VIN','Mileage','Hours','Serial Number','Custom ID']));
  const modelNumber=modern ? (value(['Model Number','Model #'])) : (labeledValue(root,['Model Number','Model #'],['VIN','Serial Number','Custom ID']));
  const vin=modern ? (value(['VIN','Vehicle Identification Number'])) : (labeledValue(root,['VIN','Vehicle Identification Number'],['Mileage','Odometer','Hours','Serial Number','Custom ID']));
  const mileage=modern ? (numeric(['Miles','Mileage','Odometer'])) : (numberFromLabel(root,['Mileage','Odometer'],['Hours','Serial Number','Custom ID']));
  const hours=modern ? (numeric(['Hours','Meter Hours','Engine Hours'])) : (numberFromLabel(root,['Hours','Meter Hours','Engine Hours'],['Serial Number','Custom ID']));
  const serialNumber=modern ? (value(['Serial Number','Serial #'])) : (labeledValue(root,['Serial Number','Serial #'],['Custom ID','Will Item results','Will you ship','In person item inspection']));
  const eligibility=detectEligibility(root);
  const gallery = $('.detail-gallery img').map((_,el)=>absolute($(el).attr('src'),url)).get();
  const fullGallery=ownGalleryImages(html,heading,gallery[0]);
  const media=splitMedia(fullGallery.length ? fullGallery : gallery.length ? gallery : images); // item's own _largesize photos only; PDFs go to documents
  const status=inferAuctionStatus(root,auctionEndTime,new Date(observedAt));
  return {
    source:'municibid',source_type:'government_auction',record_type:'auction_listing',external_id:identity.externalId,asset_id:listingId,auction_id:listingId,lot_number:customId,
    listing_url:identity.canonicalUrl,canonical_url:identity.canonicalUrl,title:heading,description:description||null,category:category||null,subcategory:subcategory||null,
    year:year||null,make:make||null,manufacturer:manufacturer||null,model:model||product.model||null,mpn:product.mpn,model_number:modelNumber||null,vin:vin||product.vin||null,mileage,hours,serial_number:serialNumber||product.serial_number||null,custom_id:customId,
    condition_source:product.condition_source,condition_evidence:condition||null,
    condition:condition||null,raw_condition:condition,condition_notes:condition,
    listing_type:'AUCTION',current_price:resolvedPrice,starting_price:startingPrice,minimum_bid:startingPrice,bid_increment:null,bid_count:bidCount,price_type:priceType,
    reserve_status:reserveStatus,reserve_met:reserveMet,buyers_premium:buyersPremium,buyers_premium_pct:feePct,buyers_premium_source:feePct!=null?'DERIVED_FROM_PUBLISHED_PERCENTAGE':null,buyers_premium_confidence:feePct!=null?0.99:null,
    tax_estimate:null,total_estimated_cost:null,pickup_location:logistics.pickup_location,
    ...shipping,
    location,seller_name:seller,seller_agency:seller,seller_type:'government_or_public_entity',auction_start_time:auctionStartTime,auction_start_time_source:evidence.startSource,auction_end_time:auctionEndTime,auction_status:status,time_remaining_seconds:timeRemainingSeconds(auctionEndTime,observedAt),auction_extension_possible:extensionMinutes!=null,
    inspection_available:logistics.inspection_available,inspection_details:logistics.inspection_details,payment_terms:payment||logistics.payment_terms,removal_deadline:null,removal_requirements:logistics.removal_requirements,
    quantity:null,unit_count:null,images:media.photos,documents:media.documents,currency:'USD',bid_deposit:null,
    known_damage:/damaged|damage|broken|non-functioning|nonfunctional/i.test(lower),missing_parts:/missing|parts may be obsolete/i.test(lower),mechanical_issue:/mechanical|engine|transmission|repair/i.test(lower),electrical_issue:/electrical|battery|wiring/i.test(lower),cosmetic_damage:/scratch|dent|rust|cosmetic/i.test(lower),not_tested:/not tested|untested|unknown working/i.test(lower),working_condition_unknown:/unknown|extent of repairs are unknown/i.test(lower),parts_only:/parts only/i.test(lower),salvage:/salvage|scrap/i.test(lower),
    scraped_at:observedAt,observed_at:observedAt,source_record:sourceRecord,source_meta:{transport:'municibid_html',listing_id:listingId,custom_id:customId,category:category||null,subcategory:subcategory||null,year:year||null,make:make||null,manufacturer:manufacturer||null,model:model||null,model_number:modelNumber||null,vin:vin||null,mileage,hours,serial_number:serialNumber||null,extension_minutes:extensionMinutes,payment_details:payment||null,seller_terms:terms||null,shipping_cost_source:estimatedShipping!=null?'published_listing_charge':null,auction_start_raw:evidence.rawStart},
    ...eligibility,
  };
}