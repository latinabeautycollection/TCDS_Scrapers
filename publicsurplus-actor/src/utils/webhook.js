/**
 * src/utils/webhook.js
 *
 * Enterprise webhook delivery manager.
 *
 * Features:
 * - Buffered delivery with batch flushing
 * - Bearer auth
 * - Exponential backoff with jitter
 * - Flush locking to prevent concurrent flush races
 * - Rich batch envelope metadata
 * - Permanent vs transient failure handling
 * - Dead-letter queue with metadata
 * - Replay support
 * - Operational stats
 */

const DLQ_PREFIX = 'WEBHOOK_DLQ_V2_';
const BACKOFF_BASE_MS = 1_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt, base = BACKOFF_BASE_MS) {
  const cap = 60_000;
  const exp = Math.min(cap, base * 2 ** attempt);
  return Math.floor(Math.random() * exp);
}

function nowIso() {
  return new Date().toISOString();
}

function makeBatchId() {
  return `wh_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function isRetryableStatus(status) {
  return status === 429 || status >= 500;
}

function isPermanentStatus(status) {
  return status >= 400 && status < 500 && status !== 429;
}

export class WebhookManager {
  /**
   * @param {{
   *   url: string,
   *   authToken?: string,
   *   batchSize?: number,
   *   maxRetries?: number,
   *   kvStore: import('apify').KeyValueStore,
   *   log: ReturnType<import('./logging.js').createLogger>,
   *   runContext?: object,
   *   sourceName?: string,
   *   timeoutMs?: number
   * }} opts
   */
  constructor(opts) {
    this._url = opts.url;
    this._authToken = opts.authToken ?? null;
    this._batchSize = Math.max(1, opts.batchSize ?? 10);
    this._maxRetries = Math.max(0, opts.maxRetries ?? 5);
    this._kv = opts.kvStore;
    this._log = opts.log;
    this._runContext = opts.runContext ?? {};
    this._sourceName = opts.sourceName ?? 'unknown';
    this._timeoutMs = Math.max(1_000, opts.timeoutMs ?? 30_000);

    /** @type {object[]} */
    this._buffer = [];

    this._flushPromise = null;

    this._stats = {
      sentBatches: 0,
      sentRecords: 0,
      failedBatches: 0,
      failedRecords: 0,
      dlqEntries: 0,
      replayedBatches: 0,
      replayFailedBatches: 0,
      permanentFailures: 0,
      transientFailures: 0,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Public API
  // ───────────────────────────────────────────────────────────────────────────

  async add(record) {
    this._buffer.push(record);
    if (this._buffer.length >= this._batchSize) {
      await this.flush();
    }
  }

  async flush() {
    if (this._flushPromise) {
      await this._flushPromise;
      return;
    }

    this._flushPromise = this._flushInternal();
    try {
      await this._flushPromise;
    } finally {
      this._flushPromise = null;
    }
  }

  async replayDeadLetter() {
    const keysResult = await this._listDlqKeys();

    if (keysResult.length === 0) {
      this._log.info('No dead-letter entries to replay');
      return;
    }

    this._log.info(`Replaying ${keysResult.length} dead-letter batches`);

    for (const key of keysResult) {
      const dlqEntry = await this._kv.getValue(key);
      if (!dlqEntry || !Array.isArray(dlqEntry.records)) {
        continue;
      }

      const result = await this._postWithRetry(
        dlqEntry.records,
        dlqEntry.batchMeta ?? { batch_id: makeBatchId(), replayed: true },
      );

      if (result.ok) {
        await this._kv.setValue(key, null);
        this._stats.replayedBatches += 1;
        this._log.info(`Replayed and cleared DLQ entry: ${key}`);
      } else {
        this._stats.replayFailedBatches += 1;
        this._log.warning(`DLQ replay failed for key: ${key}`, {
          status: result.status,
          permanent: result.permanent,
        });
      }
    }
  }

  getStats() {
    return {
      ...this._stats,
      bufferedRecords: this._buffer.length,
      batchSize: this._batchSize,
      maxRetries: this._maxRetries,
      timeoutMs: this._timeoutMs,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Internal flush
  // ───────────────────────────────────────────────────────────────────────────

  async _flushInternal() {
    if (this._buffer.length === 0) {
      this._log.info('Webhook flush complete', this.getStats());
      return;
    }

    const batch = this._buffer.splice(0, this._buffer.length);
    const batchMeta = this._buildBatchMeta(batch);

    const result = await this._postWithRetry(batch, batchMeta);

    if (result.ok) {
      this._stats.sentBatches += 1;
      this._stats.sentRecords += batch.length;
    } else {
      this._stats.failedBatches += 1;
      this._stats.failedRecords += batch.length;

      if (result.permanent) {
        this._stats.permanentFailures += 1;
        this._log.error('Webhook permanent failure; batch will be stored in DLQ', {
          status: result.status,
          batchId: batchMeta.batch_id,
        });
      } else {
        this._stats.transientFailures += 1;
      }

      await this._toDlq(batch, batchMeta, result);
    }

    this._log.info('Webhook flush complete', this.getStats());
  }

  _buildBatchMeta(batch) {
    return {
      batch_id: makeBatchId(),
      sent_at: nowIso(),
      source_name: this._sourceName,
      actor_run_id: this._runContext.actorRunId ?? null,
      actor_build_id: this._runContext.actorBuildId ?? null,
      actor_task_id: this._runContext.actorTaskId ?? null,
      input_fingerprint: this._runContext.inputFingerprint ?? null,
      record_count: batch.length,
      schema: batch[0]?.schema ?? null,
      schema_version: batch[0]?.schema_version ?? null,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Posting logic
  // ───────────────────────────────────────────────────────────────────────────

  async _postWithRetry(batch, batchMeta) {
    let lastResult = {
      ok: false,
      status: 0,
      permanent: false,
      error: 'unknown',
    };

    for (let attempt = 0; attempt <= this._maxRetries; attempt += 1) {
      if (attempt > 0) {
        const wait = backoffMs(attempt - 1);
        this._log.debug(`Webhook retry ${attempt}/${this._maxRetries} in ${wait}ms`, {
          batchId: batchMeta.batch_id,
        });
        await sleep(wait);
      }

      const result = await this._post(batch, batchMeta, attempt);
      lastResult = result;

      if (result.ok) return result;
      if (result.permanent) return result;
    }

    return lastResult;
  }

  async _post(batch, batchMeta, attempt = 0) {
    const payload = JSON.stringify({
      meta: {
        ...batchMeta,
        retry_attempt: attempt,
      },
      records: batch,
      count: batch.length,
    });

    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'ApifyActor/PropertyRoomAcquisitionPipeline/2.0',
      'X-Webhook-Batch-Id': batchMeta.batch_id,
      'Idempotency-Key': batchMeta.batch_id,
    };

    if (this._authToken) {
      headers.Authorization = `Bearer ${this._authToken}`;
    }

    try {
      const response = await fetch(this._url, {
        method: 'POST',
        headers,
        body: payload,
        signal: AbortSignal.timeout(this._timeoutMs),
      });

      const status = response.status;

      if (response.ok) {
        this._log.debug(`Webhook POST ${status}`, {
          batchId: batchMeta.batch_id,
          batchSize: batch.length,
        });
        return { ok: true, status, permanent: false, error: null };
      }

      const body = await response.text().catch(() => '');

      if (isRetryableStatus(status)) {
        this._log.warning(`Webhook transient failure ${status}`, {
          batchId: batchMeta.batch_id,
          batchSize: batch.length,
          body: body.slice(0, 200),
        });
        return { ok: false, status, permanent: false, error: body.slice(0, 500) };
      }

      if (isPermanentStatus(status)) {
        this._log.error(`Webhook permanent failure ${status}`, {
          batchId: batchMeta.batch_id,
          batchSize: batch.length,
          body: body.slice(0, 200),
        });
        return { ok: false, status, permanent: true, error: body.slice(0, 500) };
      }

      return { ok: false, status, permanent: false, error: body.slice(0, 500) };
    } catch (err) {
      this._log.warning(`Webhook network error: ${err.message}`, {
        batchId: batchMeta.batch_id,
      });
      return { ok: false, status: 0, permanent: false, error: err.message };
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // DLQ
  // ───────────────────────────────────────────────────────────────────────────

  async _toDlq(batch, batchMeta, result) {
    const key = `${DLQ_PREFIX}${Date.now()}_${batchMeta.batch_id}`;

    const payload = {
      batchMeta,
      records: batch,
      failure: {
        status: result.status ?? 0,
        permanent: !!result.permanent,
        error: result.error ?? null,
        failed_at: nowIso(),
      },
    };

    try {
      await this._kv.setValue(key, payload);
      this._stats.dlqEntries += 1;

      this._log.warning(`Batch sent to dead-letter store: ${key}`, {
        batchId: batchMeta.batch_id,
        size: batch.length,
        permanent: result.permanent,
      });
    } catch (err) {
      this._log.error(`Could not write to DLQ: ${err.message}`, {
        batchId: batchMeta.batch_id,
      });
    }
  }

  async _listDlqKeys() {
    // Prefer getKeys if available in current environment
    if (typeof this._kv.getKeys === 'function') {
      const out = [];
      let exclusiveStartKey;

      do {
        const resp = await this._kv.getKeys({ exclusiveStartKey, limit: 1000 });
        const items = resp?.items ?? [];
        for (const item of items) {
          if (item.key?.startsWith(DLQ_PREFIX)) out.push(item.key);
        }
        exclusiveStartKey = resp?.nextExclusiveStartKey;
      } while (exclusiveStartKey);

      return out;
    }

    // Fallback: no key listing support
    this._log.warning('KV store key listing is not available; DLQ replay skipped');
    return [];
  }
}