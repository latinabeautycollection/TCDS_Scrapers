# Apify Final Certification Runbook — GovDeals V1.4.6

Use the exact release ZIP and do not modify files before testing.

## Gate A — Build and offline checks

```bash
npm ci
npm run lint
npm test
node scripts/certify-static.mjs
```

The actor build must identify as V1.4.6 / release-1.4.6. Record the build ID and verify the run starts that exact build.

## Gate B — Actor boot and valid partial runs

Run controlled tests showing:

- A lot without a published current/opening/buy-now price is rejected and is absent from dataset output.
- If at least one valid lot is emitted, an isolated rejected lot produces health `DEGRADED` with a rejection warning; actor process exits successfully.
- If zero queued lots are usable, the actor fails.
- Auth/API failure, schema drift, systemic detail parse failure, required internal webhook failure, and emitted-record completeness failure remain hard failures.

## Gate C — Shipping evidence

- Explicit advertised free shipping maps to `estimated_shipping: 0` and `shipping_method: "free_shipping"`.
- “No free shipping” is not treated as free.
- Destination exclusions such as “No shipping to Alaska” do not cancel a separate free-shipping offer.
- “Combined shipping is not available” and restrictions on buyer-provided labels do not imply pickup-only when seller-arranged shipping is offered.
- “Must be picked up or have shipping arranged” is a shipping alternative and maps to `shipping_quote` when no price is stated.
- Numeric shipping options use the cheapest actual published amount.
- Shipping offered without a price maps to `shipping_quote`; matched sentence is retained in `attributes.shipping_evidence`.
- Pickup-only lots carry `shipping_method: "pickup_only"`.
- Do not infer a shipping amount where the source gives none.

## Gate D — Live canary and integration

Use `recheckLots` with the same test lot URLs/IDs, including lots that were incomplete previously. These exact lots bypass freshness and dedupe checks. Keep promotion disabled and verify the output item count before depending on the integration.

Keep the existing Apify integration set to **Run succeeded**. Verify the run succeeds (PASS or DEGRADED), the integration triggers, the endpoint returns HTTP 200, and dataset/received counts match. Do not configure failed-run events to ingest partial datasets.

Compare at least 10 live lots and confirm price semantics, bid count, shipping cost/method, UTC start/end times, and exact original search/detail/bid-box data in `source_record`.

## Release decision

Do not call the actor approved until the exact V1.4.6 ZIP passes Gates A-D on Apify and the intake counts match. Recheck all 8 lots from run `xmeiWivZzHjGNdUaL`; confirm lot `govdeals-28251-795` exports free shipping and cost 0, and the five `govdeals-23980-*` seller-shipping lots export `shipping_quote`, with evidence retained in `attributes.shipping_evidence`.