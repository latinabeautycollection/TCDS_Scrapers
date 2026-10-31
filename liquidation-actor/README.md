# TCDS Liquidation.com Acquisition Intelligence Actor

**Version:** 1.1.8  
**Build:** release-1.1.8  
**Status:** PropertyRoom-aligned candidate with required bid, shipping, auction-time, and source-record fields; pending live Apify certification

## Purpose

This Apify Actor discovers active Liquidation.com auction lots, extracts governed lot economics and logistics, preserves manifest provenance, normalizes records into `arb.unified_listing.v1`, performs persistent mutation-aware dedupe, supports source-request recovery/DLQ, and optionally enriches with eBay comps and downstream exports.

It is an **acquisition source adapter only**. It does not write directly to Listings, authorize BUY/NO-BUY, allocate capital, or execute checkout.

## Certified framework alignment

The package preserves the PropertyRoom framework pattern:

`Actor Input -> Apify lifecycle -> persistent KV -> CheerioCrawler -> source adapter -> shared normalization/validation -> Dataset -> shared webhook/export -> persistent dedupe -> recovery/reconciliation`.

The PropertyRoom Dockerfile, eBay extractor, export utility, logger, webhook utility, and legacy webhook manager remain byte-identical. Shared `normalize.js`, `dedupe.js`, and `sqlExport.js` receive only the minimum source-neutral/source-recognition extensions needed for Liquidation.com and nullable sealed-bid prices.

## Liquidation.com identity

Stable identity is the public Auction Id / `auction/view?id=` value.

Example:

`https://www.liquidation.com/auction/view?id=21443326` -> `liquidation-21443326`

The Actor never derives primary identity from title, seller, price, location, or closing time.

## Discovery

Production default is `EXHAUSTIVE` and uses the public active auction-search surface plus overlapping sort/coverage seeds and the category index. It follows live category, seller, location, warehouse, condition, shipping, auction-type and pagination links discovered from Liquidation.com itself. `_page=` pagination is governed and checkpointed.

`includeCompleted=false` by default so active acquisition inventory is not silently mixed with historical closed lots.

## Supported auction formats

- `STANDARD_AUCTION`
- `SEALED_BID`
- `MIXED_FORMAT`
- `FIXED_PRICE`
- `UNKNOWN`

Mixed format preserves both `SEALED_BID` and `BUY_NOW` as available purchase modes. The Actor does not manufacture `$0` values. When a site hides a sealed bid and publishes no buy-now price, the price remains unknown and the intake can keep that lot incomplete.

## Source fields

The source adapter attempts to capture:

- Auction Id and canonical URL
- title and description
- seller and fulfillment type
- location and country
- condition
- current/winning bid, or the published opening bid when there are no bids
- `attributes.price_type` (`current_bid`, `starting_bid`, or `buy_now`)
- bid count where observable
- cheapest published shipping cost and `shipping_method` (`shipping` or `pickup_only`)
- auction start and exact close time in UTC; unpublished starts carry `attributes.auction_start_time_source=not_published_by_site`
- the original lot page HTML, label/value pairs, full description, shipping options, price/date text, and relevant page scripts in `source_record`
- auction type / available purchase modes
- buyer's premium percentage
- quantity and quantity variance
- package/pallet counts
- total weight
- shipping terms and all published shipping options and fees
- payment/removal terms
- estimated retail / bid price per unit where published
- HTML manifest URL
- downloadable manifest URL
- seller performance observations where published

Unknown values remain null/UNKNOWN rather than being silently fabricated.

## Manifest governance

Liquidation.com commonly exposes a lot manifest. V1.0 captures manifest availability and authoritative manifest URLs in `source_meta` and `documents`. It does not invent line-item records inside the unified lot schema. A future manifest-line ingestion slice can consume these governed URLs without changing the lot identity contract.

## Auction mutation

Material changes such as price, closing time, condition, buyer premium, shipping terms, seller terms, description, auction type, and manifest provenance can change the durable content fingerprint. The runtime countdown is observation-only and does not create false mutations.

## Recovery / retry / DLQ

The Actor retains the hardened auction-source control plane:

- versioned persistent recovery state
- durable source-request DLQ distinct from webhook DLQ
- replay of due failures before fresh discovery
- 408/429/5xx retry policy
- `Retry-After` support
- 401 `AUTH_REQUIRED` fail closed
- 403 `ACCESS_RESTRICTED` fail closed
- source circuit breaker
- single-writer RequestQueue lock + KV fencing
- stale-owner verification
- Dataset write before dedupe commit
- PASS / DEGRADED / INCOMPLETE / FAIL health states
- zero-loss reconciliation

## Apify output

The Apify Dataset is the authoritative Actor output. Views include:

- `overview`
- `liquidation_listings`
- `ebay_comps`
- `arbitrage_candidates`
- `auction_logistics`
- `audit_trace`

## Certification

Static/source-level checks are included under `scripts/certify-static.mjs` and `certification-tests/`.

Final Green Tier 1 certification still requires the exact immutable artifact to pass in Apify QA:

1. clean `npm ci`
2. lint/test/check
3. Actor boot
4. 20-record live source comparison
5. exhaustive catalog and pagination run
6. Standard/Sealed/Mixed/Fixed Price samples
7. manifest provenance validation
8. price/end-time mutation test
9. interruption/resume
10. DLQ replay
11. 429/503/401/403 controlled fault tests
12. concurrent-writer rejection
13. zero-unaccounted reconciliation
14. PropertyRoom regression
15. final release-hash verification

Static success is not equivalent to live production certification.