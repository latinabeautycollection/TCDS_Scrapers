# PropertyRoom Reference Alignment Report — GovDeals V1.3

## Byte-identical golden baseline components

- PASS `.actor/Dockerfile`
- PASS `.dockerignore`
- PASS `.gitignore`
- PASS `src/extractors/ebay.js`
- PASS `src/utils/export.js`
- PASS `src/utils/logging.js`
- PASS `src/utils/webhook.js`
- PASS `src/utils/webhookManager.js`

## Minimal shared compatibility deltas

- `src/utils/normalize.js` — PropertyRoom SHA `433baeea9e126e2aaf6718bd32bffa5b4fd99eb9aedb4b4e46f827a429ed848e`; GovDeals SHA `3df2a581da58154b61698de68ae282ee0f7635b22098c3da1e3f3d33a2d54e88`
- `src/utils/dedupe.js` — PropertyRoom SHA `78c5a9c73c948f75bdea4e3c43fdead4fe28419ac22b95918cff7afe27930f2f`; GovDeals SHA `8e05497ece1aabf1a959bdfd70019b8bcdc5d5f97124db0a615945b1626a43cb`
- `src/utils/sqlExport.js` — PropertyRoom SHA `3785a16ca0aaf21a6f1a76e6e8598936e0b2f8169a60c17fe1454ac400b3f71b`; GovDeals SHA `2d6ae6b86f399e0f9b54718fea4dca654de171fc5a4aec77456b74490e0a6ef8`

These deltas are additive/source-neutral and are covered by PropertyRoom regression tests. No other shared framework utility was modified.

## Source-specific deltas

- `main.js`: PropertyRoom orchestration pattern retained; source import/name/defaults plus fail-closed GovDeals controls and RUN_SUMMARY.
- `.actor/actor.json`: GovDeals metadata and views.
- `INPUT_SCHEMA.json`: GovDeals inputs/defaults.
- `src/extractors/govdeals.js` and `src/govdeals/*`: GovDeals source adapter implementation.
- `certification-tests/*`: non-runtime certification suite.
- `scripts/certify-static.mjs`: non-runtime static certification helper.