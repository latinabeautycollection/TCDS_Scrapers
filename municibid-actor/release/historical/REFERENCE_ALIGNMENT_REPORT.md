# Municibid V1.3 PropertyRoom/Public Surplus Alignment Report

PropertyRoom remains the golden acquisition framework. Public Surplus remains the hardened exhaustive/recovery reference. V1.3 introduces only Municibid-specific source and concurrency controls.

## Byte-identical PropertyRoom core verified
- `.actor/Dockerfile`
- `src/extractors/ebay.js`
- `src/utils/export.js`
- `src/utils/logging.js`
- `src/utils/webhook.js`
- `src/utils/webhookManager.js`

## Minimal shared extensions retained
- `normalize.js`: Municibid source recognition within the existing unified schema.
- `dedupe.js`: `municibid-*` source recognition.
- `sqlExport.js`: source-neutral `record.source` behavior with PropertyRoom regression coverage.

## V1.3-specific files
The lock/fencing, discovery, parser, health, recovery, circuit breaker, URL, logistics and source extractor modules remain under `src/municibid/` / `src/extractors/municibid.js`.