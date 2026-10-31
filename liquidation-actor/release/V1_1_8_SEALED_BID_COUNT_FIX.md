# Liquidation 1.1.8 sealed-bid count correction

Version 1.1.8 prevents search-page counters from filling in bid counts or minimum bids for sealed-bid lots. Liquidation detail pages that label the count `Sealed` do not publish a numeric bid count, so these fields remain unknown instead of borrowing unrelated or misleading search-card observations. Standard-auction index fallbacks are unchanged.

A row-level CSV audit of the 1.1.7 output found two sealed lots with false numeric counts (`64` and `0`). The source page labels both counts `Sealed`. The patch includes direct regression checks for both the sealed-lot guard and the retained standard-auction fallback.