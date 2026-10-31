function ratio(num, den) { return den ? num / den : null; }

export function completenessRates(stats = {}, prefix = 'normalized') {
  const fallbackTotal = Number(stats[`${prefix}_completeness_total`] || 0);
  const counts = stats[`${prefix}_completeness`] || {};
  const applicable = stats[`${prefix}_completeness_applicable`] || {};
  const out = {};
  for (const [field, count] of Object.entries(counts)) {
    const denominator = Number(applicable[field] ?? fallbackTotal);
    out[field] = denominator ? count / denominator : null;
  }
  return out;
}

export function evaluateRunHealth(stats = {}, options = {}) {
  const failReasons = [];
  const incompleteReasons = [];
  const warnings = [];
  const exhaustive = options.discoveryMode === 'EXHAUSTIVE';
  const detailRatio = ratio(stats.detail_pages_parsed || 0, Math.max(0, (stats.detail_pages_attempted || 0) - (stats.closed_detail_pages || 0)));
  const normalizationRatio = ratio(stats.records_normalized || stats.records_processed || 0, stats.detail_pages_parsed || 0);
  const validationRatio = ratio(stats.records_validated || stats.records_processed || 0, stats.records_normalized || stats.records_processed || 0);
  const completeness = completenessRates(stats, 'normalized');
  const extractionCompleteness = completenessRates(stats, 'extraction');
  const recon = options.reconciliation || stats.reconciliation || {};
  const dispositions = recon.disposition_counts || {};

  if (options.crawlError) failReasons.push(`crawl_error:${options.crawlError.message || options.crawlError}`);
  if (((stats.requests_attempted || 0) > 0 || (stats.recheck_targets || 0) > 0) && (stats.records_saved || 0) === 0 && (stats.duplicates_skipped || 0) === 0) failReasons.push('no_open_records_for_ingestion');
  if ((stats.auth_required_events || 0) > 0) failReasons.push(`auth_required_events:${stats.auth_required_events}`);
  if ((stats.access_denied_events || 0) > 0) failReasons.push(`access_denied_events:${stats.access_denied_events}`);
  if ((stats.requests_permanently_failed || 0) > 0 && !exhaustive) failReasons.push(`permanent_request_failures:${stats.requests_permanently_failed}`);
  if ((stats.requests_attempted || 0) > 0 && (stats.requests_success || 0) === 0) {
    failReasons.push('no_successful_http_responses');
  }
  if ((stats.schema_drift_events || 0) > 0) failReasons.push('schema_drift_detected');
  if ((stats.records_discovered_unique || stats.records_discovered || 0) > 0 && (stats.detail_pages_attempted || 0) > 0 && (stats.detail_pages_parsed || 0) === 0) {
    failReasons.push('systemic_detail_parse_failure');
  }

  if (detailRatio != null) {
    if (detailRatio < 0.95) failReasons.push(`detail_success_ratio_below_95pct:${detailRatio.toFixed(4)}`);
    else if (detailRatio < 0.98) warnings.push(`detail_success_ratio_below_98pct:${detailRatio.toFixed(4)}`);
  }
  if (normalizationRatio != null && normalizationRatio < 0.98) failReasons.push(`normalization_success_ratio_below_98pct:${normalizationRatio.toFixed(4)}`);
  if (validationRatio != null && validationRatio < 0.98) failReasons.push(`validation_success_ratio_below_98pct:${validationRatio.toFixed(4)}`);

  if ((stats.detail_pages_parsed || 0) > 0 && (stats.records_saved || 0) === 0 && (stats.duplicates_skipped || 0) === 0 && (stats.records_validated || stats.records_processed || 0) > 0) {
    failReasons.push('validated_records_but_none_saved_or_unchanged');
  }

  if (stats.circuit_open_reason) failReasons.push(`source_circuit_open:${stats.circuit_open_reason}`);

  const thresholds = {
    external_id: 1,
    title: 1,
    listing_url: 1,
    current_price: 0.99,
    auction_end_time: 0.99,
    location: 0.98,
    seller_name: 0.98,
  };
  if ((stats.normalized_completeness_total || 0) > 0) {
    for (const [field, threshold] of Object.entries(thresholds)) {
      const value = completeness[field];
      if (value == null || value + Number.EPSILON < threshold) {
        failReasons.push(`critical_field_completeness:${field}:${value == null ? 'null' : value.toFixed(4)}<${threshold}`);
      }
    }
  }

  for (const key of ['PARSE_FAILED', 'NORMALIZATION_FAILED', 'VALIDATION_FAILED', 'UNKNOWN_FAILURE']) {
    if ((dispositions[key] || 0) > 0) failReasons.push(`${key.toLowerCase()}:${dispositions[key]}`);
  }

  if (exhaustive) {
    if ((stats.capacity_skipped || 0) > 0 || stats.capacity_truncated) incompleteReasons.push(`capacity_truncation:${stats.capacity_skipped || 1}`);
    if (stats.runtime_truncated) incompleteReasons.push('runtime_truncation');
    if ((recon.retry_pending || 0) > 0) incompleteReasons.push(`retry_pending:${recon.retry_pending}`);
    if ((recon.pending_detail || 0) > 0) incompleteReasons.push(`pending_detail:${recon.pending_detail}`);
    if ((recon.pending_index || 0) > 0) incompleteReasons.push(`pending_index:${recon.pending_index}`);
    if ((recon.discovery_partitions_total || 0) > (recon.discovery_partitions_completed || 0)) {
      incompleteReasons.push(`discovery_partitions_incomplete:${recon.discovery_partitions_completed || 0}/${recon.discovery_partitions_total || 0}`);
    }

    // An unaccounted ID with no queued/pending path to resolution is a true zero-loss failure.
    if ((recon.unaccounted_count || 0) > 0) {
      const resolvable = (recon.pending_detail || 0) + (recon.retry_pending || 0);
      if (resolvable > 0) incompleteReasons.push(`coverage_unaccounted_pending:${recon.unaccounted_count}`);
      else failReasons.push(`coverage_unaccounted:${recon.unaccounted_count}`);
    }

    if ((stats.requests_permanently_failed || 0) > 0 && (recon.retry_pending || 0) === 0 && (dispositions.ACCESS_RESTRICTED || 0) === 0 && (dispositions.AUTH_REQUIRED || 0) === 0) {
      failReasons.push(`unresolved_permanent_request_failures:${stats.requests_permanently_failed}`);
    }
  }

  if (options.webhookRequired && options.webhookFailed) failReasons.push('required_webhook_delivery_failed');

  let status = 'PASS';
  if (failReasons.length) status = 'FAIL';
  else if (incompleteReasons.length) status = 'INCOMPLETE';
  else if (warnings.length) status = 'DEGRADED';

  return {
    status,
    reasons: failReasons,
    incomplete_reasons: incompleteReasons,
    warnings,
    detail_success_ratio: detailRatio,
    normalization_success_ratio: normalizationRatio,
    validation_success_ratio: validationRatio,
    completeness,
    extraction_completeness: extractionCompleteness,
  };
}