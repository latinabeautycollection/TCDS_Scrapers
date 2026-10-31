# Municibid V1.3 Final Hostile-Gate Hardening Summary

V1.3 is a narrow hardening of V1.2. It does not redesign the certified PropertyRoom/Public Surplus framework.

## Added in V1.3
- Stale-lock takeover requires verification that the previous Apify run is terminal before the dedicated lock queue can be recycled.
- Lock ownership now carries a fencing token in addition to run ID and lock request ID.
- Ownership is checked before navigation, before Dataset persistence, and again before dedupe/reconciliation commit.
- Lock evidence is included in run statistics/completion evidence.
- Additional hostile tests cover terminal-owner verification and lease-loss fencing.
- Dependency graph remains identical to V1.2; only the root release version changed.

## Intentionally unchanged
- PropertyRoom-certified eBay/export/logging/webhook framework.
- Shared DedupeManager behavior. Any fail-closed durability change to DedupeManager must be governed across PropertyRoom, Public Surplus, and Municibid together.