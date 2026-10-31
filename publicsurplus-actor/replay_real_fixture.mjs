import fs from 'node:fs';
import {parseDetailPage} from './src/publicsurplus/parser.js';
import {load} from 'cheerio';
const html=fs.readFileSync('C:/Users/GRIMHUSTLER/Downloads/FIXTURE_html_detail_1.htm','utf8');
const r=parseDetailPage(html,'https://www.publicsurplus.com/sms/auction/view?auc=4094908','2026-10-18T17:02:00.000Z');
const $=load(html);
const candidates=$('img[src],img[data-src],a[href]').toArray().map(e=>({src:$(e).attr('data-src')||$(e).attr('src')||$(e).attr('href'),alt:$(e).attr('alt'),cls:$(e).attr('class')})).filter(x=>x.src&&/docviewer/i.test(x.src));
console.log(JSON.stringify({id:r.external_id,title:r.title,start:r.auction_start_time,current:r.current_price,bids:r.bid_count,minimum:r.minimum_bid,premium:r.buyers_premium_pct,condition:r.condition,brand:r.brand,model:r.model,pickup:r.pickup_location,images:r.image_urls,docviewerCandidates:candidates},null,2));