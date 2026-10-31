import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizeRecord, validateRecord } from '../src/utils/normalize.js';
import { DedupeManager } from '../src/utils/dedupe.js';
import { buildSqlIngestCall } from '../src/utils/sqlExport.js';
import { stripVolatileObservationFields } from '../src/govdeals/fingerprint.js';
import { evaluateRunHealth } from '../src/govdeals/health.js';
import { buildRawRecord } from '../src/govdeals/apiParser.js';
import { parseRecheckIdentity } from '../src/govdeals/url.js';

const root=path.resolve('.');
const checks=[];
const ok=(name,pass,detail='')=>checks.push({name,pass,detail});

const raw={source:'govdeals',record_type:'auction_listing',external_id:'govdeals-782-41319',listing_url:'https://prod-seo.govdeals.com/en/asset/41319/782',title:'Phone',condition:'USED',current_price:250,currency:'USD',auction_start_time:'2026-10-01T12:00:00.000Z',auction_end_time:'2026-10-08T20:00:00.000Z',shipping_method:'shipping',source_record:{search:{assetId:41319},detail:{assetId:41319},bidbox:{bidCount:1}},location:'Fairfax, Virginia, USA',image_urls:[],attributes:{price_type:'current_bid',bid_count:1,auction_start_time_source:'govdeals_bidbox_api',trusted:{},mined:{}},source_meta:{transport:'govdeals_html'},scraped_at:'2026-10-07T20:00:00.000Z',observed_at:'2026-10-07T20:00:00.000Z'};
const n=normalizeRecord(raw,'govdeals');
ok('govdeals_normalizes_as_source',n.source==='govdeals',n.source);
ok('govdeals_infers_auction_listing',n.record_type==='auction_listing',n.record_type);
ok('unified_record_validates',validateRecord(n).valid,JSON.stringify(validateRecord(n).errors||[]));

const pr=normalizeRecord({...raw,source:'propertyroom',external_id:'propertyroom-1',listing_url:'https://www.propertyroom.com/x'},'propertyroom');
ok('propertyroom_source_regression',pr.source==='propertyroom' && pr.record_type==='auction_listing',`${pr.source}/${pr.record_type}`);

const a={...raw,source_meta:{transport:'govdeals_html',time_remaining_seconds:14400}};
const b={...raw,source_meta:{transport:'govdeals_html',time_remaining_seconds:12600}};
stripVolatileObservationFields(a); stripVolatileObservationFields(b);
ok('countdown_excluded_from_hash',normalizeRecord(a,'govdeals').content_hash===normalizeRecord(b,'govdeals').content_hash);
const c={...b,auction_end_time:'2026-10-08T20:15:00.000Z'};
ok('end_time_mutation_changes_hash',normalizeRecord(a,'govdeals').content_hash!==normalizeRecord(c,'govdeals').content_hash);

const kv={value:null,async getValue(){return this.value},async setValue(_k,v){this.value=v}};
const opts={enableFingerprintRefresh:true,enableStaleRefresh:false,log:{info(){},warning(){}}};
const d1=new DedupeManager(kv,opts);
await d1.initialize();
const first=await d1.shouldProcess('govdeals-782-41319','aaa');
await d1.markSeenWithFingerprint('govdeals-782-41319','aaa',{price:250});
await d1.persist();
const d2=new DedupeManager(kv,opts);
await d2.initialize();
const same=await d2.shouldProcess('govdeals-782-41319','aaa');
const d3=new DedupeManager(kv,opts);
await d3.initialize();
const changed=await d3.shouldProcess('govdeals-782-41319','bbb');
ok('dedupe_new_processes',first===true);
ok('dedupe_same_skips',same===false);
ok('dedupe_changed_reprocesses',changed===true);
ok('dedupe_source_is_govdeals',kv.value?.entries?.['govdeals-782-41319']?.source==='govdeals');

const sql=buildSqlIngestCall({...raw,source:'govdeals'});
ok('sql_export_source_govdeals',sql.includes("'govdeals'"));
const sqlPr=buildSqlIngestCall({...raw,source:'propertyroom',external_id:'propertyroom-1'});
ok('sql_export_propertyroom_regression',sqlPr.includes("'propertyroom'"));

const healthy={schema_drift_events:0,records_discovered:100,detail_pages_attempted:100,detail_pages_parsed:100,records_saved:100,filtered_records:0,duplicates_skipped:0,completeness_total:100,completeness:{external_id:100,title:100,listing_url:100,current_price:100,auction_end_time:100,location:100,seller_name:100,condition:100}};
ok('healthy_run_health_pass',evaluateRunHealth(healthy).status==='PASS');
const broken=structuredClone(healthy); broken.detail_pages_parsed=0; broken.records_saved=0;
ok('parser_collapse_fails',evaluateRunHealth(broken).status==='FAIL');
const partial=structuredClone(healthy); partial.records_discovered=20; partial.records_queued=20; partial.records_saved=19; partial.records_rejected=1; partial.completeness_total=19; for(const k of Object.keys(partial.completeness)) partial.completeness[k]=19;
const partialHealth=evaluateRunHealth(partial);
ok('single_rejected_lot_degrades_without_failing',partialHealth.status==='DEGRADED' && partialHealth.warnings.includes('records_rejected:1'));
const noUsable=structuredClone(healthy); noUsable.records_queued=10; noUsable.records_saved=0; noUsable.records_rejected=10; noUsable.completeness_total=0;
ok('zero_usable_records_fails',evaluateRunHealth(noUsable).status==='FAIL');
const freeShip=buildRawRecord({row:{assetId:991,accountId:782,assetShortDescription:'Coin lot — FREE SHIPPING (USA ONLY)',currentBid:5,bidCount:1,assetAuctionEndDateUtc:'2026-10-20T12:00:00Z',willShip:false},detail:{assetId:991,assetLongDesc:'See title for delivery terms.',willShip:false},bidbox:{bidCount:1}});
ok('published_free_shipping_is_zero_cost_and_shippable',freeShip.estimated_shipping===0 && freeShip.shipping_method==='free_shipping' && !!freeShip.attributes.shipping_evidence);
const noFreeShip=buildRawRecord({row:{assetId:992,accountId:782,assetShortDescription:'No free shipping; pickup only',currentBid:5,bidCount:1,assetAuctionEndDateUtc:'2026-10-20T12:00:00Z',willShip:false},detail:{assetId:992,assetLongDesc:'Pickup only.',willShip:false},bidbox:{bidCount:1}});
ok('negative_free_shipping_is_not_zero_cost',noFreeShip.estimated_shipping===null && noFreeShip.shipping_method==='pickup_only');
const quoteShip=buildRawRecord({row:{assetId:993,accountId:782,assetShortDescription:'Equipment',currentBid:5,bidCount:1,assetAuctionEndDateUtc:'2026-10-20T12:00:00Z',willShip:false},detail:{assetId:993,removalInstructions:'Shipping is available; contact the seller for a quote.',willShip:false},bidbox:{bidCount:1}});
ok('shipping_quote_from_positive_listing_text_overrides_false_flag',quoteShip.shipping_method==='shipping_quote' && quoteShip.estimated_shipping===null && /shipping is available/i.test(quoteShip.attributes.shipping_evidence||''));
const paidShip=buildRawRecord({row:{assetId:994,accountId:782,assetShortDescription:'Equipment',currentBid:5,bidCount:1,assetAuctionEndDateUtc:'2026-10-20T12:00:00Z',willShip:false},detail:{assetId:994,removalInstructions:'Shipping cost is $45.00.',willShip:false},bidbox:{bidCount:1}});
ok('shipping_price_from_listing_text_overrides_false_flag',paidShip.shipping_method==='shipping' && paidShip.estimated_shipping===45 && /\$45/.test(paidShip.attributes.shipping_evidence||''));
const mpn=buildRawRecord({row:{assetId:995,accountId:782,assetShortDescription:'Equipment',currentBid:5,bidCount:1,assetAuctionEndDateUtc:'2026-10-20T12:00:00Z'},detail:{assetId:995,vinserial:'SERIAL-123',assetAttributeGroups:[{attributes:[{attributeName:'Model',attributeValue:'S60'}]}]},bidbox:{bidCount:1}});
ok('coded_model_is_also_mpn',mpn.model==='S60'&&mpn.mpn==='S60'&&mpn.serial_number==='SERIAL-123');
const explicitMpn=buildRawRecord({row:{assetId:996,accountId:782,assetShortDescription:'Equipment',currentBid:5,bidCount:1,assetAuctionEndDateUtc:'2026-10-20T12:00:00Z'},detail:{assetId:996,vinserial:'SER-996',assetAttributeGroups:[{attributes:[{attributeName:'Catalog Number',attributeValue:'CAT-996'}]}]},bidbox:{bidCount:1}});
ok('explicit_catalog_number_maps_to_mpn_not_serial',explicitMpn.mpn==='CAT-996'&&explicitMpn.attributes.serial_number==='SER-996');
ok('recheck_accepts_govdeals_ids_and_urls',parseRecheckIdentity('govdeals-28251-795')?.externalId==='govdeals-28251-795'&&parseRecheckIdentity('795/28251')?.externalId==='govdeals-28251-795'&&parseRecheckIdentity('https://www.govdeals.com/en/asset/795/28251')?.externalId==='govdeals-28251-795');
const recheckSource=fs.readFileSync(path.join(root,'src/extractors/govdeals.js'),'utf8');
ok('recheck_targets_only_and_bypasses_unchanged_skip',/if \(recheckLots\.length\)\s*\{\s*await recheckSpecifiedLots/.test(recheckSource)&&/forceRecheck \|\| await dedupeManager\.shouldProcess/.test(recheckSource)&&/forceRecheck: true/.test(recheckSource));
const normalizedShippingMethods=['shipping','shipping_quote','free_shipping','pickup_only'].every(method=>validateRecord(normalizeRecord({...raw,shipping_method:method},'govdeals')).valid);
ok('shipping_method_accepts_four_client_values',normalizedShippingMethods);

const source=fs.readFileSync(path.join(root,'src/extractors/govdeals.js'),'utf8');
const write=source.indexOf('await dataset.pushData(record)');
const commit=source.indexOf('await dedupeManager.markSeenWithFingerprint(record.external_id');
ok('dataset_write_precedes_dedupe_commit',write>=0 && commit>write,`${write}/${commit}`);
ok('no_price_only_early_skip_call',!/shouldEarlySkip\s*\(/.test(source));
ok('proxy_fail_closed',/GOVDEALS_PROXY_CONFIGURATION_FAILED/.test(source) && !/running without proxy/.test(source));
const main=fs.readFileSync(path.join(root,'main.js'),'utf8');
ok('crawl_failure_rethrown',/GovDeals crawl failed[\s\S]*throw err;/.test(main));
ok('required_webhook_fail_closed',/REQUIRED_WEBHOOK_DELIVERY_FAILED/.test(main));

const allPass=checks.every(c=>c.pass);
const report={generated_at:new Date().toISOString(),status:allPass?'PASS':'FAIL',checks};
fs.writeFileSync(path.join(root,'release','STATIC_CERTIFICATION_REPORT.json'),JSON.stringify(report,null,2)+'\n');
for(const c of checks) console.log(`${c.pass?'PASS':'FAIL'} ${c.name}${c.detail?` :: ${c.detail}`:''}`);
if(!allPass) process.exit(1);