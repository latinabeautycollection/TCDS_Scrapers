# TCDS auction scrapers

Source of the Apify actors that feed the arb intake (`apify-intake` → `arb.listings_raw`). This repo is the master copy: Apify builds each actor from its folder here, so change code here, not in the Apify web IDE.

| Folder | Apify actor | Site |
|---|---|---|
| `propertyroom-ebay-pipeline/` | `lbcscraper/propertyroom-ebay-pipeline` | PropertyRoom |
| `govdeals-actor/` | `lbcscraper/govdeals-actor` | GovDeals |
| `liquidation-actor/` | `lbcscraper/liquidation-actor` | Liquidation.com |
| `municibid-actor/` | `lbcscraper/municibid-actor` | Municibid |
| `publicsurplus-actor/` | `lbcscraper/publicsurplus-actor` | Public Surplus |
| `purplewave-discovery/` | `lbcscraper/purplewave-discovery` | Discovery tool (site/API probing), not a production scraper |

New scrapers (HiBid, Proxibid, ...) get their own folder in the same layout.

## Apify source setting

Each actor: **Source → Git repository**, URL `https://github.com/<owner>/tcds-scrapers#main:<folder>`, with the GitHub build webhook so a push to `main` rebuilds it.

## Rules

- No secrets in code. Webhook secret, Apify token and eBay keys are Apify secret inputs (`isSecret: true`) or env vars.
- Output must follow the *Scraper Output & Intake Integration Guide*: bid, shipping (`estimated_shipping` or `shipping_method` = `pickup_only` / `free_shipping` / `shipping_quote`, with `shipping_evidence`), auction start and end, description, MPN where published, full `source_record`.
- Work on a branch and open a pull request into `main`.
