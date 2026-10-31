# TCDS Municibid Acquisition Intelligence Actor V1.3

PropertyRoom-aligned Apify/Crawlee acquisition-source adapter for Municibid. The actor discovers active Municibid listings, follows seller/category/state and overlapping browse surfaces, extracts mutable auction state, normalizes into `arb.unified_listing.v1`, persists cross-run dedupe/recovery state, retries transient failures, retains unresolved source requests in a DLQ, reconciles discovered IDs, and optionally enriches with eBay comps / exports.

## Governing boundary
This actor is an acquisition source adapter only. It does not write to Listings and does not issue BUY/NO-BUY, capital, checkout, payment, PQP, CAX, or warehouse authority.

## Municibid identity
Stable identity: `municibid-{Listing #}` from `/listing/{id}/{slug}`.

## Governed discovery
Default `EXHAUSTIVE` mode starts from:
- `/browse` active catalog
- `/browse?sort=newest`
- `/browse?sort=mostBids`
- `/map`
- `/auctions`
- discovered state/region browse links
- discovered category browse links
- discovered seller browse links

`includeCompleted=true` additionally includes `/browse?status=completed`.

## Mutable state
Price, end time, reserve state, condition/description, buyer fee, seller/location, shipping/pickup terms and other authoritative listing state participate in content change handling. Runtime countdown does not.

## Resilience
- PropertyRoom-style persistent DedupeManager
- source recovery/checkpoint state
- durable source-request DLQ
- 408/429/5xx bounded retries
- Retry-After support
- 401/403 fail closed
- source circuit breaker
- single-writer state lease
- Dataset write before dedupe commit
- PASS / DEGRADED / INCOMPLETE / FAIL run-health model
- zero-loss reconciliation for discovered IDs

## Live source fields
The parser targets Municibid fields such as Listing #, title, seller/location, current/starting bid, bid count, reserve state, buyer fee, start/end date, anti-sniping extension notice, payment details, description/condition, shipping/pickup, inspection, custom ID and images.

## Certification
`release/CERTIFICATION_REPORT.md` distinguishes source/static gates from Apify live gates. Final production freeze requires the exact ZIP hash to pass the included Apify runbook without code modification.