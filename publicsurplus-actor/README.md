# TCDS Public Surplus Acquisition Intelligence Actor V1.2

**Release candidate:** `TCDS_PUBLICSURPLUS_ACQUISITION_INTELLIGENCE_V1_2_PROPERTYROOM_ALIGNED_EXHAUSTIVE_ZERO_LOSS_GREEN_TIER1_FINAL_FREEZE_CANDIDATE`

This Actor is a narrow Public Surplus source adapter built inside the certified PropertyRoom acquisition framework. It preserves the PropertyRoom Apify lifecycle, Dataset, normalization, dedupe, webhook, export, and eBay patterns while adding Public Surplus-specific exhaustive discovery, mutable-auction refresh, zero-loss reconciliation, source-request DLQ, checkpoint/restart, circuit breaking, corruption detection, and single-writer state protection.

## Authority boundary

The Actor is an acquisition source adapter only. It writes governed source observations to the Apify Dataset. It does not own Listings, BUY/NO-BUY authority, capital allocation, checkout, payment, PQP, CAX, warehouse authority, or final ARB business decisions.

## PropertyRoom alignment

The following framework files remain byte-identical to the certified PropertyRoom baseline through the V1.1 alignment chain:

- `.actor/Dockerfile`
- `.dockerignore`
- `.gitignore`
- `src/extractors/ebay.js`
- `src/utils/export.js`
- `src/utils/logging.js`
- `src/utils/webhook.js`
- `src/utils/webhookManager.js`

The existing minimal shared compatibility extensions remain unchanged from V1.1:

- `normalize.js`: recognizes `publicsurplus` under existing auction-listing semantics.
- `dedupe.js`: recognizes `publicsurplus-*` identities.
- `sqlExport.js`: exports `record.source`, preserving PropertyRoom behavior.

V1.2 hardening is isolated to Public Surplus source/orchestration configuration, tests, and release evidence.

## Exhaustive discovery

Production default: `discoveryMode=EXHAUSTIVE`.

Governed discovery unions:

1. global active search
2. Public Surplus home/region directory
3. new auctions
4. closing-soon auctions
5. discovered region browse/search partitions
6. discovered agency browse/search partitions
7. pagination for each partition
8. approved operator start URLs and keyword searches

Navigation discovery handles anchors, URL-backed `<option>` values, forms, and pagination links. All lots converge on durable identity `publicsurplus-{auctionId}`.

## Mutable state

Public Surplus does not use PropertyRoom's price-only early skip. Material changes such as price, authoritative auction end time, listing type, condition, description, seller, premium, or pickup/shipping terms can re-enter processing. `time_remaining_seconds` is observation-only and excluded from durable content identity.

## Durable recovery and source DLQ

V1.2 state keys:

- `PUBLICSURPLUS_RECOVERY_STATE_V2`
- `PUBLICSURPLUS_FAILED_REQUEST_DLQ_V2`
- `PUBLICSURPLUS_RECONCILIATION_V2`
- `PUBLICSURPLUS_RUN_COMPLETION_MANIFEST`
- `PUBLICSURPLUS_ACTIVE_RUN_LEASE_V1`

Malformed recovery or DLQ data is preserved under forensic keys and rejected rather than silently replaced with empty state.

Startup order is governed as:

`load state -> load DLQ -> replay due failures -> resume pending detail/index -> fresh discovery`

Automatic retries are handled by Crawlee. 408/5xx use bounded retries; 429 honors `Retry-After` seconds or HTTP-date and uses bounded backoff; 401/403 fail closed. Exhausted retryable requests are retained in the durable source-request DLQ.

## Single-writer protection

By default, `singleWriterLeaseEnabled=true`. An active KV lease prevents two exhaustive runs from concurrently mutating the same Public Surplus recovery/dedupe state. Stale leases expire according to `runLeaseTtlMinutes`.

## Run states

The source health model uses:

- `PASS`
- `DEGRADED`
- `INCOMPLETE`
- `FAIL`

Capacity/runtime truncation, retry-pending work, unfinished discovery partitions, or queued work produce `INCOMPLETE`, not PASS. Schema drift, corrupt state, systemic parser/normalization/validation failure, access failure, circuit opening, unresolvable reconciliation gaps, or required-webhook failure produce FAIL.

## Reconciliation

Every discovered lot must receive a governed disposition. Exhaustive completion enforces:

`DISCOVERED_UNIQUE = ACCOUNTED + UNACCOUNTED`

Final Green Tier certification requires zero unaccounted lots and zero pending/retry work.

## Dataset ordering

`parse -> normalize -> validate -> dedupe decision -> capacity check -> Dataset write -> webhook buffer -> dedupe commit -> reconciliation disposition`

Dedupe is never committed before a successful Dataset write.

## Fixed-price listings

Public Surplus fixed-price items are explicitly classified with `listing_type=FIXED_PRICE`; auction-only bid fields remain null when not applicable. The unified TCDS `record_type` remains compatible with the existing acquisition schema.

## Proxy governance

Direct HTTP is the default, matching the PropertyRoom transport posture. If `proxyEnabled=true`, proxy configuration fails closed unless the operator explicitly sets `proxyFallbackToDirect=true`.

## Certification

The package contains automated certification tests, a dependency-free static certification script, release manifest, fixture/test hashes, reference-alignment report, adversarial fault matrix, and Apify final-certification runbook.

Source/static controls pass in this build environment. Full `npm ci`, Jest/ESLint, Apify boot, exhaustive live coverage, interruption/resume, live DLQ replay, and live source-accuracy gates remain `NOT VERIFIED` until executed on the exact immutable artifact in Apify QA.## Buyer-mandated Public Surplus fields (implemented in 1.3.4)

For each saved Public Surplus lot, the actor classifies the published price in `attributes.price_type` as `current_bid`, `starting_bid`, or `buy_now`. A zero-bid auction uses the published opening amount (Public Surplus labels it “Minimum bid” on that page); if no price is published, the lot is rejected instead of emitting a fabricated zero or null. `attributes.bid_count` is preserved when shown.

Every accepted lot has `shipping_method` set to `shipping` or `pickup_only`. The parser records the cheapest displayed shipping option, or zero only for explicitly free shipping; it leaves the amount empty when no real cost is published. Every accepted lot must also have an ISO UTC auction-end timestamp. A missing published start time is represented by an empty `auction_start_time` and `attributes.auction_start_time_source: not_published_by_site`. Times without a published timezone are not guessed; they fail validation for manual review.

Each lot carries a `source_record` object with the original fetched HTML, extracted label/value pairs, full description, captured shipping options, and page variables that may contain price or date data. Export profiles include the source record as JSON. Source evidence is intentionally retained untouched even when normalized descriptions redact contact text.

Candidate 1.3.4 is an offline code candidate. Apify build, run, dataset output, and intake integration still require live verification before QA approval.

## v1.3.2 authorization-response handling

The 2026-10-19 two-lot targeted retry received HTTP 401 for both lots and saved no records. This release stops session-rotation retries for authorization statuses, records each denied target, and marks targeted runs with authorization or permanent request failures as `FAIL`. Apify can then report a failed run instead of green process completion with an empty dataset. This is transparent failure handling; it does not bypass site access controls. See `release/QA_FINDINGS.md` before rerunning.

## v1.3.2 compatibility correction

The first v1.3.1 Apify run failed before crawling: the locked Crawlee 3.16 runtime rejected the `blockedStatusCodes` option. v1.3.2 removes it and uses the supported request error hook to stop retries for HTTP 401/403. Apify must still verify the runtime behavior.


## v1.3.3 shipping correction

Explicit free shipping now sets stimated_shipping to zero even when unrelated page text includes a payment limit such as $4,000. The Public Surplus run on 2026-10-19 exposed this false shipping amount on lot 4100753; the listing description says shipping is free and the $4,000 value belongs to its payment terms. Live Apify output and downstream intake still require a rerun before QA approval.

## v1.3.4 complete table view

The Public Surplus Listings dataset view now exposes the complete normalized lot fields, including description, condition source text, bid and opening prices, buyer premium, images, seller/location, auction timing, logistics, eligibility, and lineage. The original page evidence remains available in source_record as the complete HTML, label/value pairs, description, shipping options, and page variables. uction_start_time_source is also a top-level table column for easier review. Offline certification does not replace an Apify build/run and live intake check.