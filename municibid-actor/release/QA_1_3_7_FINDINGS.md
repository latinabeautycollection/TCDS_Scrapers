# Municibid 1.3.7 — real-page fixes, 18 October 2026

Status: offline replay verified against two supplied live-recorded pages. New Apify build/run and full 11-lot QA remain pending. This supersedes the 1.3.6 package; do not reuse its passing offline result as live approval.

## Evidence and root cause

Reviewed both supplied HTML pages and their original JSON snapshots from run CUeA5ILlc6lmERoAb. The HTML SHA-256 prefixes match the original archive keys: c5b790f690482a30 (Ford) and 87c7d0ef586e8645 (cart). Source fixtures are preserved byte-for-byte in the ZIP.

The 1.3.6 direct-listing canary exposed a dependency missed by the earlier offline tests: seller and location were usually supplied by browse-page observations. The detail parser expected obsolete seller links and a two-letter state in flattened header text. The real pages use .detail-meta__seller links under /seller/ and .detail-meta__loc with either a state name or abbreviation. All 11 records therefore lost both fields and the quality gate correctly failed. The gate was not weakened.

Additional defects: category parsing selected site navigation rather than listing breadcrumbs; global text matching read “make” from warranty prose, VIN from “Added VIN to pictures,” and hours from unrelated text. Shared output aliases subsequently overwrote Ford/Taurus brand and model. The old image extraction saw only six rendered gallery thumbnails even though the saved page's embedded gallery held all photos.

## Fixes and verified results

| Field | Ford 86222247 | Cart 86377249 |
|---|---|---|
| Seller | East Washington Borough Police Department | Conestoga Valley School District |
| Header location | washington, Pennsylvania | Leola, PA |
| Pickup address | 15 Thayer Street Washington, PA 15301 | 51 School Ln Ave, Brownstown, PA 17508 |
| Category / subcategory | Automotive / Cars | Computers & IT / Others |
| Make / model | Ford / Taurus | null / null (no separate published specification) |
| VIN | 1fahp2mk9hg130793 | null |
| Mileage | 67300 | null |
| Hours | null; removes erroneous 800 | null |
| Photos | 17, formerly 6 | 10, formerly 6 |
| Current bid / minimum bid | 3150 / null | null / 50 |
| Premium | 9% | 9% |
| Condition label | null; no standalone label found | null; no standalone label found |

The normalized Ford header location becomes washington, PA through the existing state normalization; its original spelling remains in evidence. The cart's header says Leola but its explicit pickup address says Brownstown. Both are retained separately; neither is silently substituted for the other. Live QA must confirm the physical pickup location before relying on it.

Descriptions are unchanged from the supplied snapshots, including line breaks. Start/end dates and pickup-only behavior remain supported. Unknown shipping costs remain null. Inspection details are extracted from the actual label/value rows; existing normalized-text contact redaction remains in force. Full original HTML/JSON archiving is retained.

Real modern pages now use bounded specification rows for vehicle identity, breadcrumb links for categories, and dedicated seller/location elements. Full photo lists come from decoded gallery data only when its title and first photo match the current page's visible gallery; otherwise the parser uses scoped gallery images. No remote image URLs were fetched or invented. Only the supplied cart page's 10-photo gallery is verified; ownership across the other five cart listings still requires their evidence or browser comparison.

Brand/model/MPN are restored after the shared alias step, with an offline normalization/alias regression to confirm Ford/Taurus survive. Hash coverage now also includes year, make, VIN, mileage, hours and subcategory so these corrections can create new intake versions. Volatile run metadata stays out of the hash.

## Validation

- Both real HTML fixtures replayed successfully, with source-hash, exact description, seller/location, category, specification, full gallery, pickup and pricing assertions.
- Normalization plus alias conversion preserves Ford/Taurus and all photo URLs.
- Existing Jest suite: 55 tests across 30 suites passed (see packaged v137-jest.json).
- Ten earlier field regressions plus original archive preservation/failure checks passed.
- Standalone payload, field rules and recovery-null tests passed. Static certification results are included separately and are not live QA approval.
- No deployment, live crawl, intake submission or promotion was performed in this repair session.

## Next run

1. Update the same Municibid actor with the 1.3.7 ZIP and build it. Select the new build explicitly. If using CLI, target lbcscraper/municibid-actor and build tag release-1.3.7.
2. Use municibid_v1.3.7_canary_input.json for the same 11 URLs. Keep existing actor-state-municibid; corrected fields change their hashes. Do not clear state for the later repeat-run check.
3. Export the CSV, RUN_SUMMARY and log. Location and seller must now be populated for every supported page; confirm no polluted make/model/VIN/hours. Expect 17 Ford photos and 10 for the supplied cart if the pages are unchanged.
4. Compare all 11 against the site, including full gallery ownership, new start dates, actual pickup location, explicit condition availability and price/bid history. Ended or removed lots require a documented replacement for the corresponding test.
5. Inspect the actual event integration response separately. The previous run failed, and no new intake success is claimed. Repeat with unchanged source/state to check dedupe, then obtain QA approval before enabling promotion.