# Municibid QA tasks 1–6 — offline findings

**Release: 1.3.6 / release-1.3.6. Status: OFFLINE CHECKS PASSED; LIVE QA AND PROMOTION NOT APPROVED.**

## Scope and evidence

The referenced conversation was retrieved, but its assistant checklist text was unavailable (content-reference placeholders). Tasks 1–6 below are mapped to the six areas explicitly requested in this chat, not claimed to reproduce an unavailable checklist.

Reviewed the supplied `municibid_location_fix_2026-10-17.zip`, the exact 11-record CSV, `RUN_SUMMARY(1).json`, both local copies of the Scraper Output & Intake Integration Guide, and TCDS_Project_Complete_Briefing.pdf. The ZIP contains a real 24-listing browse fixture dated October 11 and synthetic detail fixtures. No recorded detail HTML for these 11 lots was supplied. The prior conversation also exposes an index HTML attachment, which cannot establish detail-only field values. No live site or Apify run was performed, no webhook was sent, and no database/promotion setting was changed.

The original CSV is evidence, not a reprocessed result. Its missing dates, condition labels and shipping charges have not been fabricated or backfilled. The new actor must fetch fresh detail pages to populate any newly supported fields.

## The six QA areas

| Task | Finding and implemented change | Remaining evidence needed |
|---|---|---|
| 1. Current vs starting bid / no-bid | CSV: 3 active bids ($3,150, $8,600, $2,200), 8 zero-bid lots with null current price and opening amounts in minimum_bid. Removed inference that missing price/count means zero bids. Explicit zero remains the only no-bid trigger; starting/minimum amounts stay separate. Unknown price/count is rejected by the existing source-validation gate. | Confirm bid history and opening amount on at least one zero-bid lot and one active-bid lot. |
| 2. Auction start dates | CSV: 0/11 start dates. Added bounded DOM label/value extraction and identity-matched startsAtUtc payload fallback, alongside existing published date parsing. No date is derived from end time or observation time. | Determine whether the live page actually publishes start dates and which representation/time zone it uses. Missing means null. |
| 3. Shipping and pickup | CSV: 11/11 pickup-only; 0/11 numeric shipping costs. Only a bounded explicit dollar charge becomes estimated_shipping, including explicit $0. Pickup-only remains null cost. Added negative shipping wording handling. | Confirm pickup text, address, removal deadline and whether transport cost is published. Null is not free shipping. |
| 4. Condition | CSV: 11/11 UNKNOWN. Added bounded Condition / Item Condition row extraction. Output condition and condition_text retain the site's exact condition wording; no published label yields null. No NEW/USED inference from description. | Compare live condition labels, especially where description says fair condition but no structured label exists. |
| 5. Original records and descriptions | Every successfully parsed fetched detail response is archived in the run KV store as exact HTML plus pre-normalization parsed JSON and index observation. Output contains store/key/SHA-256 references. Archive errors propagate to retries rather than silently discarding originals. Description fallback is limited to a matching listing ID; short genuine text and paragraph boundaries are preserved. Description changes now affect content_hash. | Confirm full description against the page, source archive retrieval and retention. HTML preserves all response content, not browser-only content that was never fetched. |
| 6. Premiums, images, locations | CSV: premium 9% on 11/11; descriptions and images on 11/11. Premium remains percentage at intake; colon-form fee labels supported. Related-auction heading sections are removed before field/media extraction, with existing thumbnail/document filtering retained. Matching index payload location preference retained. Pennsylvania-to-PA normalization added; original location and review flag remain available. Media, descriptions and relevant field changes update the hash. | Confirm 9% per lot, all image ownership/ordering/URLs, physical item location and any full-state-name or unusual location formats. No ZIP codes guessed. |

## Record-level audit of the supplied CSV

All dates in the table are omitted because all start dates are blank; all condition fields are UNKNOWN and all shipping costs blank. Values below are recorded historical observations, not current live bids. See the accompanying JSON for URLs and individual checks.

| Listing | Bids | Current | Minimum | Premium % | Photos | Description chars | Location |
|---|---:|---:|---:|---:|---:|---:|---|
| municibid-86222247 | 7 | 3150 | null | 9 | 6 | 594 | washington, Pennsylvania |
| municibid-85893128 | 14 | 8600 | null | 9 | 6 | 81 | Ebensburg, PA |
| municibid-86377249 | 0 | null | 50 | 9 | 6 | 172 | Leola, PA |
| municibid-86379242 | 0 | null | 50 | 9 | 6 | 172 | Leola, PA |
| municibid-85542547 | 0 | null | 3000 | 9 | 6 | 151 | Barto, PA |
| municibid-85541128 | 0 | null | 500 | 9 | 4 | 79 | Barto, PA |
| municibid-86378897 | 0 | null | 50 | 9 | 6 | 172 | Leola, PA |
| municibid-86378520 | 0 | null | 50 | 9 | 6 | 172 | Leola, PA |
| municibid-86377802 | 0 | null | 50 | 9 | 6 | 172 | Leola, PA |
| municibid-86251253 | 7 | 2200 | null | 9 | 6 | 429 | Berwick, PA |
| municibid-86378147 | 0 | null | 50 | 9 | 6 | 172 | Leola, PA |

The six similar LocknCharge descriptions belong to distinct listing IDs; identical text alone is not proof of duplicate lots. `washington, Pennsylvania` is preserved evidence; the new actor can normalize the state name without inventing a postal code.

## Offline verification

- Full Jest suite: **55/55 tests; 30/30 suites passed**.
- New regression script: 10 field/data-integrity cases passed, plus original-source preservation and archive-failure propagation checks.
- Standalone field rules, payload parsing and null recovery tests passed. Payload test checks all 24 listings in the real browse fixture.
- Syntax checks: all 41 production/script JavaScript files passed. Offline runtime: Node 24.21.0 on Windows; the supplied Dockerfile still targets Apify Node 20, so the Apify build remains a live validation step.
- Static certification: **51/51 checks passed**. This is not live certification.
- The first full run found three pre-existing failures, reproduced against the untouched ZIP: a custom-ID parser boundary defect (fixed); an old health expectation of FAIL instead of the implemented INCOMPLETE state (test corrected); and an old lease test missing the now-required atomic queue (mock updated). No lock protections were removed.
- Dependency versions remain locked; only root release version and scripts changed. Test dependencies were downloaded with approval. Tests themselves used local fixtures/mocks, not site requests.

## What the existing run proves

Run `hx6AWTWM9jykRviAJ` recorded 18 successful requests, 12 detail pages parsed/validated, 11 saved, 1 capacity skip, and no parser/normalizer/validation failures. Completeness uses 12 parsed records, so its 4 prices must not be confused with the CSV's 3 active prices among 11 saved records. The run is TARGETED and capacity-truncated; 45 detail requests and 4 index requests remain pending, with only 1 of 2 tracked partitions complete. Its PASS is a bounded run-health result, not exhaustive coverage or field QA approval.

The supplied historical intake response says received 11, new_versions 10, unchanged 1, rejected 0, promoted 0 and promote_enabled=false. It is not a new intake validation of this release. The intake guide explicitly says acceptance does not validate all field quality. This report therefore does not claim database QA sign-off.

## Import and manual live validation

1. Import the updated source ZIP into the Municibid actor and build it. It includes `.actor/actor.json`, Dockerfile, lockfile and input schema at their original paths. Install-time dependencies are not bundled. Check the build reports 1.3.6 / release-1.3.6. No automatic deployment was performed here.
2. Use `municibid_QA_canary_input.json` for the 11 exact source URLs, with direct requests, concurrency 1, optional eBay enrichment off and limited runtime. Review any existing actor event integration before running; the input does not contain credentials or configure a new integration. If a lot has ended or disappeared, document that and select a current representative lot for the corresponding check.
3. Keep existing state for repeat-run validation. The expanded hash intentionally changes on first import; a first-run increase in new_versions is expected. If existing recovery state prevents the intended canary, use a separate QA actor/state with the same source identity rather than deleting shared production state blindly.
4. Compare at least 10 lots in the browser, including one active bid, one zero-bid lot, pickup-only logistics, an explicit shipping quote if a real example exists, an explicit condition label, and the unusual Washington location. Check full descriptions, every photo, premium, start/end dates and timezone. Mark unavailable values as unavailable, not passed by inference.
5. For each output, retrieve `attributes.original_record` or `source_meta.original_record`: confirm its HTML/JSON keys exist in the specified run KV store, compare HTML SHA-256, and confirm the JSON retains pre-normalization values. Export/archive the run store if evidence must survive Apify retention. Original source snapshots can contain published contact data; normalized descriptions retain the existing contact-redaction rule.
6. Review the fresh dataset, RUN_SUMMARY and actual intake response: correct source and URLs on every row, no unjustified zero current prices, no fabricated data, rejected=0. Tictac should verify the stored intake rows. Repeat with the same state and unchanged source content: nearly all records should be unchanged/skipped. Then obtain QA/Anthony approval before promotion.

Live comparison, real HTML layout compatibility, image reachability, canary build/runtime/storage cost, fresh intake acceptance, repeated-run behavior and promotion approval remain **PENDING**. Offline passing tests do not resolve these items.