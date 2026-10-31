# Municibid data completeness patch, 17 October 2026

Offline-only patch; NOT certified live. Changes:
- Parse Current Bid/Starting Bid with optional colons, and Bid(s) counts.
- Extract numeric shipping charge only when a listing explicitly shows Shipping Cost/Fee/Price or Delivery Cost/Fee. No published amount means null, not an invented estimate.
- Preserve starting_price, estimated_shipping, start/end times, pickup status and pricing diagnostics on final records and attributes.
- Include start time, shipping amount and shipping/pickup statuses in stable content_hash so later changes can trigger new versions.
- Existing no-bids behavior remains: current_price=null, minimum_bid=start/displayed opening amount. This meets the intake guide but must be explained to QA.

NOT yet implemented or independently verified:
- Complete untouched site original record. Tictac said he would supply its final intake mapping; do not guess the contract or accidentally copy personal contact details.
- Live auction values, site markup variations, or Supabase HTTP receipt.
- Full dependency-based integration tests (dependencies are not installed in this offline environment).

Required Apify run: import zip files at root, build, small 5-10 item canary, inspect dataset sample vs live listings. After succeeded run: Runs > selected run > Triggered integrations > HTTP request > Attempt > Response body. Confirm HTTP 200, ok:true, received > 0, rejected:0. Check values in arb.listings_raw with Tictac. Repeat unchanged canary should mostly show unchanged, except lots updated live.

Webhook setup is an Apify actor setting, not an embedded webhook in the code: Integrations > Add integration > HTTP request; event 'Run succeeded'; URL ends in `?source=municibid`; supply x-webhook-secret in the private headers setting, leave payload template default. Never put the secret in the ZIP or messages.