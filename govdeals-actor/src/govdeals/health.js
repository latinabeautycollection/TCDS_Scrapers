function ratio(num, den) {
  if (!den) return null;
  return num / den;
}

export function completenessRates(stats = {}) {
  const total = Number(stats.completeness_total || 0);
  const out = {};
  for (const [field, count] of Object.entries(stats.completeness || {})) {
    out[field] = total ? count / total : null;
  }
  return out;
}

export function evaluateRunHealth(stats = {}, options = {}) {
  const reasons = [];
  const warnings = [];
  const detailRatio = ratio(stats.detail_pages_parsed || 0, stats.detail_pages_attempted || 0);
  const completeness = completenessRates(stats);

  if (options.crawlError) reasons.push(`crawl_error:${options.crawlError.message || options.crawlError}`);
  if ((stats.schema_drift_events || 0) > 0) reasons.push('schema_drift_detected');
  if ((stats.records_discovered || 0) > 0 && (stats.detail_pages_attempted || 0) > 0 && (stats.detail_pages_parsed || 0) === 0) {
    reasons.push('systemic_detail_parse_failure');
  }
  if (detailRatio != null) {
    if (detailRatio < 0.95) reasons.push(`detail_success_ratio_below_95pct:${detailRatio.toFixed(4)}`);
    else if (detailRatio < 0.98) warnings.push(`detail_success_ratio_below_98pct:${detailRatio.toFixed(4)}`);
  }
  if ((stats.records_queued || 0) > 0 && (stats.records_saved || 0) === 0 &&
      (stats.filtered_records || 0) === 0 && (stats.capacity_skipped || 0) === 0 &&
      (stats.duplicates_skipped || 0) === 0) {
    reasons.push('queued_records_saved_zero_without_filter_capacity_or_dedupe_evidence');
  }
  if ((stats.records_rejected || 0) > 0 && (stats.records_saved || 0) > 0) {
    warnings.push(`records_rejected:${stats.records_rejected}`);
  }

  const thresholds = {
    external_id: 1,
    title: 1,
    listing_url: 1,
    current_price: 0.99,
    auction_end_time: 0.99,
    location: 0.99,
    seller_name: 0.98,
    condition: 0.98,
  };
  if ((stats.completeness_total || 0) > 0) {
    for (const [field, threshold] of Object.entries(thresholds)) {
      const value = completeness[field];
      if (value == null || value + Number.EPSILON < threshold) {
        reasons.push(`critical_field_completeness:${field}:${value == null ? 'null' : value.toFixed(4)}<${threshold}`);
      }
    }
  }

  if (options.webhookRequired && options.webhookFailed) reasons.push('required_webhook_delivery_failed');
  if (options.ebayRequiredFailure) warnings.push('ebay_enrichment_failed');

  const status = reasons.length ? 'FAIL' : warnings.length ? 'DEGRADED' : 'PASS';
  return { status, reasons, warnings, detail_success_ratio: detailRatio, completeness };
}