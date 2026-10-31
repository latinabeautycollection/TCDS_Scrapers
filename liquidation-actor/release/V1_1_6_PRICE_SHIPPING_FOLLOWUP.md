# Liquidation 1.1.6 price and shipping follow-up

The 2026-10-23 02:06 run correctly captured each lot's visible price, including minimum offers, but the shipping fee estimate was blank because Liquidation renders minimum fees in a separate `#shipping_details` panel. This release reads that panel while keeping bid and price extraction scoped to the lot's auction panel.

Buy Now labels with a colon are recognized and preserved separately. Sealed-bid counts remain unknown when the site displays `Sealed`, and are no longer inferred from neighboring page content. The run summary and recovery manifest release labels have been aligned with the actual package version.

Regression coverage now includes a lot whose shipping fee is outside its auction panel. Static checks passed; live Apify and database verification are still required after uploading this release.