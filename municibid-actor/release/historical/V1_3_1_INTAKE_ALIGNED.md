# Municibid V1.3.1: aligned to the Scraper Output & Intake Integration Guide

Status: CANDIDATE. NOT live-certified. The parser/extractor edits are syntax-checked only (cheerio/apify are not installed in the
build sandbox); the pure helpers pass certification-tests/unit/fieldRules.test.mjs. Test fixtures in this package are tiny and synthetic:
run a live canary with recordPages: true and compare 10 lots with the live site before certifying.

## Changes (lessons from the GovDeals and Public Surplus canaries)
- current_price is null when there are no bids, never 0 (a displayed 0 with no bids becomes null). The starting bid is kept as minimum_bid.
  The search-page price fallback is removed (shared card text gave every lot the same price on Public Surplus). Lots with a null price and
  bid_count 0 are no longer rejected; the run-health "current_price" completeness treats them as not applicable.
- buyers_premium is the published percent (e.g. 10), source in attributes.buyers_premium_source; inbound_fees_usd alias cleared.
- description keeps paragraph/list line breaks (block-aware), phones/emails redacted from description, payment, removal, inspection text.
  Payment details and seller terms are in attributes (payment_details, seller_terms), not in the description.
- Inline script/style text is removed before parsing.
- location: "City, ST[ ZIP]"; brand/model/mpn mapped to top level from manufacturer/make, model, model number.
- category is the site's own category name (the legacy alias step had turned it into a slug; slug kept in attributes.category_key).
- empty strings -> null (also re-applied after the legacy alias step).
- content_hash = sha256 of meaningful fields only.
- validateRecord runs on a shim (it demands strings; the guide wants null). The record itself keeps null.
- csvExportEnabled default false. New input recordPages saves the HTML of the first 4 pages (FIXTURE_html_*).
- recovery._finalize no longer throws when a run fails before recovery state exists (it masked the real error, e.g. LEASE_HELD).

## Still to verify live
- Whether the detail regexes match the real Municibid markup (price, bid count, fee %, dates, location "City, ST US").
- Image host filter (storagemunicibidpro.blob.core.windows.net) and that photos open in a browser.
- Open design question for Tictac: guide implies all active lots in the dataset each run; this actor emits new/changed lots only.

## V1.3.2: fixes after the first live canary (11/10/2026)
- Live result: HTTP 200 on https://municibid.com/browse, but every attempt failed with MUNICIBID_ERROR_PAGE_DETECTED and the run ended MUNICIBID_HEALTH_FAIL: schema_drift_detected.
  Cause: looksLikeErrorPage() searched ALL text including embedded script data. Municibid is a Next.js site and its payload contains
  `"forbidden":"$undefined"`, so the word "forbidden" matched. Fix: script/style/noscript are removed before the error-page text checks.
- Regression found in V1.3.1 and fixed: a same-line edit commented out `const root=...; const identity=...` in parseDetailPage (syntax check cannot catch this).
  The comment now sits on its own line.
- Index cards (verified on the recorded real page: 24 listings): <article class="listing-row">, title in h3 a, "City, ST | Agency",
  "Bid(s): 23 | Current Bid: $2,085.00", thumbnail on storagemunicibidpro.blob.core.windows.net. The title now comes from the card's h3 instead of the whole card text.
- Not yet verified: detail pages (price, fees, dates). Run again with recordPages: true to capture FIXTURE_html_detail_1.

## V1.3.3: second false "error page" (first detail page, 11/10/2026 canary)
- Live result: the browse page now parses (24 items found), but the first detail page https://municibid.com/listing/84929706
  returned HTTP 200 and was rejected 3 times as MUNICIBID_ERROR_PAGE_DETECTED, then MUNICIBID_HEALTH_FAIL: schema_drift_detected.
- Cause (inferred from the code; the detail HTML was not available to confirm): the error-word list (maintenance, forbidden, ...) was matched
  against the whole visible page, including the item's own description (e.g. "maintenance records" on a vehicle lot).
- Fix: error words now count only when the page has no listing content (Listing #, Current Price/Bid, Starting Bid, Item Description,
  Bid History, Payment Details). A matching <title> still counts as an error page.
- Still unverified: detail parsing (price, fee %, dates, description). Send FIXTURE_html_detail_1 from the run's key-value store.

## V1.3.4: first real detail record (canary lot 84929706, 11/10/2026) and the fixes it exposed
Run result: 1 record saved (price 15655, bid_count 31, buyer's fee 9%, category "Automotive Auctions" all correct), run FAILED health:
critical_field_completeness:auction_end_time 0/1. Other defects in the saved record:
- auction_end_time null / status UNKNOWN: the visible HTML has no end time (the "ENDS IN" countdown is filled in by the browser).
- seller_name "West Pikeland Township": WRONG (first seller link on the page = a related listing). The listing's seller is "Borough of Franklin Park".
- location "WorkStar Dump TruckPITTSBURGH, PA": title text glued to the city.
- description: map text + "Related Auctions" block, not the lot description.
- image_urls: a PDF and 4 related-listing thumbnails (_thumbcrop) mixed in; primary_image_url was the PDF.
Discovery: Municibid is a Next.js site; the HTML embeds each listing as JSON (src/municibid/payload.js documents the verified shape):
{id,title,subtitle,currentPrice,bidCount,endsAtUtc,primaryImageUrl,location,sellerUserName,agencyName,reservePrice,sold,hasVideo}.
For lot 84929706 the payload says agencyName "Borough of Franklin Park", location "PITTSBURGH, PA", endsAtUtc "2026-10-12T16:00:00" (UTC).
Fixes:
- Index parser merges the payload per listing; the detail record takes end time, seller (agencyName), location, bid count and thumbnail from it.
  The detail parser also reads endsAtUtc from its own payload as a fallback. Status and time remaining are recomputed after the end time is known.
- Media: only the item's own _largesize photos are image_urls; PDFs go to documents; related thumbnails dropped; primary = first photo.
- Description: boilerplate removed; if nothing real remains, a payload description is tried; else null (never the title).
- No-bid rule: a displayed "Current Bid" with bid_count 0 is the starting bid, so current_price = null and minimum_bid = that amount.
- certification-tests/fixtures/municibid-index-REAL-2026-10-11.htm is a REAL recorded page; payload.test.mjs asserts against it (24 listings).
Still unverified: the real lot description text and condition on the detail page (send FIXTURE_html_detail_1 if the description comes out null).

## V1.3.5: small fixes after the successful canary (12/10/2026, 3 records)
Verified live: seller (agencyName), "City, ST" location, end time (UTC), ACTIVE status, premium as percent, only _largesize photos (PDF -> documents), no emails/phones.
- description was the generic page-metadata sentence "Government surplus auction by <agency> on Municibid." for 2 of 3 lots. It is now rejected (null) so the guide rule holds (null, never a substitute).
  If real descriptions exist for those lots, send FIXTURE_html_detail_1 (the first lot of that run is a lot with the weak description).
- brand stayed empty although attributes.make was "International": the shared normalizer leaves '' and ?? does not replace it. brand/model/mpn now use ||.