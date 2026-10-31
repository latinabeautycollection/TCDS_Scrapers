# Liquidation.com V1.1.8 Certification Report

**Artifact:** Liquidation.com acquisition actor with required lot fields and original source records

## Source-level result

- Static certification: **PASS (33/33)**
- JavaScript syntax: **PASS**
- JSON integrity and unique dataset view columns: **PASS**
- Field-rules unit checks: **PASS**
- Parser regression tests added for sealed minimum offers, lot-scoped prices and bid counts, shipping estimates, and shipping method. Jest execution is pending because Jest and Cheerio are unavailable in this workspace.
- PropertyRoom-family recovery/DLQ/circuit-breaker architecture: preserved

## V1.1.6 corrections

- Scope bid, price, shipping, condition, and lot-label extraction to the current lot panel so nearby listings cannot supply another lot's values.
- Read the visible minimum offer from Liquidation's `Enter $X or more` prompt and preserve it as `current_price` with `price_type: starting_bid` when no public current bid is exposed.
- Keep sealed-bid counts unknown when the site labels the count `Sealed`; do not mistake unrelated page text for a numeric count.
- Preserve the Buy Now amount separately and retain the original minimum-offer text in `source_record`.
- Derive shipping cost from Liquidation's separate `#shipping_details` panel and terms from the current lot; preserve fee label/value evidence in `source_record`.
- Parse colon-formatted Buy Now prices and ignore bid counts from related cards when sealed-bid counters are hidden.
- Align the actor, run summary, recovery manifest, and runtime release labels with package version 1.1.6.

## V1.1.8 correction

- Prevent search-page counters from filling sealed-bid lots whose detail pages show `Bids = Sealed`; their numeric `bid_count` and `minimum_bid` stay unknown.
- Add regression checks showing sealed counts stay blank while standard auction index observations still fill missing values.

## V1.1.7 correction

- Initialize all new completeness counters and make them self-initializing, preventing `NaN` values from serializing as `null`.
- Read price type and auction-start provenance from normalized attributes when those values are stored there.
- Add direct tests for populated shipping/price counters and pickup-only applicability.
- The failed 1.1.6 run saved 15 records after 16 successful requests, but its `null` health counters mean its mandatory field completeness cannot be certified from that run summary.

## V1.1 hardening

- CAD/C$ price parsing for search/detail.
- Verified current category index `/c/allcategories.html`.
- Checkbox/radio facet discovery.
- Manifest HTML row ingestion as governed `manifest_item` records.
- Durable manifest checkpoint/resume/DLQ support.
- Sealed Bid + Buy Now option detection.
- Opening/current/buy-now price classification and starting-price retention for no-bid lots.
- Cheapest visible shipping cost, shipping method, UTC auction start provenance, and raw `source_record` capture.
- Bid count/minimum bid/premium/quantity/variance/listing modes included in durable mutation evidence.
- Production certification mode requires `RELEASE_ARTIFACT_SHA256`.

## NOT VERIFIED in this sandbox

- Jest / ESLint / `npm run check` (package dependencies are not installed in this workspace; offline install did not complete)
- Apify build and Actor boot
- 20-lot live US+Canada accuracy sample
- full active-catalog/category/seller/warehouse coverage union
- live manifest reconciliation
- interrupt/resume, DLQ replay, concurrent-run and fault-injection gates

**Designation:** DATA QUALITY RELEASE CANDIDATE — live Apify and database ingestion remain to be verified.