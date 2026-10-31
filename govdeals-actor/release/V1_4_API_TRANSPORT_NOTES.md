# GovDeals V1.4 candidate: JSON API transport

Status: CANDIDATE. Passes the offline mock-API test. NOT yet certified: it has not been built on Apify or run against the live API.

## Why
GovDeals (www and prod-seo) serves an empty Angular shell, so HTML extraction cannot work. Data comes from the maestro JSON API
(search -> detail -> fees), per Tictac's spec. Only the crawler and parser were swapped.

## Changed
- src/extractors/govdeals.js: rewritten (API transport). No Crawlee/Apify import any more.
- NEW src/govdeals/api.js (client), apiParser.js (field mapping), defects.js (copy of the defect miner).
- src/govdeals/url.js: canonical listing URL is now https://www.govdeals.com/en/asset/{assetId}/{accountId}.
- main.js: new inputs, API keys required, proxy default off, CSV default off, always runs (default searchText "*"), maxPages default 0 (all).
- INPUT_SCHEMA.json: govdealsApiKey / govdealsSubscriptionKey are secret inputs; new tuning inputs; recordFixtures.
- certification-tests/api/api-mock-test.mjs: offline end-to-end test (synthetic mock). Legacy HTML tests are kept but only parser/url ones still describe a live path.

## Unchanged
normalize.js, dedupe.js, sqlExport.js, webhook code, fingerprint.js, eligibility.js, health.js, the govdeals-{accountId}-{assetId} id.

## Economy rules implemented
- Search runs for all lots every run (500 per page).
- Detail + fees only for lots that are new, whose search-row fingerprint changed (price, end time, title, location...), or older than govdealsDetailRefreshHours (24).
- ~1 s delay after every request, concurrency 2 by default, no proxy.
- Persistent GOVDEALS_SEARCH_INDEX in the actor-state-govdeals store.

## Assumptions to verify with the canary's recorded responses (set recordFixtures: true)
1. assetAttributeGroups shape (parser walks label/value pairs generically).
2. assetPhotos[] entry shape (string path or object with a url/path key).
3. Detail/fees responses are top-level objects with the field names in the spec.
4. x-total-count header is present on search responses.
5. Lot status (ended/cancelled) is not exposed in the search row; status is inferred from the end time.

## Canary input
{ "sourceName":"govdeals", "maxPages":1, "maxItemsPerRun":20, "maxConcurrency":2, "recordFixtures":true,
  "govdealsApiKey":"<secret>", "govdealsSubscriptionKey":"<secret>", "debug":true }

## Canary feedback fixes (Tictac, 08/10)
1. Buyer's premium: now from the bid box (GET /bids/bidbox/GD/{assetId}/{accountId}/{auctionId}) premiumPercent x current bid. The fees endpoint returned 0 and is no longer called.
2. primary_image_url: first detail photo in API order, built as https://files.lqdt1.com/photos/{accountId}/{file}. Search thumbnail is only a fallback.
3. Bidder restrictions: bid box `requirements` text sets bidding_eligibility (BUSINESS_ENTITY_ONLY / RESTRICTED), bidding_restriction_message, requires_account_review = true. NEW code values: confirm downstream accepts them.
4. brand/model: attributes.trusted now has Brand / Model / Model number (the keys normalize.js reads); falls back to detail specs when the search row is empty.
5. bid_count, bid_increment, auction_start_time from the bid box. Key names other than premiumPercent/requirements are guesses: verify with FIXTURE_bidbox_1.
6. content_hash stability verified in the offline test (two runs, unchanged lots, identical hashes).
Input renamed: govdealsIncludeFees -> govdealsIncludeBidBox.

## Mandatory intake-field update (2026-10-19)
- `current_price` now uses current bid, or the published opening price when there are no bids, then buy-now as fallback; `attributes.price_type` and `attributes.bid_count` are populated.
- `shipping_method` is `free_shipping`, `shipping`, `shipping_quote`, or `pickup_only`, classified from listing text and API flags; negative shipping wording wins conflicts, and the matching sentence is retained in `attributes.shipping_evidence`.
- `estimated_shipping` is 0 for free shipping or the cheapest explicitly published shipping price. Shipping with no stated price is `shipping_quote`.
- MPN is extracted from part/model/catalog identifiers. A coded Model value is reused as MPN; VIN and serial numbers remain separate.
- `recheckLots` supports targeted lot URLs/IDs and bypasses freshness and dedupe skips so prior incomplete records can be compared after fixes.
- Published start dates are normalized to ISO UTC. If the API omits one, the lot is marked incomplete with `not_observed_in_api` until a source-page check confirms whether the site truly omits it; only confirmed omissions use `not_published_by_site`.
- Every GovDeals record carries the unchanged API `search`, `detail`, and `bidbox` objects in `source_record`.
- Proxy mode now fails closed because this API transport has no configured proxy support.

## Shipping-scope and evidence correction (2026-10-25)
- Destination exclusions such as “No shipping to Alaska” do not override an explicit free-shipping offer for other regions.
- Limits on combined shipping or buyer-provided shipping labels do not mean the seller refuses to ship the lot. Explicit seller shipping offers remain `shipping_quote` unless a separate statement says shipping is unavailable for the lot.
- `attributes.shipping_evidence` is preserved by the shared normalizer so it reaches the dataset and exports.
- `recheckLots` must be populated with the same QA lot IDs or URLs for the recheck gate. A normal search run with `recheckLots: []` does not verify previously incomplete lots.

## Pickup-or-shipping language (2026-10-25)
- A deadline saying a lot must be “picked up or have shipping arranged” is an explicit shipping alternative, not pickup-only.
- “We can arrange shipping” maps to `shipping_quote` when no shipping amount is published, even when combined shipping or buyer-provided labels are disallowed.