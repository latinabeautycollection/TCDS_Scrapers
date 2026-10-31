# Apify Final Certification Runbook

1. Set `CERTIFICATION_MODE=production` and exact `RELEASE_ARTIFACT_SHA256`.
2. Run `npm ci`, `npm run lint`, `npm test`, `npm run check`.
3. Build/boot exact artifact in Apify QA.
4. Run 20-lot source comparison spanning US + Canada and Standard + Sealed + Mixed + Fixed Price.
5. Prove exhaustive `_page` traversal and category/seller/warehouse/shipping/type coverage union.
6. Verify every manifested lot emits and reconciles manifest line items (SKU/UPC/quantity/retail/notes).
7. Run bid/end-time/premium/quantity mutation tests.
8. Interrupt and resume; verify manifest and lot pending work survives.
9. Replay source DLQ; inject controlled 429/503/401/403 failures.
10. Start two concurrent exhaustive runs; exactly one writer may own state.
11. Require zero unaccounted lots and zero pending manifests/DLQ before PASS.
12. Verify final release hash binding.