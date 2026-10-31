# Liquidation V1.1.1 — intake alignment and blocker fixes

Base: Tictac's V1.1.0. Shared files (normalize.js, dedupe.js, export.js, webhook.js, ...) are NOT edited.

## Fixed
1. `parseDetailPage` referenced an undeclared variable `images` (ReferenceError on every lot page). Now defined (`extractImages`).
2. `includeManifestItems` default is now OFF: manifest lines were emitted as `manifest_item` Dataset records, which the intake would ingest as lots.
3. Currency is no longer guessed from the location (e.g. "ON"); only explicit C$/CAD/USD markers count, otherwise USD.

## Intake contract (src/liquidation/fieldRules.js, applied after normalizeRecord and again after addSupabaseAliases)
- `current_price` null for standard auctions with 0 bids (amount kept in `minimum_bid`); `noBidPricePolicy` NULL (default) / MINIMUM_BID.
- `buyers_premium` = published percent (11, not 0.11 or dollars); `attributes.buyers_premium_source`.
- `description`: block-aware text with line breaks kept, null when absent, never the title.
- `image_urls` / `primary_image_url` = first photo.
- nulls instead of empty strings; own `content_hash` over meaningful fields only; validation shim (record keeps nulls).
- Health: no-bid lots are "not applicable" for `current_price` (sealed bids already were).

## New input
- `recordPages` (default false): saves FIXTURE_html_detail_1..3, FIXTURE_html_index_1..2, FIXTURE_html_manifest_1, FIXTURE_urls.
- `noBidPricePolicy`.

## Verification status
- Static: JS syntax OK; TypeScript undefined-identifier check clean; `node certification-tests/unit/fieldRules.test.mjs` passes.
- NOT run here (no npm/cheerio in the sandbox): Jest, ESLint, the parser against HTML, any live request.
- UNVERIFIED against the live site: lot photo selectors, description heading structure, category, bid-count extraction, no-bid display. Canary with `recordPages:true` is the first real test.

## V1.1.2 (after the first live canary)
Canary result for V1.1.1: 15/15 lot pages fetched, 0 saved, 15 `VALIDATION_FAILED` (`attributes.trusted` / `attributes.mined` must be plain objects).
- Validation shim now also supplies `attributes.trusted` / `attributes.mined` (copy only; the stored record keeps flat attributes).
- Parser selectors verified against a recorded live lot page:
  - description: `#description_table`, leading lines that repeat the title are dropped;
  - photos: the inline `auctionView_images.push({"image_url": ...})` list (the `<img>` carousels on the page are OTHER lots and are no longer read);
  - category / subcategory: `#breadcrumbCategory` / `#breadcrumbSubCategories`;
  - bid count, bidders, views, watchers: `#auctionStats`;
  - "Est Retail Per Unit $0.00" is treated as unknown (null).

## V1.1.3 (after the second live canary: 15/15 saved, three fields still wrong)
Found by reading the canary CSV against a recorded lot page:
- `location` was ~5,000 chars of site navigation: the first word "Location" on the page is a search-sort dropdown option. Now read from the "Location" row inside `#auctionData` (e.g. "Deer Park, NY"); anything over 160 chars becomes null.
- `seller_name` / `seller_agency` / `attributes.seller` were ~10,000 chars of footer text ("Seller Tools ..."). Now read from the "Seller" row, "(View Seller Rating)" removed; over 120 chars becomes null.
- `auction_status` was ENDED for every lot (and `price_status` FINAL_SOLD_PRICE) because the page's boilerplate says "winning bidder" on every lot. Status now comes only from an explicit "CLOSED ON" banner, a cancelled notice in the top of the lot box, or the end time being in the past.