# Liquidation.com Source Reconnaissance

Verified public source model used by V1.0:

- Search/catalog: `/auction/search?...`
- Detail identity: `/auction/view?id=<AuctionId>`
- Pagination: `_page=<N>`
- HTML manifest: `/aucimg/.../m<AuctionId>.html`
- Download manifest: `/auction/csv_manifest?auctionId=<AuctionId>`

Current public search results expose seller, title, close time, location, condition, lot/package size, current bid or sealed-bid state, shipping facets, auction-type facets, warehouse facets, seller facets and price bands.

Current public detail pages expose Auction Id, title, current/winning bid, minimum bid, exact close timestamp, seller, location, condition, shipping terms, total weight, quantity/variance, buyer's premium, auction type, description, manifest links, shipping details and terms/removal language.

Liquidation.com auction formats include Standard, Sealed Bid, Mixed Format and Fixed Price. Mixed Format combines sealed-bid semantics with Buy Now availability.