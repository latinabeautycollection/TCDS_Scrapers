# Municibid Source Reconnaissance — V1.3

Audit date: 2026-10-09/10 UTC.

Current public Municibid surfaces verified during final gate include `/browse`, seller-filtered browse pages, category/region navigation, `/map`, `/auctions`, and listing detail pages. The live browse surface showed hundreds of active listings at review time; counts are dynamic and are not hard-coded.

Current detail pages expose Listing #, seller/location, current or final bid, bid count, buyer fee, end time, pickup/shipping and additional structured vehicle fields such as VIN/year/make/model/miles when applicable. Municibid also publishes auction-extension language on active auctions.

Transport remains legitimate public HTTP/HTML via CheerioCrawler. No CAPTCHA, authentication, geographic restriction, or access-control bypass is implemented.