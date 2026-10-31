> **V1.4 NOTE:** the GovDeals transport is now the maestro JSON API (search, detail, bid box). The HTML/Playwright descriptions below are legacy. See release/V1_4_API_TRANSPORT_NOTES.md.

# TCDS GovDeals Acquisition Intelligence Actor — V1.4.6

PropertyRoom-reference-aligned Apify Actor for public GovDeals auction acquisition data.

## Golden baseline rule

The working PropertyRoom Actor remains the architectural baseline. This package preserves its Apify runtime, orchestration pattern, eBay integration, export framework, webhook framework, logging framework, dependency set, Docker runtime, and persistent KV lifecycle.

GovDeals-specific behavior is isolated to:

- `src/extractors/govdeals.js`
- `src/govdeals/*`
- GovDeals Actor metadata / dataset views
- GovDeals input defaults and source identity
- minimal shared compatibility additions required for the unified schema to recognize `govdeals`

The only shared runtime compatibility deltas are intentionally minimal:

1. `normalize.js`: recognize `govdeals` as an allowed auction source.
2. `dedupe.js`: recognize `govdeals-*` external IDs as GovDeals source state.
3. `sqlExport.js`: use `record.source` rather than hard-coding `propertyroom`; PropertyRoom records still export as `propertyroom`.

These deltas are covered by PropertyRoom regression tests.

## Runtime path

```text
Apify Actor Input
  -> GovDeals public search/start URL
  -> CheerioCrawler public HTTP/HTML transport
  -> GovDeals search discovery
  -> GovDeals detail extraction
  -> shared TCDS normalize.js
  -> shared TCDS validation
  -> persistent fingerprint-aware dedupe
  -> Apify Dataset (authoritative Actor output)
  -> optional webhook / CSV / Google Sheets / SQL
  -> optional eBay enrichment
```

The Actor is a source adapter only. It does not issue BUY authorization and does not write directly to Listings.

## GovDeals identity

GovDeals URLs use both asset and seller/account identifiers. External identity is therefore collision-safe:

```text
/en/asset/{assetId}/{sellerAccountId}
-> govdeals-{sellerAccountId}-{assetId}
```

Example:

```text
/en/asset/41319/782
-> govdeals-782-41319
```

## Extracted fields

The Actor attempts to capture:

- asset/seller identity and lot number
- title and description
- condition and trusted attributes
- current/high bid, bid count, bid increment
- reserve status
- seller and location
- closing time and auction status
- logistics, pickup, inspection, payment and removal terms
- bidder/account restriction observations
- images
- sold amount, tax and total price when published
- buyer premium only when safely derivable, with explicit provenance
- `current_price` uses the current bid, or the published opening price for a zero-bid lot, with a published buy-now price as fallback; `attributes.price_type` and `attributes.bid_count` identify the selected value
- `shipping_method` is `free_shipping`, `shipping`, `shipping_quote`, or `pickup_only`, classified from shipping/removal text together with API flags; negative wording wins conflicts, and the matched sentence is retained in `attributes.shipping_evidence`
- `estimated_shipping` is zero for explicitly free shipping, otherwise the cheapest published amount; it remains empty when the site offers shipping but publishes no price
- MPN is extracted from part, model, or catalog identifiers; a coded Model value is also used as MPN, while serial numbers and VINs remain separate attributes
- `recheckLots` accepts GovDeals lot URLs or IDs and fetches those exact lots on every run, bypassing freshness and dedupe skips
- `auction_start_time` is ISO UTC when observed. If the API omits it, the lot is marked `incomplete` with `not_observed_in_api` until a source-page check confirms whether the site truly omits it; only confirmed omissions use `not_published_by_site`.
- `source_record` contains the untouched API search row, detail response and bid-box response for the lot
- a lot is not saved if any of those three source responses is unavailable

Unknown values remain `null`/empty according to the shared schema; unknown shipping is never silently converted to zero.

## Auction mutation and dedupe

GovDeals does not use PropertyRoom's price-only early skip. Every queued GovDeals detail record is re-observed so a closing-time extension cannot be hidden by an unchanged price.

The durable content hash includes authoritative auction state such as `auction_end_time`; observation-only countdown fields are stripped before normalization. Therefore:

- unchanged bid + unchanged end time -> may dedupe as unchanged
- changed bid -> new fingerprint
- changed end time -> new fingerprint
- lower `time_remaining_seconds` alone -> no false content change

Dataset persistence happens before durable dedupe commit.

## Fail-closed health gates

A run fails when source behavior indicates systemic extraction failure, including:

- schema/error page detection
- discovered assets but zero detail parses
- detail parse success below 95%
- critical field completeness below governed thresholds
- many discovered records but no usable output without dedupe/filter evidence
- required webhook delivery failure
- configured proxy setup failure

Critical completeness thresholds:

```text
external_id       100%
title             100%
listing_url       100%
current_price     >=99%
auction_end_time  >=99%
location          >=99%
seller_name       >=98%
condition         >=98%
```

## Account restrictions

The Actor may observe and record GovDeals bidder/account restriction messages. It does not bypass authentication, CAPTCHA, bidder restrictions, geographic restrictions, rate limits, or other access controls.

## Apify input

Use `INPUT_SCHEMA.json` in the Actor console. Recommended first QA canary:

```json
{
  "sourceName": "govdeals",
  "keywords": ["iphone"],
  "maxPages": 1,
  "maxItemsPerRun": 10,
  "maxConcurrency": 2,
  "proxyEnabled": false,
  "ebayEnabled": false,
  "csvExportEnabled": false,
  "sqlExportEnabled": false,
  "webhookDeliveryRequired": false,
  "debug": true
}
```

Only `govdeals.com` and subdomains are accepted as start URL hosts.

## Tests

Certification tests live under `certification-tests/` so they are not excluded by the inherited PropertyRoom `.gitignore`.

Run:

```bash
npm ci
npm run lint
npm test
npm run check
node scripts/certify-static.mjs
```

Tests cover:

- GovDeals source normalization
- PropertyRoom normalization regression
- collision-safe source identity
- eligibility lock detection
- parser fixtures
- dedupe mutation behavior across runs
- countdown-independent content hashes
- authoritative end-time mutation hashes
- health-gate failure behavior
- dataset-before-dedupe ordering
- proxy fail-closed behavior
- required webhook behavior
- SQL source correctness

## Final live certification

Source-level/static certification is recorded under `release/`.

Final production freeze requires execution of this exact artifact inside an Apify QA Actor and evidence for:

1. successful build and Actor boot;
2. live GovDeals canary;
3. at least 10 source-vs-dataset comparisons;
4. second-run bid mutation handling;
5. second-run end-time extension handling;
6. unchanged-record dedupe behavior;
7. fail-closed behavior under controlled error conditions.

Do not promote a differently modified artifact using this package's release hashes.