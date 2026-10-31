export const RECOVERY_KEY = 'LIQUIDATION_RECOVERY_STATE_V3';
export const DLQ_KEY = 'LIQUIDATION_FAILED_REQUEST_DLQ_V3';
export const RECON_KEY = 'LIQUIDATION_RECONCILIATION_V3';
export const COMPLETION_MANIFEST_KEY = 'LIQUIDATION_RUN_COMPLETION_MANIFEST';

function nowIso() { return new Date().toISOString(); }
function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function objectOrThrow(v, label) {
  if (v == null) return {};
  if (!isPlainObject(v)) throw new Error(`${label}_INVALID_SHAPE`);
  return v;
}
function safeError(error) { return String(error || '').slice(0, 1000); }
function forensicSuffix() { return new Date().toISOString().replace(/[:.]/g, '-'); }

function validateStateShape(stored) {
  if (!isPlainObject(stored)) return false;
  if (stored.version !== 3) return false;
  if (!['RUNNING', 'INCOMPLETE', 'COMPLETE', 'FAILED'].includes(stored.status)) return false;
  if (typeof stored.input_fingerprint !== 'string' || !stored.input_fingerprint) return false;
  for (const key of ['pending_index', 'pending_detail', 'pending_manifest', 'completed_index', 'discovered', 'dispositions']) {
    if (!isPlainObject(stored[key])) return false;
  }
  return true;
}

function validateDlqShape(stored) {
  if (stored == null) return true;
  if (!isPlainObject(stored)) return false;
  for (const entry of Object.values(stored)) {
    if (!isPlainObject(entry)) return false;
    if (typeof entry.url !== 'string' || !entry.url) return false;
    if (!['index', 'detail', 'manifest'].includes(entry.request_type || 'detail')) return false;
  }
  return true;
}

export class LiquidationRecoveryState {
  constructor(kvStore, { log = console, persistEvery = 100, completedEvidenceRetainEntries = 1000 } = {}) {
    this.kv = kvStore;
    this.log = log;
    this.persistEvery = Math.max(1, Number(persistEvery) || 100);
    this.completedEvidenceRetainEntries = Math.max(0, Number(completedEvidenceRetainEntries) || 0);
    this.ops = 0;
    this.state = null;
    this.dlq = {};
  }

  async _preserveCorrupt(prefix, raw) {
    const key = `${prefix}_${forensicSuffix()}`;
    try { await this.kv.setValue(key, raw); } catch { /* preserve best effort */ }
    return key;
  }

  async initialize(inputFingerprint) {
    const storedRaw = await this.kv.getValue(RECOVERY_KEY);
    const dlqRaw = await this.kv.getValue(DLQ_KEY);

    if (storedRaw != null && !validateStateShape(storedRaw)) {
      const forensicKey = await this._preserveCorrupt('LIQUIDATION_CORRUPT_RECOVERY', storedRaw);
      throw new Error(`RECOVERY_STATE_INVALID:${forensicKey}`);
    }
    if (!validateDlqShape(dlqRaw)) {
      const forensicKey = await this._preserveCorrupt('LIQUIDATION_CORRUPT_SOURCE_DLQ', dlqRaw);
      throw new Error(`SOURCE_DLQ_INVALID:${forensicKey}`);
    }

    const stored = storedRaw || null;
    this.dlq = objectOrThrow(dlqRaw, 'SOURCE_DLQ');

    const resumable = stored && ['RUNNING', 'INCOMPLETE'].includes(stored.status);
    if (resumable && stored.input_fingerprint === inputFingerprint) {
      this.state = {
        ...stored,
        status: 'RUNNING',
        resumed_at: nowIso(),
        pending_index: objectOrThrow(stored.pending_index, 'PENDING_INDEX'),
        pending_detail: objectOrThrow(stored.pending_detail, 'PENDING_DETAIL'),
        pending_manifest: objectOrThrow(stored.pending_manifest, 'PENDING_MANIFEST'),
        completed_index: objectOrThrow(stored.completed_index, 'COMPLETED_INDEX'),
        discovered: objectOrThrow(stored.discovered, 'DISCOVERED'),
        dispositions: objectOrThrow(stored.dispositions, 'DISPOSITIONS'),
      };
      this.log.info?.('Liquidation recovery state resumed', {
        pendingIndex: Object.keys(this.state.pending_index).length,
        pendingDetail: Object.keys(this.state.pending_detail).length,
        dlq: Object.keys(this.dlq).length,
      });
      await this.persist(true);
      return { resume: true, previousStatus: stored.status };
    }

    if (resumable && stored.input_fingerprint !== inputFingerprint) {
      const archiveKey = `LIQUIDATION_INCOMPATIBLE_RECOVERY_${forensicSuffix()}`;
      await this.kv.setValue(archiveKey, stored);
      this.log.warning?.('Liquidation incompatible recovery state archived; starting governed fresh state', {
        archiveKey,
        priorFingerprint: stored.input_fingerprint,
        currentFingerprint: inputFingerprint,
      });
    }

    this.state = {
      version: 3,
      status: 'RUNNING',
      input_fingerprint: inputFingerprint,
      started_at: nowIso(),
      updated_at: nowIso(),
      pending_index: {},
      pending_detail: {},
      pending_manifest: {},
      completed_index: {},
      discovered: {},
      dispositions: {},
      summary: null,
    };
    await this.persist(true);
    return { resume: false };
  }

  async _touch() {
    this.ops += 1;
    this.state.updated_at = nowIso();
    if (this.ops >= this.persistEvery) await this.persist();
  }

  async queueIndex(url, meta = {}) {
    if (!url || this.state.completed_index[url]) return;
    this.state.pending_index[url] = {
      url,
      ...meta,
      queued_at: this.state.pending_index[url]?.queued_at || nowIso(),
      last_queued_at: nowIso(),
    };
    await this._touch();
  }

  async completeIndex(url, meta = {}) {
    if (!url) return;
    delete this.state.pending_index[url];
    this.state.completed_index[url] = { url, ...meta, completed_at: nowIso() };
    await this._touch();
  }

  async queueDetail(externalId, meta = {}) {
    if (!externalId) return;
    this.state.pending_detail[externalId] = {
      external_id: externalId,
      ...meta,
      queued_at: this.state.pending_detail[externalId]?.queued_at || nowIso(),
      last_queued_at: nowIso(),
    };
    await this._touch();
  }

  async queueManifest(key, meta = {}) {
    if (!key) return;
    this.state.pending_manifest[key] = { key, ...meta, queued_at: this.state.pending_manifest[key]?.queued_at || nowIso(), last_queued_at: nowIso() };
    await this._touch();
  }

  async completeManifest(key) {
    if (!key) return;
    delete this.state.pending_manifest[key];
    await this._touch();
  }

  pendingManifestRequests() { return Object.values(this.state.pending_manifest); }

  async noteDiscovered(externalId, partition) {
    if (!externalId) return;
    const prior = this.state.discovered[externalId] || { external_id: externalId, partitions: [], first_seen_at: nowIso() };
    if (partition && !prior.partitions.includes(partition)) prior.partitions.push(partition);
    prior.last_seen_at = nowIso();
    this.state.discovered[externalId] = prior;
    await this._touch();
  }

  async disposition(externalId, disposition, meta = {}) {
    if (!externalId) return;
    delete this.state.pending_detail[externalId];
    this.state.dispositions[externalId] = { disposition, ...meta, at: nowIso() };
    await this._touch();
  }

  async addFailure({
    url,
    externalId = null,
    requestType = 'detail',
    partition = null,
    retryCount = 0,
    status = null,
    error = null,
    errorClass = null,
    sourceRunId = null,
    nextRetryAfter = null,
    terminalStatus = null,
  }) {
    const key = externalId || url;
    if (!key || !url) return;
    const prior = this.dlq[key] || {};
    this.dlq[key] = {
      version: 3,
      url,
      external_id: externalId,
      request_type: requestType,
      partition,
      retry_count: retryCount,
      last_http_status: status,
      last_error: safeError(error),
      error_class: errorClass || null,
      first_failed_at: prior.first_failed_at || nowIso(),
      last_failed_at: nowIso(),
      source_run_id: sourceRunId,
      next_retry_after: nextRetryAfter,
      terminal_status: terminalStatus,
    };
    if (externalId && !terminalStatus) await this.disposition(externalId, 'RETRY_PENDING', { status, url, partition });
    await this.persist(true);
  }

  async resolveFailure(url, externalId = null, terminalStatus = null) {
    const keys = [externalId, url].filter(Boolean);
    let changed = false;
    for (const key of keys) {
      if (!this.dlq[key]) continue;
      if (terminalStatus) this.dlq[key].terminal_status = terminalStatus;
      delete this.dlq[key];
      changed = true;
    }
    if (changed) await this.persist(true);
  }

  replayRequests() {
    const now = Date.now();
    return Object.values(this.dlq).filter((entry) => {
      if (entry.terminal_status) return false;
      if (!entry.next_retry_after) return true;
      const ts = Date.parse(entry.next_retry_after);
      return !Number.isFinite(ts) || ts <= now;
    });
  }

  pendingIndexRequests() { return Object.values(this.state.pending_index); }
  pendingDetailRequests() { return Object.values(this.state.pending_detail); }

  partitionSummary() {
    const pending = new Map();
    const completed = new Map();
    for (const item of Object.values(this.state.pending_index)) {
      const key = item.partition || 'unknown';
      pending.set(key, (pending.get(key) || 0) + 1);
    }
    for (const item of Object.values(this.state.completed_index)) {
      const key = item.partition || 'unknown';
      completed.set(key, (completed.get(key) || 0) + 1);
    }
    const partitions = new Set([...pending.keys(), ...completed.keys()]);
    const detail = {};
    let completedPartitions = 0;
    for (const key of partitions) {
      const pendingCount = pending.get(key) || 0;
      const completedCount = completed.get(key) || 0;
      const done = pendingCount === 0 && completedCount > 0;
      if (done) completedPartitions += 1;
      detail[key] = { pending_index: pendingCount, completed_index: completedCount, complete: done };
    }
    return { total: partitions.size, completed: completedPartitions, detail };
  }

  reconciliation() {
    const discoveredIds = Object.keys(this.state.discovered);
    const dispositions = this.state.dispositions;
    const counts = {};
    const unaccounted = [];
    for (const id of discoveredIds) {
      const d = dispositions[id]?.disposition;
      if (!d) unaccounted.push(id);
      else counts[d] = (counts[d] || 0) + 1;
    }
    const partitions = this.partitionSummary();
    return {
      discovered_unique: discoveredIds.length,
      accounted: discoveredIds.length - unaccounted.length,
      unaccounted_count: unaccounted.length,
      unaccounted_ids: unaccounted.slice(0, 100),
      disposition_counts: counts,
      retry_pending: Object.values(this.dlq).filter((entry) => !entry.terminal_status).length,
      pending_index: Object.keys(this.state.pending_index).length,
      pending_detail: Object.keys(this.state.pending_detail).length,
      pending_manifest: Object.keys(this.state.pending_manifest).length,
      discovery_partitions_total: partitions.total,
      discovery_partitions_completed: partitions.completed,
      discovery_partition_detail: partitions.detail,
    };
  }

  async writeCompletionManifest(manifest) {
    await this.kv.setValue(COMPLETION_MANIFEST_KEY, { version: 1, ...manifest });
  }

  async _finalize(status, { manifest = null, compact = false } = {}) {
    const recon = this.reconciliation();
    this.state.status = status;
    this.state.updated_at = nowIso();
    if (status === 'COMPLETE') this.state.completed_at = nowIso();
    if (status === 'FAILED') this.state.failed_at = nowIso();
    if (status === 'INCOMPLETE') this.state.incomplete_at = nowIso();
    this.state.summary = recon;

    await this.kv.setValue(RECON_KEY, {
      version: 3,
      ...recon,
      status,
      at: nowIso(),
      input_fingerprint: this.state.input_fingerprint,
    });
    if (manifest) await this.writeCompletionManifest(manifest);

    if (compact && status === 'COMPLETE') {
      const keep = this.completedEvidenceRetainEntries;
      if (keep >= 0) {
        this.state.discovered = Object.fromEntries(Object.entries(this.state.discovered).slice(-keep));
        this.state.dispositions = Object.fromEntries(Object.entries(this.state.dispositions).slice(-keep));
        this.state.completed_index = Object.fromEntries(Object.entries(this.state.completed_index).slice(-keep));
      }
      this.state.pending_index = {};
      this.state.pending_detail = {};
      this.state.pending_manifest = {};
    }
    await this.persist(true);
    return recon;
  }

  async markComplete(options = {}) { return this._finalize('COMPLETE', { ...options, compact: options.compact !== false }); }
  async markIncomplete(options = {}) { return this._finalize('INCOMPLETE', { ...options, compact: false }); }
  async markFailed(options = {}) { return this._finalize('FAILED', { ...options, compact: false }); }

  async persist(force = false) {
    if (!this.state) return;
    if (!force && this.ops === 0) {
      await this.kv.setValue(DLQ_KEY, this.dlq);
      return;
    }
    this.state.updated_at = nowIso();
    await this.kv.setValue(RECOVERY_KEY, this.state);
    await this.kv.setValue(DLQ_KEY, this.dlq);
    this.ops = 0;
  }
}