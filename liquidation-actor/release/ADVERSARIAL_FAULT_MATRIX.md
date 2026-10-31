# Adversarial Fault Matrix

| Scenario | Expected behavior |
|---|---|
| 408/network timeout | bounded retry |
| 429 | honor Retry-After, bounded retry, DLQ after exhaustion |
| 500/502/503/504 | bounded exponential retry, DLQ after exhaustion |
| 401 | AUTH_REQUIRED, fail closed |
| 403 | ACCESS_RESTRICTED, circuit-breaker accounting |
| 404 detail | REMOVED_CONFIRMED |
| HTTP 200 error/WAF page | schema/error-page failure, not logical success |
| dataset write failure | no dedupe commit |
| recovery corruption | fail closed + forensic preservation |
| source DLQ corruption | fail closed + forensic preservation |
| Actor abort/migration | persist recovery/dedupe/reconciliation |
| concurrent exhaustive run | single-writer exclusion |
| bid/end-time mutation | SAVED_CHANGED |
| countdown-only change | SKIPPED_UNCHANGED |
| capacity/runtime truncation | INCOMPLETE, never PASS |