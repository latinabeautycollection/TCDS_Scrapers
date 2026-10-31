# Municibid V1.3 — Final Adversarial Fault Matrix

| Fault | Expected behavior | Source-level result |
|---|---|---|
| Network/408 | bounded retry, then DLQ | PASS by code/static gate |
| 429 | honor Retry-After + bounded retry | PASS by code/static gate |
| 5xx | bounded retry/backoff, DLQ on exhaustion | PASS by code/static gate |
| 401 | AUTH_REQUIRED, fail exhaustive coverage | PASS by code/static gate |
| 403 | ACCESS_RESTRICTED + circuit accounting | PASS by code/static gate |
| 404 discovered lot | REMOVED_CONFIRMED | PASS by code inspection |
| Bad/error HTML | reject/schema-drift, not auction data | PASS by fixtures/static tests |
| Dataset write failure | no dedupe commit | PASS by ordering gate; live fault injection NOT VERIFIED |
| Recovery/DLQ corruption | preserve evidence + fail closed | PASS static/tests |
| Concurrent run | unique-key writer lock | PASS dependency-free unit/static test; live Apify race NOT VERIFIED |
| Expired/stale lock | prior run must be proven terminal | PASS V1.3 static/unit logic; live API NOT VERIFIED |
| Lock loss | abort/fail, fence writes | PASS source-level gate; live Apify test NOT VERIFIED |
| Pagination/capacity truncation | INCOMPLETE, checkpointed | PASS source-level gate |
| Price mutation | changed hash | PASS static test |
| End-time extension | changed hash | PASS static test |
| Countdown only | stable hash | PASS static test |
| DST generic zones | season-aware | PASS dependency-free smoke/tests |
| Zero-result/catalog collapse | non-PASS anomaly path | PASS code review; live baseline NOT VERIFIED |