# PropertyRoom & eBay Data Pipeline — Apify Actor

Production-grade Apify Actor that:

1. **Milestone 1** — Crawls [PropertyRoom.com](https://www.propertyroom.com) auction listings using `PlaywrightCrawler`
2. **Milestone 2** — Delivers normalised records via configurable webhook pipeline (batching, retries, dead-letter store)
3. **Milestone 3** — Fetches eBay listings via the official Browse API and sold comparables via the Finding API

All results are normalised to a single canonical JSON schema and written to an Apify Dataset for permanent storage.

---

## Table of Contents

- [Milestone 1 — PropertyRoom Scraper](#milestone-1--propertyroom-scraper)
- [Architecture Overview](#architecture-overview)
- [Project Structure](#project-structure)
- [Output Schema](#output-schema)
- [How to Run Locally](#how-to-run-locally)
- [Input Configuration](#input-configuration)
- [Modifying Categories & Keywords](#modifying-categories--keywords)
- [Webhook Delivery (M2)](#webhook-delivery-m2)
- [eBay Integration (M3)](#ebay-integration-m3)
- [Deploying on Apify](#deploying-on-apify)
- [Scaling Safely](#scaling-safely)
- [Scheduling Runs](#scheduling-runs)
- [Test Plan](#test-plan)
- [Assumptions & Decisions](#assumptions--decisions)

---

## Milestone 1 — PropertyRoom Scraper

### What is extracted

The PropertyRoom actor crawls category, search, and listing detail pages on [propertyroom.com](https://www.propertyroom.com). For each auction listing it extracts:

| Field | Source on PropertyRoom | Notes |
|---|---|---|
| `title` | JS var `LISTING_TITLE`, `<h1>`, og:title | Most reliable from JS |
| `external_id` | JS var `LISTING_ID`, URL `/l/.../18566038` | Stable, always `propertyroom-{id}` |
| `category` | Breadcrumb last link (e.g. `iPhone & iPod`) | From `a[href*="/c/"]` |
| `condition` | `<li>Physical Condition: Good</li>` or body text | Label-based extraction |
| `description` | `.bodyContent` div | Freeform text |
| `current_price` | `#MainContent_uxPrice` + label classification | Priority: buy_now > current_bid > starting_bid |
| `estimated_shipping` | Shipping slot IDs (Standard, Expedited) | Lowest applicable non-pickup option |
| `buyers_premium` | Text near "Buyer's Premium" | Often not shown; defaults to 0 |
| `auction_end_time` | "Ends Mar 05, 2026 at 10:06 PM (Eastern)" | Parsed to ISO 8601 UTC |
| `location` | "Shipping From: City, ST" or pickup text fallback | Falls back to "warehouse in City, State" |
| `image_urls` | `.sp-wrap img` (smoothproducts carousel) | Collected across all selectors, deduped |
| `attributes` | `<li>Key: Value</li>` items, tables, dl/dt/dd | Multi-strategy, filters junk |
| `scraped_at` | Set at normalisation time | ISO 8601 UTC |

### Assumptions

- **Lot numbers**: PropertyRoom does not use lot numbers. `lotNumber` is `null` unless a `<li>Lot: NNN</li>` is found on the page. The `external_id` is always based on the numeric listing ID from the URL or JS variable.
- **Buyer's premium**: Most PropertyRoom listings reference buyer's premium only as a help-article link without showing an explicit dollar amount. The field defaults to `0` when not detectable.
- **Image extraction**: Network requests for image files are blocked to speed up crawling, but `<img src="...">` attributes are read from the DOM. The `.sp-wrap` carousel is the primary image source.
- **Validation**: Every record is schema-validated before saving. Invalid records are logged and skipped (the run continues).

### How to run locally

```bash
# 1. Install dependencies
npm install

# 2. Create INPUT file
mkdir -p storage/key_value_stores/default
cat > storage/key_value_stores/default/INPUT.json << 'EOF'
{
  "startUrls": [{ "url": "https://www.propertyroom.com/c/electronics" }],
  "maxPages": 1,
  "maxConcurrency": 1,
  "proxyEnabled": false,
  "debug": true
}
EOF

# 3. Run the actor
npx apify-cli run

# 4. Check output
ls storage/datasets/default/
cat storage/datasets/default/*.json | head -100
```

### How to increase maxPages safely

| `maxPages` | `maxConcurrency` | Proxy | Notes |
|---|---|---|---|
| 1–3 | 1 | Off | Local testing |
| 5–10 | 2–3 | Residential | Light production run |
| 10–50 | 3–5 | Residential | Full category crawl |
| 0 (unlimited) | 3 | Residential | Complete scrape — monitor memory |

Always use Residential proxies (`"proxyEnabled": true`) for production runs. PropertyRoom actively detects datacenter IPs.

### Milestone 1 output + CSV export

#### Structured attributes

Each record's `attributes` object contains these computed fields in addition to item-specific attributes:

| Attribute key | Type | Description |
|---|---|---|
| `price_source` | `string` | `"buy_now"`, `"current_bid"`, `"starting_bid"`, or `"unknown"` |
| `prices` | `object` | `{ buy_now_price, current_bid, starting_bid }` — each `number\|null` |
| `shipping_options` | `array` | `[{ method, price, applicable }]` — all 3 PropertyRoom slots |
| `total_cost` | `number` | `current_price + estimated_shipping + buyers_premium` |
| `currency` | `string` | Always `"USD"` |
| `location_source` | `string` | `"label"`, `"pickup_text"`, or `"none"` |
| `description_clean` | `string` | Item-specific description with boilerplate stripped |

#### Location extraction

Location is extracted using a 3-strategy fallback:

1. **Label** — `"Shipping From: Ronkonkoma, NY"` (most common)
2. **Pickup text** — `"Pick-up ... at our warehouse in City, State"` parsed via regex
3. **CSS selectors** — `[itemprop="addressLocality"]` etc.

#### CSV export

After each crawl, a CSV file is automatically written to `./output/propertyroom_export.csv` with flattened columns:

```
source, external_id, title, category, condition, current_price,
estimated_shipping, buyers_premium, auction_end_time, location,
image_urls, description, price_source, buy_now_price, current_bid,
starting_bid, total_cost, currency, location_source, shipping_options,
description_clean, attributes, scraped_at
```

CSV export is enabled by default (`csvExportEnabled: true`). Configure via INPUT:

```json
{
  "csvExportEnabled": true,
  "csvOutputDir": "./output",
  "csvFileName": "propertyroom_export.csv"
}
```

Optional Google Sheets integration is also available — see `googleSheetId` in INPUT_SCHEMA.json.

#### SQL ingest export

After each crawl, a SQL file is generated at `./output/propertyroom_ingest.sql` containing one `select arb.ingest_listing(...)` call per record, sorted by `external_id` ASC. Pipe directly into Postgres:

```bash
psql -U your_user -d your_db -f output/propertyroom_ingest.sql
```

Each statement maps scraped fields to the `arb.ingest_listing` function signature:

```
source, external_id, title, condition, current_price, auction_end_time,
estimated_shipping, location, image_urls_array, full_json_payload::jsonb,
classification_tag, brand, model, variant
```

Field mapping:
- **current_price** — prefers `attributes.prices.current_bid` if present, else `record.current_price` (numeric, no quotes)
- **location** — `record.location` if non-empty, else `NULL` (never empty string)
- **image_urls_array** — Postgres `ARRAY['url1','url2',...]` literal; empty → `ARRAY[]::text[]`
- **full_json_payload** — full record as `'...'::jsonb`
- **classification_tag** — deterministic: `phone`, `gaming_console`, or `general`
  - `phone`: title/category contains iPhone, Pixel, Samsung Galaxy, cell phone, etc. or attributes contain IMEI
  - `gaming_console`: actual console/system only (not games FOR a console — "NBA 2K24 For PS5" → `general`)
- **brand** — from `attributes.Brand` only, else `NULL`
- **model** — `attributes["Model name"]` > `attributes.Model` > `attributes["Model number"]`, else `NULL`
- **variant** — storage capacity normalised (e.g. `128GB`), else `NULL`

SQL export is enabled by default when `debug: true`. Configure via INPUT:

```json
{
  "sqlExportEnabled": true,
  "sqlOutputDir": "./output",
  "sqlFileName": "propertyroom_ingest.sql"
}
```

You can also run the built-in self-test assertions:

```bash
node src/utils/sqlExport.js --self-test
```

Example output (jsonb payloads truncated):

```sql
-- phone with brand/model/variant extraction
select arb.ingest_listing(
  'propertyroom',
  'propertyroom-18504614',
  'Apple Cell phone MYW53LL/A',
  'Used',
  599,
  '2026-03-09T21:00:00.000Z',
  15,
  NULL,
  ARRAY['https://content.propertyroom.com/...img1.webp','...img2.webp'],
  '{"source":"propertyroom",...}'::jsonb,
  'phone',
  'Apple',
  'iPhone 16 Pro Max',
  '256GB'
);

-- gaming_console: actual ROG Ally system
select arb.ingest_listing(
  'propertyroom',
  'propertyroom-18469804',
  'Asus System RC71L',
  'Used',
  399,
  '2026-03-06T06:00:00.000Z',
  20,
  NULL,
  ARRAY['https://content.propertyroom.com/...img1.webp'],
  '{"source":"propertyroom",...}'::jsonb,
  'gaming_console',
  'Asus',
  'RC71L',
  '512GB'
);

-- general: game FOR a console (not a console itself)
select arb.ingest_listing(
  'propertyroom',
  'propertyroom-18566188',
  'NBA 2K24 For Playstation 5',
  'New in box',
  1,
  '2026-03-05T23:57:00.000Z',
  16.95,
  'Ronkonkoma, NY',
  ARRAY['https://content.propertyroom.com/...img1.jpg'],
  '{"source":"propertyroom",...}'::jsonb,
  'general',
  NULL,
  NULL,
  NULL
);

-- general with location
select arb.ingest_listing(
  'propertyroom',
  'propertyroom-18566037',
  'Xfinity Outdoor Home Security Camera White',
  'New',
  1,
  '2026-03-06T00:45:00.000Z',
  16.95,
  'Ontario, CA',
  ARRAY['https://content.propertyroom.com/...img1.jpg'],
  '{"source":"propertyroom",...}'::jsonb,
  'general',
  NULL,
  NULL,
  NULL
);

-- general without location (NULL, not empty string)
select arb.ingest_listing(
  'propertyroom',
  'propertyroom-18509247',
  'Sony Camcorder FDR-AX700 Exmor R5',
  'Used',
  1199,
  '2026-03-05T20:00:00.000Z',
  20,
  NULL,
  ARRAY['https://content.propertyroom.com/...img1.webp'],
  '{"source":"propertyroom",...}'::jsonb,
  'general',
  'Sony',
  'Exmor R5',
  NULL
);
```

---

## Architecture Overview

```
main.js
  │
  ├── DedupeManager (cross-run KV store + in-memory Set)
  ├── WebhookManager (buffered POST with retry + DLQ)
  │
  ├── M1: createPropertyRoomCrawler()
  │     PlaywrightCrawler
  │       ├── Index pages → collect detail URLs, paginate
  │       └── Detail pages → multi-strategy extraction → normalize → dedupe → save
  │
  └── M3: fetchEbayListings()
        ├── Browse API → active listings → normalize → dedupe → save
        └── Finding API → sold comps (optional) → normalize → dedupe → save
```

Each saved record is written to:
- **Apify Dataset** (always, canonical log)
- **Webhook endpoint** (if `webhookUrl` is set)

---

## Project Structure

```
.
├── main.js                        # Actor entry point
├── INPUT_SCHEMA.json              # Apify input validation schema
├── package.json
├── .actor/
│   └── actor.json                 # Apify platform metadata
└── src/
    ├── extractors/
    │   ├── propertyroom.js        # M1: PlaywrightCrawler + multi-strategy extraction
    │   └── ebay.js                # M3: Browse API + Finding API
    └── utils/
        ├── normalize.js           # Schema validation, type coercion, date parsing
        ├── export.js              # CSV + Google Sheets export
        ├── sqlExport.js           # SQL ingest file export (arb.ingest_listing)
        ├── webhook.js             # M2: Batched POST, retry, dead-letter store
        ├── dedupe.js              # In-run Set + cross-run KV deduplication
        └── logging.js             # Structured logger + run-level stats counters
```

---

## Output Schema

Every record written to the Dataset (and POSTed via webhook) matches:

```json
{
  "source":             "propertyroom",
  "external_id":        "propertyroom-12345678",
  "title":              "Vintage Oak Dining Table",
  "category":           "Furniture",
  "condition":          "Used",
  "description":        "Solid oak, seats 6...",
  "current_price":      450.00,
  "estimated_shipping": 75.00,
  "buyers_premium":     15.00,
  "auction_end_time":   "2025-03-15T18:00:00.000Z",
  "location":           "Dallas, TX",
  "image_urls":         ["https://cdn.propertyroom.com/...jpg"],
  "attributes": {
    "Listing ID":    "98765",
    "auction_id":    "98765",
    "Brand":         "Vintage",
    "Material":      "Oak",
    "price_source":  "current_bid",
    "prices":        { "buy_now_price": null, "current_bid": 450, "starting_bid": null },
    "shipping_options": [
      { "method": "Standard Shipping", "price": 75, "applicable": true }
    ],
    "total_cost":    540,
    "currency":      "USD",
    "location_source": "label",
    "description_clean": "Solid oak dining table, seats 6..."
  },
  "scraped_at":         "2025-02-26T10:30:00.000Z"
}
```

**Field rules:**
- `current_price`, `estimated_shipping`, `buyers_premium` — `number`, default `0`
- `auction_end_time`, `scraped_at` — ISO 8601 UTC strings
- `image_urls` — deduplicated array, no `data:` URIs
- `attributes` — flat `{string: string}` map plus structured keys: `prices`, `shipping_options`, `total_cost`, `currency`, `price_source`, `location_source`, `description_clean`

For eBay records, `source` is `"ebay"` and `external_id` is `"ebay-<itemId>"` (or `"ebay-sold-<itemId>"` for Finding API sold comps).

---

## How to Run Locally

### Prerequisites

```bash
node --version   # >= 18.0.0
npm install
```

### Run with Apify CLI

```bash
npm install -g apify-cli
apify login       # enter your API token
apify run         # uses INPUT from storage/key_value_stores/default/INPUT.json
```

### Create a local INPUT file

```bash
mkdir -p storage/key_value_stores/default
```

Create `storage/key_value_stores/default/INPUT.json`:

```json
{
  "startUrls": [
    { "url": "https://www.propertyroom.com/l" }
  ],
  "keywords": ["vintage chair"],
  "maxPages": 2,
  "maxConcurrency": 2,
  "proxyEnabled": false,
  "debug": true
}
```

```bash
apify run
```

Outputs appear in `storage/datasets/default/`.

---

## Input Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `startUrls` | `URL[]` | `[]` | PropertyRoom category / search page URLs |
| `keywords` | `string[]` | `[]` | Auto-generates search URLs |
| `maxPages` | `integer` | `10` | Pages per category/search (`0` = unlimited) |
| `maxConcurrency` | `integer` | `3` | Parallel browser pages |
| `requestTimeoutSecs` | `integer` | `60` | Per-page timeout |
| `maxRequestRetries` | `integer` | `3` | Retries before giving up |
| `proxyEnabled` | `boolean` | `true` | Use Apify Residential proxies |
| `proxyGroups` | `string[]` | `["RESIDENTIAL"]` | Proxy groups |
| `debug` | `boolean` | `false` | Verbose logging |
| `webhookUrl` | `string` | `null` | Webhook POST endpoint |
| `webhookAuthToken` | `string` | `null` | Bearer token for webhook auth |
| `webhookBatchSize` | `integer` | `10` | Records per webhook POST |
| `webhookMaxRetries` | `integer` | `5` | Webhook retry limit |
| `ebayEnabled` | `boolean` | `false` | Enable eBay integration |
| `ebayClientId` | `string` | `null` | eBay App ID / OAuth Client ID |
| `ebayClientSecret` | `string` | `null` | eBay OAuth Client Secret |
| `ebayEnvironment` | `string` | `"production"` | `"production"` or `"sandbox"` |
| `ebayQueries` | `string[]` | `[]` | eBay keyword searches |
| `ebayCategoryIds` | `string[]` | `[]` | eBay category IDs |
| `ebayMaxResults` | `integer` | `1000` | Max eBay results per query |
| `ebayIncludeSoldComps` | `boolean` | `false` | Include sold comparables |
| `csvExportEnabled` | `boolean` | `true` | Auto-export CSV after crawl |
| `csvOutputDir` | `string` | `"./output"` | CSV output directory |
| `csvFileName` | `string` | `"propertyroom_export.csv"` | CSV file name |
| `googleSheetId` | `string` | `null` | Google Sheet spreadsheet ID |
| `googleSheetName` | `string` | `"Sheet1"` | Google Sheet tab name |
| `googleServiceAccountKey` | `string` | `null` | Google service account JSON key |
| `sqlExportEnabled` | `boolean` | `debug` | Auto-export SQL ingest file after crawl |
| `sqlOutputDir` | `string` | `"./output"` | SQL output directory |
| `sqlFileName` | `string` | `"propertyroom_ingest.sql"` | SQL file name |

---

## Modifying Categories & Keywords

### Option A — Use `startUrls` for specific category pages

Navigate to the category on PropertyRoom, copy the URL, and add it to `startUrls`:

```json
{
  "startUrls": [
    { "url": "https://www.propertyroom.com/c/antiques-furniture" },
    { "url": "https://www.propertyroom.com/c/jewelry-watches" }
  ]
}
```

### Option B — Use `keywords` for keyword searches

```json
{
  "keywords": ["vintage lamp", "art deco mirror", "MCM dresser"]
}
```

Both options can be used simultaneously. `maxPages` controls depth per source.

### Adding eBay categories

Find eBay category IDs at:
`https://www.ebay.com/sch/allcategories/all-categories`

```json
{
  "ebayEnabled": true,
  "ebayCategoryIds": ["20081", "11116"],
  "ebayQueries": ["antique furniture", "vintage watch"]
}
```

---

## Webhook Delivery (M2)

When `webhookUrl` is set, each flush sends:

```http
POST https://your-endpoint.com/items
Authorization: Bearer <webhookAuthToken>
Content-Type: application/json

{
  "records": [ ...up to webhookBatchSize normalised records... ],
  "count": 10
}
```

**Retry policy:**
- Retries on `429` and `5xx` with full-jitter exponential back-off
- Base delay: 1 s, cap: 60 s
- After `webhookMaxRetries` failures, batch is stored in KV store under `WEBHOOK_DLQ_<timestamp>_<n>`

**Dead-letter replay:**
Failed batches are stored and can be replayed by calling `webhookManager.replayDeadLetter()` at the start of a subsequent run. The DLQ key prefix is `WEBHOOK_DLQ_`.

**To test without a real endpoint:**
Use [webhook.site](https://webhook.site) — paste the generated URL as `webhookUrl` and set `webhookAuthToken` to anything. Leave `webhookBatchSize: 1` for item-by-item visibility.

**To disable webhook:**
Simply omit `webhookUrl` or set it to `null`. All records still go to the Apify Dataset.

---

## eBay Integration (M3)

### Setup

1. Create a developer account at [developer.ebay.com](https://developer.ebay.com)
2. Create an application — note the **App ID (Client ID)** and **Client Secret**
3. Set input:

```json
{
  "ebayEnabled": true,
  "ebayClientId": "YourApp-SandboxID-...",
  "ebayClientSecret": "SBX-...",
  "ebayEnvironment": "sandbox",
  "ebayQueries": ["vintage watch"],
  "ebayMaxResults": 50
}
```

### APIs used

| API | Purpose | Auth |
|-----|---------|------|
| Browse API `/item_summary/search` | Active listings | OAuth 2.0 client credentials |
| Finding API `findCompletedItems` | Sold comps | App ID header |

### Rate limits

- Browse API: 5,000 calls/day on free tier
- Finding API: 5,000 calls/day
- The actor pages at 200 (Browse) / 100 (Finding) items per call, so 1,000 results = 5–10 API calls

### Error handling

- Auth failures throw immediately with a clear message
- Per-page errors are logged and skipped (run continues)
- Rate limit (`429`) triggers retry with back-off

---

## Deploying on Apify

### 1. Push with Apify CLI

```bash
apify login
apify push
```

This creates or updates an actor in your Apify account.

### 2. Configure via Apify Console

1. Open the actor in the Apify Console
2. Click **Input** — all fields from `INPUT_SCHEMA.json` appear as a UI form
3. Set sensitive fields (`webhookAuthToken`, `ebayClientSecret`) — they are masked (`isSecret: true`)
4. Click **Run**

### 3. Use the Apify API

```bash
curl -X POST \
  "https://api.apify.com/v2/acts/<YOUR_ACTOR_ID>/runs" \
  -H "Authorization: Bearer <YOUR_API_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "startUrls": [{"url": "https://www.propertyroom.com/l"}],
    "maxPages": 5,
    "webhookUrl": "https://your-endpoint.com/items"
  }'
```

---

## Scaling Safely

### Concurrency

| Environment | Recommended `maxConcurrency` |
|-------------|------------------------------|
| Local (no proxy) | 1–2 |
| Apify (Residential proxy) | 3–5 |
| Apify (Datacenter proxy, riskier) | 2–3 |

PropertyRoom has anti-bot measures. Keep concurrency low and always use Residential proxies in production.

### Proxies

The actor uses Apify Residential proxies by default (`proxyGroups: ["RESIDENTIAL"]`).

```json
{
  "proxyEnabled": true,
  "proxyGroups": ["RESIDENTIAL"]
}
```

To use datacenter proxies (cheaper, less reliable for anti-bot):
```json
{
  "proxyGroups": ["SHADER"]
}
```

To disable (local testing only):
```json
{
  "proxyEnabled": false
}
```

### Memory

Each Playwright page uses ~200–400 MB RAM. For `maxConcurrency: 3`, allocate at least **2 GB** in actor run settings.

### Large crawls (10,000+ items)

- Set `maxPages: 0` (unlimited) per search
- Use multiple `startUrls` for different categories in parallel runs
- Schedule incremental runs (see below) — cross-run deduplication handles overlaps

---

## Scheduling Runs

### On Apify (recommended)

1. Open the actor in Apify Console
2. Click **Schedules** → **New schedule**
3. Configure cron: `0 6 * * *` (daily at 6 AM UTC)
4. The cross-run deduplication via KV store ensures items seen in previous runs are skipped automatically

### eBay incremental pulls

eBay API doesn't support delta/changed-since queries. Run daily and rely on deduplication to skip unchanged `itemId`s. For price updates on existing items, consider storing the raw eBay record in `attributes` and comparing `current_price` in your downstream system.

---

## Test Plan

### 1 — Smoke test (small crawl)

```json
{
  "startUrls": [{ "url": "https://www.propertyroom.com/l" }],
  "maxPages": 1,
  "maxConcurrency": 1,
  "proxyEnabled": false,
  "debug": true
}
```

Expected: 10–30 items saved to Dataset. Check logs for extraction errors.

### 2 — JSON schema validation

Download the Dataset output and validate each record:

```bash
# Validate all records have required fields and correct types
node --input-type=module <<'EOF'
import { readFileSync } from 'fs';

const records = JSON.parse(readFileSync('./storage/datasets/default/000000001.json', 'utf8'));

for (const r of [].concat(records)) {
  console.assert(typeof r.source === 'string',          'source must be string');
  console.assert(typeof r.external_id === 'string',     'external_id must be string');
  console.assert(r.external_id.length > 0,              'external_id must not be empty');
  console.assert(typeof r.title === 'string',           'title must be string');
  console.assert(typeof r.current_price === 'number',   'current_price must be number');
  console.assert(typeof r.estimated_shipping === 'number', 'estimated_shipping must be number');
  console.assert(typeof r.buyers_premium === 'number',  'buyers_premium must be number');
  console.assert(Array.isArray(r.image_urls),           'image_urls must be array');
  console.assert(typeof r.attributes === 'object',      'attributes must be object');
  if (r.auction_end_time) {
    console.assert(!isNaN(new Date(r.auction_end_time)), 'auction_end_time must be valid date');
  }
  console.assert(!isNaN(new Date(r.scraped_at)),        'scraped_at must be valid date');
}
console.log('All schema assertions passed');
EOF
```

### 3 — Deduplication verification

Run the actor twice with the same `startUrls`. After the second run:

```bash
# Check KV store for DEDUPE_SEEN_IDS
apify key-value-stores get-record --key DEDUPE_SEEN_IDS
```

The second run's logs should show `items skipped (deduped)` matching approximately the first run's item count. Dataset item count after both runs should equal the first run's count (no duplicates).

### 4 — Webhook delivery verification

1. Go to [webhook.site](https://webhook.site) and copy your unique URL
2. Set `webhookUrl` to that URL, `webhookBatchSize: 1`
3. Run with `maxPages: 1`
4. Watch requests arrive at webhook.site in real-time
5. Verify each request has `Authorization: Bearer <token>` header
6. Verify body structure: `{ "records": [...], "count": 1 }`

### 5 — eBay integration

```json
{
  "ebayEnabled": true,
  "ebayClientId": "YourAppID-...",
  "ebayClientSecret": "SBX-...",
  "ebayEnvironment": "sandbox",
  "ebayQueries": ["watch"],
  "ebayMaxResults": 20
}
```

Check Dataset for records with `"source": "ebay"` and `external_id` starting with `"ebay-"`.

### 6 — Dead-letter replay

1. Intentionally set `webhookUrl` to an unreachable URL
2. Run with `webhookMaxRetries: 1`
3. After run, check KV store for `WEBHOOK_DLQ_*` keys
4. Update `webhookUrl` to a working endpoint
5. Call `webhookManager.replayDeadLetter()` (or trigger via a replay actor run)

---

## Assumptions & Decisions

| Decision | Rationale |
|----------|-----------|
| **PlaywrightCrawler** (not Puppeteer) | Playwright is the current Crawlee default and handles modern JS-heavy sites better |
| **ESM (`"type": "module"`)** | Modern Node.js best practice; Apify SDK v3 fully supports it |
| **`current_price` defaults to `0`** (not `null`) | Numeric fields should always be numbers; `0` means "not yet bid on / unknown", which is valid for auction listings |
| **`auction_end_time` defaults to `""`** (not `null`) | Consistent string type; empty string means unknown |
| **Resource blocking includes fonts & media** | Speeds up crawl significantly; image URLs are still captured from DOM `src` attributes before routing blocks network requests |
| **Cross-run dedupe cap at 100,000 IDs** | Prevents unbounded KV store growth; oldest IDs are evicted (LIFO). For datasets >100k items, consider a dedicated Redis/DB store |
| **eBay Browse API over Trading API** | Browse API is the modern, publicly-accessible read API. Trading API requires selling privileges |
| **Webhook dead-letter in KV** | Simple, no external dependencies. For high-volume production, replace with a proper queue (SQS, Pub/Sub) |
| **`proxyGroups: ["RESIDENTIAL"]`** | PropertyRoom detects datacenter IPs. Residential proxies are slower/more expensive but reliable |
| **`gotoOptions.waitUntil = 'domcontentloaded'`** | Faster than `networkidle`; detail pages are server-rendered, so DOM content is sufficient |
# aj-apify