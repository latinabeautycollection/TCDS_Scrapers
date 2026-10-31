/**
 * src/utils/sqlExport.js
 *
 * Generates a SQL file containing one `select arb.ingest_listing(...)` call
 * per scraped record, ready for Postgres / Supabase ingestion.
 *
 * Argument order (must not change):
 *   source, external_id, title, condition, current_price, auction_end_time,
 *   estimated_shipping, location, image_urls_array, full_json_payload::jsonb,
 *   classification_tag, brand, model, variant
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';

// ─── SQL escape helpers ──────────────────────────────────────────────────────

/**
 * Escape a string for Postgres single-quoted literals.
 * Doubles every single-quote and strips null bytes.
 */
function escSql(str) {
  if (str == null) return '';
  return String(str).replace(/\0/g, '').replace(/'/g, "''");
}

/**
 * Single-quoted string literal, or NULL for null/undefined/empty-string.
 */
function sqlStr(val) {
  if (val == null || val === '') return 'NULL';
  return `'${escSql(val)}'`;
}

/**
 * Bare numeric literal, or NULL.
 */
function sqlNum(val) {
  if (val == null) return 'NULL';
  const n = Number(val);
  return Number.isFinite(n) ? String(n) : 'NULL';
}

/**
 * ISO timestamp string literal with trailing Z, or NULL.
 */
function sqlTimestamp(val) {
  if (!val) return 'NULL';
  const d = new Date(val);
  if (isNaN(d.getTime())) return 'NULL';
  return `'${d.toISOString()}'`;
}

/**
 * Postgres text[] ARRAY literal.
 * Empty/missing array → ARRAY[]::text[] (never NULL).
 */
function sqlTextArray(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return 'ARRAY[]::text[]';
  const elems = arr.map((s) => `'${escSql(s)}'`);
  return `ARRAY[${elems.join(',')}]`;
}

/**
 * Postgres jsonb literal: '{"key":"val"}'::jsonb, or NULL.
 */
function sqlJsonb(obj) {
  if (obj == null) return 'NULL';
  const json = JSON.stringify(obj);
  return `'${escSql(json)}'::jsonb`;
}

// ─── Location resolver ──────────────────────────────────────────────────────

/**
 * Resolve location to a non-empty string or null.
 * Priority: record.location (if non-empty) → NULL.
 * Empty string is coerced to null (SQL NULL).
 */
function resolveLocation(record) {
  const loc = (record.location ?? '').trim();
  if (loc) return loc;
  return null;
}

// ─── Classification ─────────────────────────────────────────────────────────

/**
 * Console-indicating keywords. We require the title/category to reference
 * the *system/console* itself, not just a game *for* a console.
 */
const CONSOLE_KEYWORDS = [
  'playstation 4 console', 'playstation 5 console',
  'ps4 console', 'ps5 console',
  'xbox console', 'xbox series', 'xbox one console',
  'nintendo switch console', 'nintendo switch system',
  'rog ally',
];

/**
 * Patterns that indicate the item IS a console/system (not a game/accessory).
 * We check for the console keyword AND the absence of disqualifiers.
 */
const GAME_DISQUALIFIERS = [
  'for playstation', 'for ps4', 'for ps5',
  'for xbox', 'for nintendo',
  'playstation game', 'ps4 game', 'ps5 game',
  'xbox game', 'nintendo game',
];

/**
 * Phone brand keywords that indicate a smartphone listing.
 */
const PHONE_INDICATORS = [
  'iphone', 'pixel', 'galaxy s', 'galaxy z', 'galaxy a',
  'galaxy note', 'moto g', 'motorola', 'oneplus',
  'cell phone', 'smartphone', 'mobile phone',
];

/**
 * Derive a classification tag: 'phone', 'gaming_console', or 'general'.
 * Deterministic, conservative — never returns empty.
 */
export function classifyListing(record) {
  const title    = (record.title ?? '').toLowerCase();
  const category = (record.category ?? '').toLowerCase();
  const haystack = `${category} ${title}`;
  const attrs    = record.attributes ?? {};

  // ── Phone detection ──
  // Check for IMEI in attributes (strong signal)
  const hasImei = Object.keys(attrs).some((k) =>
    k.toLowerCase().includes('imei'),
  );
  if (hasImei) return 'phone';

  for (const kw of PHONE_INDICATORS) {
    if (haystack.includes(kw)) return 'phone';
  }

  // ── Gaming console detection ──
  // Must be an actual console/system, NOT a game FOR a console.
  // First check if any disqualifier is present (e.g. "for Playstation 5")
  const isGameForConsole = GAME_DISQUALIFIERS.some((d) => haystack.includes(d));
  if (!isGameForConsole) {
    // Check for console keywords
    for (const kw of CONSOLE_KEYWORDS) {
      if (haystack.includes(kw)) return 'gaming_console';
    }
    // Category-level: "Gaming Systems & Games" with system-like title words
    if (category.includes('gaming systems')) {
      const systemWords = ['console', 'system', 'bundle', 'playstation', 'xbox', 'switch'];
      if (systemWords.some((w) => title.includes(w))) return 'gaming_console';
    }
  }

  return 'general';
}

// ─── Brand / Model / Variant extraction ─────────────────────────────────────

/**
 * Extract brand from attributes only (no title heuristic).
 */
function extractBrand(record) {
  const attrs = record.attributes ?? {};
  const val = attrs.Brand ?? attrs.brand ?? null;
  if (val) return String(val).trim();
  return null;
}

/**
 * Extract model from attributes only.
 * Priority: Model name > Model > Model number
 */
function extractModel(record) {
  const attrs = record.attributes ?? {};
  for (const key of ['Model name', 'Model', 'Model number']) {
    if (attrs[key]) return String(attrs[key]).trim();
  }
  return null;
}

/**
 * Extract variant (storage/capacity) from attributes or title.
 * Normalises whitespace and casing: "128 GB" → "128GB", "1 tb" → "1TB".
 */
function extractVariant(record) {
  const attrs = record.attributes ?? {};
  // Check attribute keys
  for (const key of ['Storage', 'storage', 'Capacity', 'capacity', 'Size', 'Memory']) {
    const v = attrs[key];
    if (v && /\d+\s*(GB|TB)/i.test(String(v))) {
      return normalizeStorage(String(v).trim());
    }
  }
  // Fallback: parse from title
  const m = (record.title ?? '').match(/\b(\d{2,4}\s*(?:GB|TB))\b/i);
  if (m) return normalizeStorage(m[1]);
  return null;
}

/**
 * "128 GB" → "128GB", "1 tb" → "1TB"
 */
function normalizeStorage(s) {
  return s.replace(/\s+/g, '').toUpperCase();
}

// ─── Price resolver ─────────────────────────────────────────────────────────

/**
 * Resolve price: prefer attributes.prices.current_bid (if numeric & non-null),
 * else record.current_price, else NULL.
 */
function resolvePrice(record) {
  const currentBid = record.attributes?.prices?.current_bid;
  if (currentBid != null && Number.isFinite(Number(currentBid))) {
    return Number(currentBid);
  }
  if (record.current_price != null && Number.isFinite(Number(record.current_price))) {
    return Number(record.current_price);
  }
  return null;
}

// ─── Validation ─────────────────────────────────────────────────────────────

/**
 * Validate a record before SQL generation. Returns an error string or null.
 * Accepts both canonical and Supabase alias field names.
 */
function validateRecord(record) {
  if (!record.external_id && !record.listing_external_id) return 'missing external_id';
  if (!record.title) return 'missing title';
  if (!record.auction_end_time && !record.end_time) return 'missing auction_end_time';
  if (!Array.isArray(record.image_urls) && !Array.isArray(record.photo_urls)) return 'image_urls is not an array';
  return null;
}

// ─── SQL builder ─────────────────────────────────────────────────────────────

/**
 * Build a single `select arb.ingest_listing(...)` SQL statement.
 * Prefers Supabase alias field names (with fallback to canonical names).
 */
export function buildSqlIngestCall(record) {
  const source            = sqlStr('propertyroom');
  const externalId        = sqlStr(record.listing_external_id ?? record.external_id);
  const title             = sqlStr(record.title);
  const condition         = sqlStr(record.condition_text ?? record.condition);
  const price             = sqlNum(resolvePrice(record));
  const auctionEndTime    = sqlTimestamp(record.end_time ?? record.auction_end_time);
  const estimatedShipping = sqlNum(record.inbound_shipping_usd ?? record.estimated_shipping);
  const location          = sqlStr(resolveLocation(record));
  const imageUrls         = sqlTextArray(record.photo_urls ?? record.image_urls);
  const fullPayload       = sqlJsonb(record);
  const classificationTag = sqlStr(classifyListing(record));
  const brand             = sqlStr(extractBrand(record));
  const model             = sqlStr(extractModel(record));
  const variant           = sqlStr(extractVariant(record));

  return [
    `select arb.ingest_listing(`,
    `  ${source},`,
    `  ${externalId},`,
    `  ${title},`,
    `  ${condition},`,
    `  ${price},`,
    `  ${auctionEndTime},`,
    `  ${estimatedShipping},`,
    `  ${location},`,
    `  ${imageUrls},`,
    `  ${fullPayload},`,
    `  ${classificationTag},`,
    `  ${brand},`,
    `  ${model},`,
    `  ${variant}`,
    `);`,
  ].join('\n');
}

// ─── File writer ─────────────────────────────────────────────────────────────

/**
 * Export all dataset records to a SQL file containing ingest_listing calls.
 * Records are sorted by external_id ASC for deterministic output.
 * Invalid records are skipped with a warning.
 */
export async function exportDatasetToSql(records, opts = {}) {
  const {
    outputDir = path.resolve('output'),
    fileName  = 'propertyroom_ingest.sql',
    log       = console,
  } = opts;

  if (!records || records.length === 0) {
    log.info?.('[sql-export] No records to export — skipping SQL.');
    return null;
  }

  // Validate and filter
  const valid = [];
  for (const r of records) {
    const err = validateRecord(r);
    if (err) {
      log.warning?.(`[sql-export] Skipping record: ${err} — ${r.external_id ?? '(no id)'}`);
    } else {
      valid.push(r);
    }
  }

  if (valid.length === 0) {
    log.info?.('[sql-export] No valid records after validation — skipping SQL.');
    return null;
  }

  // Sort by external_id ASC for deterministic output
  valid.sort((a, b) => (a.external_id ?? '').localeCompare(b.external_id ?? ''));

  // Ensure output directory exists
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
    log.info?.(`[sql-export] Created output directory: ${outputDir}`);
  }

  const filePath = path.join(outputDir, fileName);

  // Exactly 3 header comment lines
  const header = [
    '-- PropertyRoom ingest SQL',
    `-- Generated: ${new Date().toISOString()}`,
    `-- Records: ${valid.length}`,
    '',
  ].join('\n');

  const statements = valid.map((r) => buildSqlIngestCall(r));
  const sql = header + statements.join('\n\n') + '\n';

  writeFileSync(filePath, sql, 'utf-8');

  log.info?.(`[sql-export] SQL written: ${filePath}  (${valid.length} statements)`);

  // Log a sample statement for verification
  if (valid.length > 0 && log.info) {
    log.info(`[sql-export] Sample statement:\n${statements[0]}`);
  }

  return filePath;
}

// ─── Self-test assertions ────────────────────────────────────────────────────

/**
 * Run inline assertions to verify SQL export correctness.
 * Called via: node src/utils/sqlExport.js --self-test
 */
export function runSelfTests() {
  const assert = (cond, msg) => {
    if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  };

  // 1. Empty-string location → NULL
  assert(sqlStr('') === 'NULL', 'empty string should become NULL');
  assert(sqlStr(null) === 'NULL', 'null should become NULL');
  assert(sqlStr('Ronkonkoma, NY') === "'Ronkonkoma, NY'", 'non-empty location should be quoted');

  // 2. SQL escaping for apostrophes
  assert(escSql("O'Brien") === "O''Brien", 'single quote should be doubled');
  assert(sqlStr("Kid's Toy") === "'Kid''s Toy'", 'sqlStr should escape quotes');

  // 3. Classification: "NBA 2K24 For Playstation 5" → NOT gaming_console
  const gameRecord = {
    title: 'NBA 2K24 For Playstation 5',
    category: 'Gaming Systems & Games',
    attributes: {},
  };
  assert(
    classifyListing(gameRecord) === 'general',
    `game-for-console should be 'general', got '${classifyListing(gameRecord)}'`,
  );

  // 4. Classification: actual console → gaming_console
  const consoleRecord = {
    title: 'Sony Playstation 5 Console 825GB',
    category: 'Gaming Systems & Games',
    attributes: {},
  };
  assert(
    classifyListing(consoleRecord) === 'gaming_console',
    `actual console should be 'gaming_console', got '${classifyListing(consoleRecord)}'`,
  );

  // 5. Classification: iPhone → phone
  const phoneRecord = {
    title: 'Apple iPhone 14 Pro 128GB',
    category: 'iPhone & iPod',
    attributes: {},
  };
  assert(
    classifyListing(phoneRecord) === 'phone',
    `iPhone should be 'phone', got '${classifyListing(phoneRecord)}'`,
  );

  // 6. Classification: IMEI in attributes → phone
  const imeiRecord = {
    title: 'Some Random Device',
    category: 'Electronics',
    attributes: { 'IMEI Number': '123456789' },
  };
  assert(
    classifyListing(imeiRecord) === 'phone',
    `IMEI record should be 'phone', got '${classifyListing(imeiRecord)}'`,
  );

  // 7. Classification: Pixel phone → phone
  const pixelRecord = {
    title: 'Google Pixel 8 Pro',
    category: 'Cell Phones',
    attributes: {},
  };
  assert(
    classifyListing(pixelRecord) === 'phone',
    `Pixel should be 'phone', got '${classifyListing(pixelRecord)}'`,
  );

  // 8. Classification: game accessory → general
  const accessoryRecord = {
    title: 'PS5 Controller DualSense',
    category: 'Gaming Accessories',
    attributes: {},
  };
  assert(
    classifyListing(accessoryRecord) === 'general',
    `accessory should be 'general', got '${classifyListing(accessoryRecord)}'`,
  );

  // 9. Empty image array → ARRAY[]::text[]
  assert(
    sqlTextArray([]) === 'ARRAY[]::text[]',
    'empty image array should be ARRAY[]::text[]',
  );

  // 10. Price resolution: prefer current_bid
  const bidRecord = {
    current_price: 100,
    attributes: { prices: { current_bid: 55 } },
  };
  assert(resolvePrice(bidRecord) === 55, 'should prefer current_bid over current_price');

  // 11. Price resolution: fall back to current_price
  const noBidRecord = {
    current_price: 100,
    attributes: { prices: { current_bid: null } },
  };
  assert(resolvePrice(noBidRecord) === 100, 'should fall back to current_price');

  // 12. Variant normalisation
  assert(normalizeStorage('128 GB') === '128GB', '"128 GB" should become "128GB"');
  assert(normalizeStorage('1 tb') === '1TB', '"1 tb" should become "1TB"');

  // 13. Validation
  assert(validateRecord({ external_id: 'x', title: 't', auction_end_time: 'a', image_urls: [] }) === null, 'valid record');
  assert(validateRecord({ title: 't', auction_end_time: 'a', image_urls: [] }) === 'missing external_id', 'missing id');
  assert(validateRecord({ external_id: 'x', title: 't', auction_end_time: 'a', image_urls: 'bad' }) === 'image_urls is not an array', 'bad images');

  // 14. Full SQL statement: location empty → NULL, not ''
  const fullRecord = {
    source: 'propertyroom',
    external_id: 'propertyroom-99999',
    title: "Test Item",
    category: 'General',
    condition: 'Used',
    current_price: 10,
    estimated_shipping: 5,
    auction_end_time: '2026-03-15T18:00:00.000Z',
    location: '',
    image_urls: [],
    attributes: {},
    scraped_at: '2026-03-04T12:00:00.000Z',
  };
  const stmt = buildSqlIngestCall(fullRecord);
  assert(!stmt.includes("'',"), 'empty location should not appear as empty-string literal');
  assert(stmt.includes('NULL,'), 'empty location should appear as NULL');
  assert(stmt.includes('ARRAY[]::text[]'), 'empty images should be ARRAY[]::text[]');

  // 15. Supabase alias fields are preferred by SQL builder
  const aliasedRecord = {
    source: 'propertyroom',
    external_id: 'propertyroom-11111',
    listing_external_id: 'propertyroom-11111',
    title: "Alias Test",
    condition: 'Fair',
    condition_text: 'Fair',
    current_price: 50,
    estimated_shipping: 10,
    inbound_shipping_usd: 10,
    inbound_tax_usd: null,
    inbound_fees_usd: 0,
    buyers_premium: 0,
    buy_now_price: null,
    auction_end_time: '2026-04-01T12:00:00.000Z',
    end_time: '2026-04-01T12:00:00.000Z',
    location: 'Dallas, TX',
    image_urls: ['https://example.com/1.jpg'],
    photo_urls: ['https://example.com/1.jpg'],
    attributes: {},
    scraped_at: '2026-03-05T12:00:00.000Z',
  };
  const aliasStmt = buildSqlIngestCall(aliasedRecord);
  assert(aliasStmt.includes("'propertyroom-11111'"), 'listing_external_id should be used');
  assert(aliasStmt.includes("'Fair'"), 'condition_text should be used');
  assert(aliasStmt.includes("'2026-04-01T12:00:00.000Z'"), 'end_time should be used');
  assert(aliasStmt.includes("'Dallas, TX'"), 'location should be quoted');
  assert(aliasStmt.includes("'https://example.com/1.jpg'"), 'photo_urls should be used');

  // 16. Supabase alias fields in JSON payload
  assert(aliasStmt.includes('"listing_external_id"'), 'jsonb payload should contain listing_external_id');
  assert(aliasStmt.includes('"condition_text"'), 'jsonb payload should contain condition_text');
  assert(aliasStmt.includes('"end_time"'), 'jsonb payload should contain end_time');
  assert(aliasStmt.includes('"inbound_shipping_usd"'), 'jsonb payload should contain inbound_shipping_usd');
  assert(aliasStmt.includes('"inbound_tax_usd"'), 'jsonb payload should contain inbound_tax_usd');
  assert(aliasStmt.includes('"inbound_fees_usd"'), 'jsonb payload should contain inbound_fees_usd');
  assert(aliasStmt.includes('"photo_urls"'), 'jsonb payload should contain photo_urls');
  assert(aliasStmt.includes('"buy_now_price"'), 'jsonb payload should contain buy_now_price');

  // 17. Validation accepts alias-only records
  assert(validateRecord({ listing_external_id: 'x', title: 't', end_time: 'a', photo_urls: [] }) === null, 'alias-only record should be valid');

  console.log('✅ All 17 self-test assertions passed.');
}

// ─── CLI self-test entry point ───────────────────────────────────────────────

if (process.argv.includes('--self-test')) {
  runSelfTests();
}