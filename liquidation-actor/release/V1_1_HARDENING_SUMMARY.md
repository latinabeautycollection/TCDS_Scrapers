# Liquidation V1.1 Hardening Summary

Narrow source-specific upgrades only; certified PropertyRoom-family recovery/DLQ/circuit-breaker architecture preserved.

- CAD/C$ parsing added to search and detail price extraction.
- Current category index updated to `/c/allcategories.html`.
- Checkbox/radio facet discovery added without inventing routes.
- Manifest HTML rows can be emitted as governed `manifest_item` dataset records.
- Sealed-bid + Buy Now instruction handling hardened.
- Bid count, minimum bid, premium, quantity, variance and modes participate in durable source metadata/content hash.
- Production certification mode requires `RELEASE_ARTIFACT_SHA256`.
- Certification fixtures expanded for CAD, mixed format, and manifest parsing.

Shared family concerns (DedupeManager persistence fail-soft and cross-family stale-lock governance) remain intentionally unmodified here and require a coordinated family release if changed.