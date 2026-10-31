# GovDeals V1.4.6 — Shipping scope, MPN, and targeted recheck

## Status

The V1.4.4 run `dhBsJYfJAc27WhjVJ` completed with 20 records but had `recheckLots: 0`. V1.4.5 then rechecked all 8 targeted lots in Apify run `xmeiWivZzHjGNdUaL`: all 8 targets were found, fetched, normalized, saved, and the integration returned HTTP 200. That run corrected two free-shipping classifications and exported `attributes.shipping_evidence`. It still marked five seller-shipped GovDeals lots as pickup-only because the matched sentence was a deadline requiring pickup or shipping arrangement. V1.4.6 treats that wording as an explicit shipping alternative. Local static certification and tests pass; V1.4.6 live Apify and database verification remain pending.

## Changes

- Classify shipping using listing title, description, removal instructions, API shipping flags, and prices. Explicit free shipping maps to `free_shipping` with estimated cost 0; published costs map to `shipping` with the cheapest actual amount; an offer without a price maps to `shipping_quote`; pickup-only language maps to `pickup_only`. Negative phrases win conflicts, and the matched sentence is saved as `attributes.shipping_evidence`.
- Treat destination exclusions and limits on combined or third-party shipping arrangements as scoped restrictions, so they do not override a separate seller shipping offer.
- Treat “must be picked up or have shipping arranged” as a shipping alternative, not pickup-only.
- Preserve `attributes.shipping_evidence` in the shared normalizer so the buyer can review the matched source sentence in exported records.
- Extract MPN from part, manufacturer part, model, and catalog identifiers. If a Model value contains a digit, also use it as MPN. Keep serial numbers and VINs in their own attributes.
- Add `recheckLots` for targeted URLs and GovDeals IDs. Requested lots are fetched every time and skip freshness/dedupe suppression, allowing direct before/after comparisons on previously incomplete lots.
- Update actor metadata, input schema, dataset views, release notes, and certification tests.

## Local verification

- Static certification: passed.
- Jest: 11 suites passed, 38 tests passed.
- Targeted recheck offline test: passed; one exact lot was searched, detail/bid-box fetched, and emitted despite existing freshness/dedupe state.
- JavaScript syntax and actor/input JSON parsing: passed.
- Live API mock test: not run successfully because the sandbox blocked the local HTTP listener. The V1.4.5 ZIP has not yet had a live Apify run or database intake verification.

## Apify recheck gate

Build and run the V1.4.6 ZIP. Recheck the same 8 IDs from run `xmeiWivZzHjGNdUaL` and keep promotion disabled. Confirm the dataset includes each requested lot and inspect fields against original API objects. The free-shipping examples should have method `free_shipping` and estimated cost 0. The five seller-arranged shipping lots should have method `shipping_quote`, not `pickup_only`. Confirm `attributes.shipping_evidence`, MPN extraction, and serial/VIN separation. Confirm HTTP 200 and matching `dataset_items`/`received` counts before describing database ingestion as verified.