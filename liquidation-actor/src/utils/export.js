/**
 * src/utils/export.js
 *
 * Enterprise export utilities for governed acquisition records.
 *
 * Supports:
 * - CSV export
 * - Google Sheets export
 * - profile-based column selection
 * - flattening of governed nested record structures
 * - audit/provenance-safe serialization
 */

import { createObjectCsvWriter } from 'csv-writer';
import { google } from 'googleapis';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import path from 'path';

const DEFAULTS = Object.freeze({
  outputDir: path.resolve('output'),
  fileName: 'acquisition_export.csv',
  sheetName: 'Overview',
  exportProfile: 'overview',
  maxCellLength: 5000,
  stringifySpacer: 0,
});

function safeString(value) {
  if (value == null) return '';
  return String(value);
}

function safeNumber(value, fallback = '') {
  if (value == null) return fallback;
  return Number.isFinite(value) ? value : fallback;
}

function truncateText(value, maxLength = DEFAULTS.maxCellLength) {
  const text = safeString(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

function jsonCell(value) {
  if (value == null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

function keyValueCell(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return '';
  const pairs = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    if (typeof v === 'object') continue;
    pairs.push(`${k}: ${v}`);
  }
  return pairs.join(' | ');
}

function joinedArrayCell(arr, separator = ' | ') {
  if (!Array.isArray(arr)) return '';
  return arr.map((x) => safeString(x).trim()).filter(Boolean).join(separator);
}

function resolveServiceAccountCredentials(serviceAccountKey) {
  if (!serviceAccountKey) return null;

  if (typeof serviceAccountKey === 'object') {
    return serviceAccountKey;
  }

  const raw = String(serviceAccountKey).trim();
  if (!raw) return null;

  if (raw.startsWith('{')) {
    return JSON.parse(raw);
  }

  return JSON.parse(readFileSync(raw, 'utf-8'));
}

const COLUMN_PROFILES = Object.freeze({
  overview: [
    { id: 'schema', header: 'schema', value: (r) => r.schema ?? '' },
    { id: 'schema_version', header: 'schema_version', value: (r) => r.schema_version ?? '' },
    { id: 'record_type', header: 'record_type', value: (r) => r.record_type ?? '' },
    { id: 'source', header: 'source', value: (r) => r.source ?? '' },
    { id: 'external_id', header: 'external_id', value: (r) => r.external_id ?? '' },
    { id: 'title', header: 'title', value: (r) => truncateText(r.title ?? '') },
    { id: 'category', header: 'category', value: (r) => r.category ?? '' },
    { id: 'condition', header: 'condition', value: (r) => r.condition ?? '' },
    { id: 'current_price', header: 'current_price', value: (r) => safeNumber(r.current_price, '') },
    { id: 'buyers_premium', header: 'buyers_premium', value: (r) => safeNumber(r.buyers_premium, '') },
    { id: 'estimated_shipping', header: 'estimated_shipping', value: (r) => safeNumber(r.estimated_shipping, '') },
    { id: 'shipping_weight', header: 'shipping_weight', value: (r) => r.shipping_weight ?? '' },
    { id: 'shipping_weight_lbs', header: 'shipping_weight_lbs', value: (r) => safeNumber(r.shipping_weight_lbs, '') },
    { id: 'tax_estimate', header: 'tax_estimate', value: (r) => safeNumber(r.tax_estimate, '') },
    { id: 'total_estimated_cost', header: 'total_estimated_cost', value: (r) => safeNumber(r.total_estimated_cost, '') },
    { id: 'auction_end_time', header: 'auction_end_time', value: (r) => r.auction_end_time ?? '' },
    { id: 'location', header: 'location', value: (r) => r.location ?? '' },
    { id: 'risk_score', header: 'risk_score', value: (r) => safeNumber(r.risk_score, '') },
    { id: 'confidence_score', header: 'confidence_score', value: (r) => safeNumber(r.confidence_score, '') },
    { id: 'purchase_recommendation', header: 'purchase_recommendation', value: (r) => r.purchase_recommendation ?? '' },
    { id: 'scraped_at', header: 'scraped_at', value: (r) => r.scraped_at ?? '' },
    { id: 'actor_run_id', header: 'actor_run_id', value: (r) => r.actor_run_id ?? '' },
  ],

  propertyroom: [
    { id: 'source', header: 'source', value: (r) => r.source ?? '' },
    { id: 'record_type', header: 'record_type', value: (r) => r.record_type ?? '' },
    { id: 'external_id', header: 'external_id', value: (r) => r.external_id ?? '' },
    { id: 'listing_url', header: 'listing_url', value: (r) => r.listing_url ?? '' },
    { id: 'title', header: 'title', value: (r) => truncateText(r.title ?? '') },
    { id: 'category', header: 'category', value: (r) => r.category ?? '' },
    { id: 'subcategory', header: 'subcategory', value: (r) => r.subcategory ?? '' },
    { id: 'condition', header: 'condition', value: (r) => r.condition ?? '' },
    { id: 'current_price', header: 'current_price', value: (r) => safeNumber(r.current_price, '') },
    { id: 'buyers_premium', header: 'buyers_premium', value: (r) => safeNumber(r.buyers_premium, '') },
    { id: 'estimated_shipping', header: 'estimated_shipping', value: (r) => safeNumber(r.estimated_shipping, '') },
    { id: 'shipping_weight', header: 'shipping_weight', value: (r) => r.shipping_weight ?? '' },
    { id: 'shipping_weight_lbs', header: 'shipping_weight_lbs', value: (r) => safeNumber(r.shipping_weight_lbs, '') },
    { id: 'tax_estimate', header: 'tax_estimate', value: (r) => safeNumber(r.tax_estimate, '') },
    { id: 'total_estimated_cost', header: 'total_estimated_cost', value: (r) => safeNumber(r.total_estimated_cost, '') },
    { id: 'currency', header: 'currency', value: (r) => r.currency ?? 'USD' },
    { id: 'auction_end_time', header: 'auction_end_time', value: (r) => r.auction_end_time ?? '' },
    { id: 'location', header: 'location', value: (r) => r.location ?? '' },
    { id: 'primary_image_url', header: 'primary_image_url', value: (r) => r.primary_image_url ?? '' },
    { id: 'image_urls', header: 'image_urls', value: (r) => joinedArrayCell(r.image_urls) },
    { id: 'description', header: 'description', value: (r) => truncateText(r.description ?? '') },
    { id: 'trusted_attributes', header: 'trusted_attributes', value: (r) => keyValueCell(r.attributes?.trusted) },
    { id: 'mined_attributes', header: 'mined_attributes', value: (r) => keyValueCell(r.attributes?.mined) },
    { id: 'source_meta_price', header: 'source_meta_price', value: (r) => jsonCell(r.source_meta?.price) },
    { id: 'source_meta_shipping', header: 'source_meta_shipping', value: (r) => jsonCell(r.source_meta?.shipping) },
    { id: 'source_meta_location', header: 'source_meta_location', value: (r) => jsonCell(r.source_meta?.location) },
    { id: 'source_meta_page_signals', header: 'source_meta_page_signals', value: (r) => jsonCell(r.source_meta?.page_signals) },
    { id: 'scraped_at', header: 'scraped_at', value: (r) => r.scraped_at ?? '' },
    { id: 'actor_run_id', header: 'actor_run_id', value: (r) => r.actor_run_id ?? '' },
  ],

  ebay: [
    { id: 'source', header: 'source', value: (r) => r.source ?? '' },
    { id: 'record_type', header: 'record_type', value: (r) => r.record_type ?? '' },
    { id: 'external_id', header: 'external_id', value: (r) => r.external_id ?? '' },
    { id: 'listing_url', header: 'listing_url', value: (r) => r.listing_url ?? '' },
    { id: 'title', header: 'title', value: (r) => truncateText(r.title ?? '') },
    { id: 'category', header: 'category', value: (r) => r.category ?? '' },
    { id: 'condition', header: 'condition', value: (r) => r.condition ?? '' },
    { id: 'current_price', header: 'current_price', value: (r) => safeNumber(r.current_price, '') },
    { id: 'estimated_shipping', header: 'estimated_shipping', value: (r) => safeNumber(r.estimated_shipping, '') },
    { id: 'currency', header: 'currency', value: (r) => r.currency ?? 'USD' },
    { id: 'auction_end_time', header: 'auction_end_time', value: (r) => r.auction_end_time ?? '' },
    { id: 'median_comp_price', header: 'median_comp_price', value: (r) => safeNumber(r.median_comp_price, '') },
    { id: 'avg_comp_price', header: 'avg_comp_price', value: (r) => safeNumber(r.avg_comp_price, '') },
    { id: 'scraped_at', header: 'scraped_at', value: (r) => r.scraped_at ?? '' },
    { id: 'actor_run_id', header: 'actor_run_id', value: (r) => r.actor_run_id ?? '' },
  ],

  arbitrage: [
    { id: 'source', header: 'source', value: (r) => r.source ?? '' },
    { id: 'record_type', header: 'record_type', value: (r) => r.record_type ?? '' },
    { id: 'external_id', header: 'external_id', value: (r) => r.external_id ?? '' },
    { id: 'title', header: 'title', value: (r) => truncateText(r.title ?? '') },
    { id: 'category', header: 'category', value: (r) => r.category ?? '' },
    { id: 'condition', header: 'condition', value: (r) => r.condition ?? '' },
    { id: 'current_price', header: 'current_price', value: (r) => safeNumber(r.current_price, '') },
    { id: 'buyers_premium', header: 'buyers_premium', value: (r) => safeNumber(r.buyers_premium, '') },
    { id: 'estimated_shipping', header: 'estimated_shipping', value: (r) => safeNumber(r.estimated_shipping, '') },
    { id: 'tax_estimate', header: 'tax_estimate', value: (r) => safeNumber(r.tax_estimate, '') },
    { id: 'total_estimated_cost', header: 'total_estimated_cost', value: (r) => safeNumber(r.total_estimated_cost, '') },
    { id: 'median_comp_price', header: 'median_comp_price', value: (r) => safeNumber(r.median_comp_price, '') },
    { id: 'avg_comp_price', header: 'avg_comp_price', value: (r) => safeNumber(r.avg_comp_price, '') },
    { id: 'estimated_ebay_fees', header: 'estimated_ebay_fees', value: (r) => safeNumber(r.estimated_ebay_fees, '') },
    { id: 'estimated_profit', header: 'estimated_profit', value: (r) => safeNumber(r.estimated_profit, '') },
    { id: 'estimated_margin_pct', header: 'estimated_margin_pct', value: (r) => safeNumber(r.estimated_margin_pct, '') },
    { id: 'risk_score', header: 'risk_score', value: (r) => safeNumber(r.risk_score, '') },
    { id: 'confidence_score', header: 'confidence_score', value: (r) => safeNumber(r.confidence_score, '') },
    { id: 'purchase_recommendation', header: 'purchase_recommendation', value: (r) => r.purchase_recommendation ?? '' },
    { id: 'decision_reason', header: 'decision_reason', value: (r) => truncateText(r.decision_reason ?? '') },
    { id: 'scraped_at', header: 'scraped_at', value: (r) => r.scraped_at ?? '' },
    { id: 'actor_run_id', header: 'actor_run_id', value: (r) => r.actor_run_id ?? '' },
  ],

  audit: [
    { id: 'schema', header: 'schema', value: (r) => r.schema ?? '' },
    { id: 'schema_version', header: 'schema_version', value: (r) => r.schema_version ?? '' },
    { id: 'record_type', header: 'record_type', value: (r) => r.record_type ?? '' },
    { id: 'source', header: 'source', value: (r) => r.source ?? '' },
    { id: 'external_id', header: 'external_id', value: (r) => r.external_id ?? '' },
    { id: 'listing_url', header: 'listing_url', value: (r) => r.listing_url ?? '' },
    { id: 'dedupe_key', header: 'dedupe_key', value: (r) => r.dedupe_key ?? '' },
    { id: 'content_hash', header: 'content_hash', value: (r) => r.content_hash ?? '' },
    { id: 'normalization_status', header: 'normalization_status', value: (r) => r.normalization_status ?? '' },
    { id: 'pipeline_stage', header: 'pipeline_stage', value: (r) => r.pipeline_stage ?? '' },
    { id: 'actor_run_id', header: 'actor_run_id', value: (r) => r.actor_run_id ?? '' },
    { id: 'actor_build_id', header: 'actor_build_id', value: (r) => r.actor_build_id ?? '' },
    { id: 'actor_task_id', header: 'actor_task_id', value: (r) => r.actor_task_id ?? '' },
    { id: 'input_fingerprint', header: 'input_fingerprint', value: (r) => r.input_fingerprint ?? '' },
    { id: 'record_lineage', header: 'record_lineage', value: (r) => jsonCell(r.record_lineage) },
    { id: 'source_meta', header: 'source_meta', value: (r) => jsonCell(r.source_meta) },
    { id: 'scraped_at', header: 'scraped_at', value: (r) => r.scraped_at ?? '' },
    { id: 'observed_at', header: 'observed_at', value: (r) => r.observed_at ?? '' },
  ],
});

function getColumnDefs(profile = DEFAULTS.exportProfile) {
  return COLUMN_PROFILES[profile] || COLUMN_PROFILES.overview;
}

function flattenRecord(record, profile = DEFAULTS.exportProfile) {
  const row = {};
  const defs = getColumnDefs(profile);

  for (const col of defs) {
    row[col.id] = col.value(record);
  }

  return row;
}

function buildRows(records, profile = DEFAULTS.exportProfile) {
  const defs = getColumnDefs(profile);
  const rows = records.map((rec) => flattenRecord(rec, profile));
  return { defs, rows };
}

function ensureOutputDir(outputDir, log) {
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
    log.info?.(`[export] Created output directory: ${outputDir}`);
  }
}

function normalizeFileName(fileName, profile) {
  if (!fileName) return `acquisition_export_${profile}.csv`;
  return fileName.toLowerCase().endsWith('.csv') ? fileName : `${fileName}.csv`;
}

export async function exportDatasetToCSV(records, opts = {}) {
  const {
    outputDir = DEFAULTS.outputDir,
    fileName = DEFAULTS.fileName,
    exportProfile = DEFAULTS.exportProfile,
    log = console,
  } = opts;

  if (!Array.isArray(records) || records.length === 0) {
    log.info?.('[export] No records to export — skipping CSV.');
    return null;
  }

  ensureOutputDir(outputDir, log);

  const resolvedFileName = normalizeFileName(fileName, exportProfile);
  const filePath = path.join(outputDir, resolvedFileName);

  const { defs, rows } = buildRows(records, exportProfile);

  const csvWriter = createObjectCsvWriter({
    path: filePath,
    header: defs.map((col) => ({ id: col.id, title: col.header })),
    alwaysQuote: true,
  });

  await csvWriter.writeRecords(rows);

  const result = {
    filePath,
    rowCount: rows.length,
    columnCount: defs.length,
    exportProfile,
    exportedAt: new Date().toISOString(),
  };

  log.info?.(
    `[export] CSV written: ${filePath} (${result.rowCount} rows, ${result.columnCount} columns, profile=${exportProfile})`,
  );

  return result;
}

export async function exportDatasetToGoogleSheets(records, opts = {}) {
  const {
    spreadsheetId,
    sheetName = DEFAULTS.sheetName,
    serviceAccountKey,
    exportProfile = DEFAULTS.exportProfile,
    log = console,
  } = opts;

  if (!spreadsheetId) {
    log.warning?.('[export] No spreadsheetId provided — skipping Google Sheets export.');
    return null;
  }

  if (!serviceAccountKey) {
    log.warning?.('[export] No serviceAccountKey provided — skipping Google Sheets export.');
    return null;
  }

  if (!Array.isArray(records) || records.length === 0) {
    log.info?.('[export] No records to export — skipping Google Sheets.');
    return null;
  }

  let credentials;
  try {
    credentials = resolveServiceAccountCredentials(serviceAccountKey);
  } catch (err) {
    log.error?.(`[export] Failed to parse service account credentials: ${err.message}`);
    return null;
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const sheets = google.sheets({ version: 'v4', auth });

  const { defs, rows } = buildRows(records, exportProfile);
  const headerRow = defs.map((col) => col.header);
  const dataRows = rows.map((row) =>
    defs.map((col) => {
      const value = row[col.id];
      return value == null ? '' : value;
    }),
  );

  const allRows = [headerRow, ...dataRows];
  const startRange = `${sheetName}!A1`;

  try {
    await sheets.spreadsheets.values.clear({
      spreadsheetId,
      range: `${sheetName}`,
    });

    const response = await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: startRange,
      valueInputOption: 'RAW',
      requestBody: {
        values: allRows,
      },
    });

    const updatedRows = response.data.updatedRows ?? allRows.length;
    const spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;

    const result = {
      updatedRows,
      rowCount: rows.length,
      columnCount: defs.length,
      exportProfile,
      spreadsheetUrl,
      sheetName,
      exportedAt: new Date().toISOString(),
    };

    log.info?.(
      `[export] Google Sheet updated: ${updatedRows} rows written to "${sheetName}" (profile=${exportProfile}) → ${spreadsheetUrl}`,
    );

    return result;
  } catch (err) {
    log.error?.(`[export] Google Sheets API error: ${err.message}`);
    if (err.errors) {
      for (const e of err.errors) {
        log.error?.(`  → ${e.message}`);
      }
    }
    return null;
  }
}