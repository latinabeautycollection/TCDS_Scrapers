# Municibid V1.3 Input / Environment Trace

All Actor input properties must map to runtime code. Production defaults use `EXHAUSTIVE` discovery, conservative concurrency, direct HTTP unless proxy is explicitly enabled, persistent recovery/DLQ/reconciliation, and single-writer fencing by default.

Secrets (eBay client secret, webhook token, Google service account material, proxy credentials) are excluded from the recovery input fingerprint.

The Actor environment variables retained are source-neutral production/schema defaults and required webhook/zero-result controls. No PropertyRoom/Public Surplus source-specific environment variable is required for Municibid.