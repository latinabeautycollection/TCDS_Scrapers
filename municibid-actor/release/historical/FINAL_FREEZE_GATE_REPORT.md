# Municibid V1.3 Final Hostile Freeze Gate Report

## Decision
**CONDITIONAL — GREEN TIER 1 FINAL FREEZE CANDIDATE; live Apify freeze approval NOT YET VERIFIED.**

## P0 history closed at source level
1. Non-atomic KV-only writer lease: replaced by dedicated Apify RequestQueue unique-key lock plus KV fencing evidence.
2. Lease loss could continue: fatal lease state aborts the crawler; V1.3 additionally fences navigation, Dataset writes and dedupe/reconciliation commits.
3. Stale-lock takeover race: V1.3 requires prior Apify run terminal verification before lock queue recycling.

## Remaining mandatory live gates
- clean `npm ci`, lint, Jest, check
- Apify build/boot
- two-run concurrent writer race
- stale-lock terminal verification against Apify Run API
- live ownership-loss termination
- 20-record source comparison including vehicles/equipment
- exhaustive partition coverage and zero-unaccounted reconciliation
- interruption/resume and source DLQ replay
- controlled HTTP fault injection
- dependency vulnerability audit

No 10/10 final-freeze designation may be issued until those exact-artifact gates pass.