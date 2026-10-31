# Liquidation 1.1.4 data-quality changes

- Keep a published opening/minimum bid in `current_price` for no-bid standard auctions and mark `attributes.price_type` as `starting_bid`. Current bids and buy-now prices receive their matching price type.
- Parse the lowest real shipping amount shown and always set `shipping_method` to `shipping` or `pickup_only`.
- Parse published auction start and end times into UTC ISO strings. When no start time is published, record `attributes.auction_start_time_source=not_published_by_site`.
- Add `source_record` to each auction lot with the exact original page HTML, extracted label/value pairs, full description, shipping options, raw price/time text, and page scripts containing auction, bid, price, or date signals.
- Add the required fields to the Liquidation listings and logistics dataset views.

The package is a candidate build. A live Apify build/run and successful database intake response are still needed to verify production behavior.