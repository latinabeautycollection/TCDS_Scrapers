# Apify Final Certification Runbook — Municibid V1.3

Use the exact immutable ZIP/hash. Do not edit code between gates.

1. `npm ci`
2. `npm run lint`
3. `npm test`
4. `npm run check`
5. Apify build + Actor boot
6. Empty-input EXHAUSTIVE canary
7. 20-record source comparison including vehicles/equipment
8. Full active-catalog exhaustive run and partition-union report
9. Start two simultaneous runs against the same state: exactly one writer may proceed
10. Force/observe ownership loss: owner must abort and fail
11. Interrupt and resume; verify no lost/duplicate governed records
12. DLQ replay test
13. Controlled 408/429/5xx/401/403/404 fault injection
14. Price mutation / end-time extension / countdown-only tests
15. Verify `unaccounted=0`, pending index/detail=0, retry pending=0 for exhaustive PASS
16. PropertyRoom shared-regression suite
17. Security/dependency audit
18. Verify final ZIP SHA-256 equals certification report.