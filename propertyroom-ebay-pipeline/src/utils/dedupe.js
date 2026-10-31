/**
 * src/utils/dedupe.js
 *
 * Enterprise deduplication and refresh manager.
 *
 * Capabilities:
 * - In-run queued dedupe
 * - In-run processed dedupe
 * - Cross-run persistence in Apify KV store
 * - Fingerprint-aware refresh handling
 * - TTL-based re-observation
 * - Bounded persistence with metadata
 * - Operational statistics
 *
 * Persistence model:
 * {
 *   version: 2,
 *   updated_at: ISO_STRING,
 *   entries: {
 *     "propertyroom-12345": {
 *       external_id: "propertyroom-12345",
 *       fingerprint: "sha256...",
 *       first_seen_at: ISO_STRING,
 *       last_seen_at: ISO_STRING,
 *       last_processed_at: ISO_STRING,
 *       seen_count: 3,
 *       process_count: 2,
 *       last_decision: "processed" | "skipped_unchanged" | "processed_changed" | "processed_stale",
 *       source: "propertyroom"
 *     }
 *   }
 * }
 */

const KV_STATE_KEY = 'DEDUPE_STATE_V2';

const DEFAULTS = Object.freeze({
  maxPersistedEntries: 100_000,
  staleAfterMs: 24 * 60 * 60 * 1000,
  enableFingerprintRefresh: true,
  enableStaleRefresh: true,
});

function nowIso() {
  return new Date().toISOString();
}

function toMs(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function safeSourceFromId(externalId) {
  const s = String(externalId || '');
  if (s.startsWith('propertyroom-')) return 'propertyroom';
  if (s.startsWith('ebay-')) return 'ebay';
  return 'unknown';
}

function normalizeFingerprint(fingerprint) {
  const value = String(fingerprint || '').trim();
  return value || null;
}

function compareEntriesByRecency(a, b) {
  const aTs = toMs(a?.last_seen_at) ?? 0;
  const bTs = toMs(b?.last_seen_at) ?? 0;
  return bTs - aTs;
}

export class DedupeManager {
  /**
   * @param {import('apify').KeyValueStore} kvStore
   * @param {{
   *   log?: ReturnType<import('./logging.js').createLogger>,
   *   maxPersistedEntries?: number,
   *   staleAfterMs?: number,
   *   enableFingerprintRefresh?: boolean,
   *   enableStaleRefresh?: boolean
   * }} [opts]
   */
  constructor(kvStore, opts = {}) {
    this._kv = kvStore;
    this._log = opts.log ?? console;

    this._maxPersistedEntries = Number.isInteger(opts.maxPersistedEntries)
      ? opts.maxPersistedEntries
      : DEFAULTS.maxPersistedEntries;

    this._staleAfterMs = Number.isFinite(opts.staleAfterMs)
      ? opts.staleAfterMs
      : DEFAULTS.staleAfterMs;

    this._enableFingerprintRefresh =
      typeof opts.enableFingerprintRefresh === 'boolean'
        ? opts.enableFingerprintRefresh
        : DEFAULTS.enableFingerprintRefresh;

    this._enableStaleRefresh =
      typeof opts.enableStaleRefresh === 'boolean'
        ? opts.enableStaleRefresh
        : DEFAULTS.enableStaleRefresh;

    /** @type {Set<string>} */
    this._queuedThisRun = new Set();

    /** @type {Set<string>} */
    this._processedThisRun = new Set();

    /**
     * Cross-run persisted state:
     * Map<externalId, entry>
     * @type {Map<string, {
     *   external_id: string,
     *   fingerprint: string|null,
     *   first_seen_at: string,
     *   last_seen_at: string,
     *   last_processed_at: string,
     *   seen_count: number,
     *   process_count: number,
     *   last_decision: string,
     *   source: string
     * }>}
     */
    this._entries = new Map();

    this._dirty = false;

    this._stats = {
      loadedEntries: 0,
      queuedThisRun: 0,
      processedThisRun: 0,
      skippedThisRun: 0,
      refreshProcessedThisRun: 0,
      staleProcessedThisRun: 0,
      unchangedSkippedThisRun: 0,
      newProcessedThisRun: 0,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ───────────────────────────────────────────────────────────────────────────

  async initialize() {
    try {
      const stored = await this._kv.getValue(KV_STATE_KEY);

      if (!stored) {
        this._log.info?.('No prior dedupe state found; starting fresh');
        return;
      }

      if (isPlainObject(stored) && isPlainObject(stored.entries)) {
        for (const [externalId, entry] of Object.entries(stored.entries)) {
          if (!externalId || !isPlainObject(entry)) continue;

          this._entries.set(String(externalId), {
            external_id: String(entry.external_id || externalId),
            fingerprint: normalizeFingerprint(entry.fingerprint),
            first_seen_at: String(entry.first_seen_at || entry.last_seen_at || nowIso()),
            last_seen_at: String(entry.last_seen_at || entry.first_seen_at || nowIso()),
            last_processed_at: String(entry.last_processed_at || entry.last_seen_at || nowIso()),
            seen_count: Number.isFinite(entry.seen_count) ? entry.seen_count : 1,
            process_count: Number.isFinite(entry.process_count) ? entry.process_count : 1,
            last_decision: String(entry.last_decision || 'processed'),
            source: String(entry.source || safeSourceFromId(externalId)),
            latest_price: typeof entry.latest_price === 'number' ? entry.latest_price : null,
          });
        }
      } else if (Array.isArray(stored)) {
        // Backward compatibility for old flat-array format
        for (const id of stored) {
          const externalId = String(id || '').trim();
          if (!externalId) continue;

          this._entries.set(externalId, {
            external_id: externalId,
            fingerprint: null,
            first_seen_at: nowIso(),
            last_seen_at: nowIso(),
            last_processed_at: nowIso(),
            seen_count: 1,
            process_count: 1,
            last_decision: 'processed_legacy',
            source: safeSourceFromId(externalId),
            latest_price: null,
          });
        }
      }

      this._stats.loadedEntries = this._entries.size;
      this._log.info?.(`Loaded ${this._entries.size} dedupe entries from KV store`);
      
      // Diagnostic: log a sample entry to verify fingerprint/price data is present
      if (this._entries.size > 0) {
        const sampleEntry = this._entries.values().next().value;
        this._log.info?.(`Sample loaded entry`, {
          id: sampleEntry.external_id,
          hasFingerprint: !!sampleEntry.fingerprint,
          fingerprintPrefix: sampleEntry.fingerprint?.slice(0, 12) || '(none)',
          hasPrice: sampleEntry.latest_price != null,
          price: sampleEntry.latest_price,
          lastProcessed: sampleEntry.last_processed_at,
          lastDecision: sampleEntry.last_decision,
          processCount: sampleEntry.process_count,
        });
      }
    } catch (err) {
      this._log.warning?.(`Could not load dedupe state: ${err.message}`);
    }
  }

  async persist() {
    if (!this._dirty) return;

    try {
      const cappedEntries = this._capEntries();
      const payload = {
        version: 2,
        updated_at: nowIso(),
        entries: cappedEntries,
      };

      await this._kv.setValue(KV_STATE_KEY, payload);
      this._dirty = false;

      this._log.info?.(`Persisted ${Object.keys(cappedEntries).length} dedupe entries to KV store`);
    } catch (err) {
      this._log.warning?.(`Could not persist dedupe state: ${err.message}`);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Queue-level dedupe
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * True if this item has already been queued in the current run.
   * Useful for avoiding repeated enqueueing from index pages.
   *
   * @param {string} externalId
   * @returns {boolean}
   */
  isQueued(externalId) {
    return this._queuedThisRun.has(String(externalId));
  }

  /**
   * Mark an item as queued in the current run.
   *
   * @param {string} externalId
   */
  markQueued(externalId) {
    const id = String(externalId);
    if (!id) return;

    if (!this._queuedThisRun.has(id)) {
      this._queuedThisRun.add(id);
      this._stats.queuedThisRun = this._queuedThisRun.size;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Process decision API
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Backward-compatible binary duplicate check.
   * This is intentionally conservative and should not be your primary decision API.
   *
   * @param {string} externalId
   * @returns {boolean}
   */
  isDuplicate(externalId) {
    const id = String(externalId);
    return this._processedThisRun.has(id) || this._entries.has(id);
  }

  /**
   * Enterprise decision method.
   *
   * Process when:
   * - never seen before
   * - fingerprint changed and fingerprint refresh enabled
   * - last processed is older than staleAfterMs and stale refresh enabled
   *
   * Skip when:
   * - already processed in this run
   * - known item, unchanged, and still fresh
   *
   * @param {string} externalId
   * @param {string|null} fingerprint
   * @returns {Promise<boolean>}
   */
  async shouldProcess(externalId, fingerprint = null) {
    const id = String(externalId || '').trim();
    if (!id) return false;

    const normalizedFingerprint = normalizeFingerprint(fingerprint);

    if (this._processedThisRun.has(id)) {
      this._stats.skippedThisRun += 1;
      return false;
    }

    const existing = this._entries.get(id);
    const now = Date.now();

    if (!existing) {
      this._log.debug?.(`shouldProcess → PROCESS (new item): ${id}`);
      return true;
    }

    const lastProcessedMs = toMs(existing.last_processed_at);
    const ageMs = lastProcessedMs != null ? now - lastProcessedMs : null;
    const isStale =
      this._enableStaleRefresh &&
      lastProcessedMs != null &&
      ageMs >= this._staleAfterMs;

    const hasFingerprintChanged =
      this._enableFingerprintRefresh &&
      normalizedFingerprint &&
      existing.fingerprint &&
      normalizedFingerprint !== existing.fingerprint;

    if (hasFingerprintChanged) {
      this._log.debug?.(`shouldProcess → PROCESS (fingerprint changed): ${id}`);
      return true;
    }

    if (isStale) {
      this._log.debug?.(`shouldProcess → PROCESS (stale, age ${Math.round((ageMs || 0) / 60000)}min): ${id}`);
      return true;
    }

    this._updateSeenOnly(id, existing, {
      fingerprint: normalizedFingerprint,
      decision: 'skipped_unchanged',
    });

    this._stats.skippedThisRun += 1;
    this._stats.unchangedSkippedThisRun += 1;
    return false;
  }

  /**
   * Fast, lightweight check from an index page's snippet price.
   *
   * @param {string} externalId
   * @param {number|null} indexPrice
   * @returns {Promise<boolean>}
   */
  async shouldEarlySkip(externalId, indexPrice) {
    const id = String(externalId || '').trim();
    if (!id) return false;

    if (this._processedThisRun.has(id)) {
      return true; // Already processed
    }

    const existing = this._entries.get(id);
    if (!existing) return false; // New item

    const lastProcessedMs = toMs(existing.last_processed_at);
    const now = Date.now();
    const isStale =
      this._enableStaleRefresh &&
      lastProcessedMs != null &&
      now - lastProcessedMs >= this._staleAfterMs;

    if (isStale) return false; // Must re-process to refresh data

    if (indexPrice != null && existing.latest_price != null) {
      if (Math.abs(indexPrice - existing.latest_price) > 0.01) {
        return false; // Price changed, cannot skip
      }
    } else {
      return false; // Cannot confidently skip without pricing delta
    }

    // State hasn't changed price-wise and is not stale. Safe to skip!
    this._updateSeenOnly(id, existing, {
      decision: 'skipped_early_index',
    });
    
    this._stats.skippedThisRun += 1;
    this._stats.unchangedSkippedThisRun += 1;
    this._processedThisRun.add(id);

    return true;
  }

  /**
   * Backward-compatible markSeen().
   * Marks as processed with no fingerprint.
   *
   * @param {string} externalId
   */
  markSeen(externalId) {
    const id = String(externalId || '').trim();
    if (!id) return;

    const existing = this._entries.get(id);
    const ts = nowIso();

    if (existing) {
      existing.last_seen_at = ts;
      existing.last_processed_at = ts;
      existing.process_count += 1;
      existing.seen_count += 1;
      existing.last_decision = 'processed';
    } else {
      this._entries.set(id, {
        external_id: id,
        fingerprint: null,
        first_seen_at: ts,
        last_seen_at: ts,
        last_processed_at: ts,
        seen_count: 1,
        process_count: 1,
        last_decision: 'processed',
        source: safeSourceFromId(id),
      });
      this._stats.newProcessedThisRun += 1;
    }

    this._processedThisRun.add(id);
    this._dirty = true;
    this._stats.processedThisRun = this._processedThisRun.size;
  }

  /**
   * Enterprise processed marker with fingerprint.
   *
   * @param {string} externalId
   * @param {string|null} fingerprint
   * @param {{ price?: number|null }} [extraMeta]
   */
  async markSeenWithFingerprint(externalId, fingerprint = null, extraMeta = {}) {
    const id = String(externalId || '').trim();
    if (!id) return;

    const normalizedFingerprint = normalizeFingerprint(fingerprint);
    const existing = this._entries.get(id);
    const ts = nowIso();

    if (!existing) {
      this._entries.set(id, {
        external_id: id,
        fingerprint: normalizedFingerprint,
        first_seen_at: ts,
        last_seen_at: ts,
        last_processed_at: ts,
        seen_count: 1,
        process_count: 1,
        last_decision: 'processed_new',
        source: safeSourceFromId(id),
        latest_price: typeof extraMeta.price === 'number' ? extraMeta.price : null,
      });
      this._stats.newProcessedThisRun += 1;
    } else {
      const changed =
        normalizedFingerprint &&
        existing.fingerprint &&
        normalizedFingerprint !== existing.fingerprint;

      const lastProcessedMs = toMs(existing.last_processed_at);
      const stale =
        this._enableStaleRefresh &&
        lastProcessedMs != null &&
        Date.now() - lastProcessedMs >= this._staleAfterMs;

      existing.fingerprint = normalizedFingerprint || existing.fingerprint || null;
      if (extraMeta.price !== undefined) {
        existing.latest_price = typeof extraMeta.price === 'number' ? extraMeta.price : null;
      }
      existing.last_seen_at = ts;
      existing.last_processed_at = ts;
      existing.seen_count += 1;
      existing.process_count += 1;
      existing.last_decision = changed
        ? 'processed_changed'
        : stale
          ? 'processed_stale'
          : 'processed';

      if (changed) this._stats.refreshProcessedThisRun += 1;
      if (!changed && stale) this._stats.staleProcessedThisRun += 1;
    }

    this._processedThisRun.add(id);
    this._dirty = true;
    this._stats.processedThisRun = this._processedThisRun.size;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Stats / inspection
  // ───────────────────────────────────────────────────────────────────────────

  getEntry(externalId) {
    const id = String(externalId || '').trim();
    if (!id) return null;
    const entry = this._entries.get(id);
    return entry ? { ...entry } : null;
  }

  getStats() {
    return {
      loadedEntries: this._stats.loadedEntries,
      queuedThisRun: this._queuedThisRun.size,
      processedThisRun: this._processedThisRun.size,
      persistedEntries: this._entries.size,
      skippedThisRun: this._stats.skippedThisRun,
      refreshProcessedThisRun: this._stats.refreshProcessedThisRun,
      staleProcessedThisRun: this._stats.staleProcessedThisRun,
      unchangedSkippedThisRun: this._stats.unchangedSkippedThisRun,
      newProcessedThisRun: this._stats.newProcessedThisRun,
      staleAfterMs: this._staleAfterMs,
      fingerprintRefreshEnabled: this._enableFingerprintRefresh,
      staleRefreshEnabled: this._enableStaleRefresh,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Internal helpers
  // ───────────────────────────────────────────────────────────────────────────

  _updateSeenOnly(externalId, existing, { fingerprint = null, decision = 'skipped_unchanged' } = {}) {
    existing.last_seen_at = nowIso();
    existing.seen_count += 1;
    if (fingerprint && !existing.fingerprint) {
      existing.fingerprint = fingerprint;
    }
    existing.last_decision = decision;
    this._dirty = true;
  }

  _capEntries() {
    const entries = Array.from(this._entries.values()).sort(compareEntriesByRecency);
    const capped = entries.slice(0, this._maxPersistedEntries);

    return capped.reduce((acc, entry) => {
      acc[entry.external_id] = {
        external_id: entry.external_id,
        fingerprint: entry.fingerprint ?? null,
        first_seen_at: entry.first_seen_at,
        last_seen_at: entry.last_seen_at,
        last_processed_at: entry.last_processed_at,
        seen_count: entry.seen_count,
        process_count: entry.process_count,
        last_decision: entry.last_decision,
        source: entry.source,
        latest_price: entry.latest_price ?? null,
      };
      return acc;
    }, {});
  }
}