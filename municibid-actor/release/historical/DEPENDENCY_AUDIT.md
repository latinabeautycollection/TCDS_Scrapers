# Dependency Audit — Municibid V1.3

- No runtime or development dependency version was changed from V1.2.
- `package-lock.json` dependency graph was verified byte-equivalent to V1.2 after normalizing only the root package version.
- Direct dependencies remain: `apify`, `crawlee`, `cheerio`, `csv-writer`, `googleapis`.
- Development dependencies remain: `eslint`, `jest`, `prettier`.
- `npm audit --package-lock-only --omit=dev` was attempted in this environment but the npm registry could not be resolved (`EAI_AGAIN`), so vulnerability status is **NOT VERIFIED** here.
- The generated `SBOM.json` inventories the locked dependency graph and available license metadata.