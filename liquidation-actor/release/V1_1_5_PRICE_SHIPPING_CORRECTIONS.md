# Liquidation 1.1.5 price and shipping corrections

The 2026-10-23 export exposed page-wide matching that could borrow a bid count or price from a related listing. Some sealed-bid lots also exposed an `Enter $X or more` minimum offer that was not being parsed.

This release scopes lot-specific extraction to the lot panel, keeps sealed bid counts unknown when the site hides them, captures visible minimum offers as a starting-price value when no public current bid is present, and keeps Buy Now price separately. Shipping estimates, terms, and pickup/shipping classification are extracted from the same lot panel.

The runtime version and build tag now both identify release 1.1.5. Live Apify and database verification remains a follow-up after the package is uploaded and run.