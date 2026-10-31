# TCDS Municibid Acquisition Intelligence V1.3 Certification Report

## Source-level result
**GREEN TIER 1 FINAL FREEZE CANDIDATE — CONDITIONAL / NOT YET LIVE FREEZE APPROVED**

### Verified in this environment
- Version/release integrity: PASS
- JavaScript syntax: PASS
- JSON parse: PASS
- Dependency graph unchanged from V1.2: PASS
- PropertyRoom immutable-core alignment: PASS
- Static certification suite: PASS
- Atomic writer exclusion unit behavior: PASS
- Stale-lock prior-run terminal verification: PASS
- Lease fencing before navigation/Dataset/dedupe state changes: PASS
- DST-aware generic US timezone smoke: PASS
- Mutation/dedupe/recovery/DLQ health gates: PASS

### Not verified in this environment
- `npm ci`: NOT VERIFIED (registry/network timeout)
- ESLint/Jest full suite: NOT VERIFIED
- npm vulnerability audit: NOT VERIFIED (registry DNS unavailable)
- Apify cloud build/boot: NOT VERIFIED
- Live two-run atomic concurrency: NOT VERIFIED
- Live stale-lock takeover using Apify Run API: NOT VERIFIED
- Live lock-loss termination: NOT VERIFIED
- Full live exhaustive catalog / zero-unaccounted: NOT VERIFIED
- 20-record live source comparison: NOT VERIFIED

The artifact must not be labeled `10/10 FINAL FREEZE APPROVED` until every mandatory Apify runbook gate passes on the exact immutable hash.