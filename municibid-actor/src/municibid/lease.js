export const RUN_LEASE_KEY = 'MUNICIBID_ACTIVE_RUN_LEASE_V3';
export const RUN_LOCK_QUEUE_NAME = 'municibid-active-run-lock-v3';
export const RUN_LOCK_UNIQUE_KEY = 'MUNICIBID_ACTIVE_RUN_LOCK_V3';

function nowMs() { return Date.now(); }
function nowIso() { return new Date().toISOString(); }
function validLease(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && value.version === 3
    && typeof value.owner_run_id === 'string'
    && typeof value.expires_at === 'string'
    && typeof value.lock_request_id === 'string';
}

export class MunicibidRunLease {
  constructor(kvStore, {
    runId,
    ttlMs = 30 * 60 * 1000,
    enabled = true,
    log = console,
    openLockQueue,
    verifyPriorRunTerminal = null,
  } = {}) {
    this.kv = kvStore;
    this.runId = String(runId || 'unknown-run');
    this.ttlMs = Math.max(60_000, Number(ttlMs) || 30 * 60 * 1000);
    this.enabled = enabled !== false;
    this.log = log;
    this.openLockQueue = openLockQueue;
    this.verifyPriorRunTerminal = verifyPriorRunTerminal;
    this.queue = null;
    this.lockRequestId = null;
    this.acquired = false;
    this.fenceToken = null;
  }

  async _queue() {
    if (!this.openLockQueue) throw new Error('MUNICIBID_ATOMIC_LOCK_QUEUE_REQUIRED');
    if (!this.queue) this.queue = await this.openLockQueue();
    return this.queue;
  }

  async _recycleStaleQueue(existingLease) {
    if (!this.verifyPriorRunTerminal) {
      throw new Error(`MUNICIBID_STALE_LOCK_VERIFICATION_REQUIRED:${existingLease.owner_run_id}`);
    }
    let result;
    try {
      result = await this.verifyPriorRunTerminal(existingLease.owner_run_id);
    } catch (err) {
      throw new Error(`MUNICIBID_STALE_LOCK_VERIFICATION_FAILED:${existingLease.owner_run_id}:${err.message}`);
    }
    const terminal = result === true || result?.terminal === true;
    if (!terminal) {
      const status = result?.status || 'UNKNOWN';
      throw new Error(`MUNICIBID_STALE_LOCK_OWNER_NOT_TERMINAL:${existingLease.owner_run_id}:${status}`);
    }
    const latest = await this.kv.getValue(RUN_LEASE_KEY);
    if (!validLease(latest) || latest.owner_run_id !== existingLease.owner_run_id || latest.fence_token !== existingLease.fence_token) {
      throw new Error('MUNICIBID_LOCK_CHANGED_DURING_TERMINAL_VERIFICATION');
    }
    const q = await this._queue();
    await q.drop();
    this.queue = await this.openLockQueue();
    this.log.warning?.('Municibid stale lock recycled only after prior run terminal verification', {
      priorOwner: existingLease.owner_run_id,
      priorStatus: result?.status || 'TERMINAL',
      expiredAt: existingLease.expires_at,
    });
    return this.queue;
  }

  async acquire() {
    if (!this.enabled) return { acquired: false, disabled: true };
    let q = await this._queue();
    const now = nowMs();
    const existingLease = await this.kv.getValue(RUN_LEASE_KEY);
    if (validLease(existingLease)) {
      const expiry = Date.parse(existingLease.expires_at);
      if (Number.isFinite(expiry) && expiry > now && existingLease.owner_run_id !== this.runId) {
        if (!this.verifyPriorRunTerminal) throw new Error(`MUNICIBID_ACTIVE_RUN_LEASE_HELD:${existingLease.owner_run_id}:${existingLease.expires_at}`);
        // A SIGKILL leaves a fresh lease behind. TTL alone does not prove
        // the prior run is still active: ask Apify before rejecting a retry.
        q = await this._recycleStaleQueue(existingLease);
      }
      if (Number.isFinite(expiry) && expiry <= now && existingLease.owner_run_id !== this.runId) {
        q = await this._recycleStaleQueue(existingLease);
      }
    }

    const acquiredAt = nowIso();
    const added = await q.addRequest({
      url: 'https://municibid-lock.invalid/active-run',
      uniqueKey: RUN_LOCK_UNIQUE_KEY,
      userData: { owner_run_id: this.runId, acquired_at: acquiredAt },
    });

    if (added.wasAlreadyPresent) {
      const held = await q.getRequest(added.requestId);
      const owner = held?.userData?.owner_run_id || existingLease?.owner_run_id || 'unknown';
      if (owner !== this.runId) {
        throw new Error(`MUNICIBID_ACTIVE_RUN_LEASE_HELD:${owner}:${existingLease?.expires_at || 'unknown'}`);
      }
    }

    const request = await q.getRequest(added.requestId);
    if (!request || request.userData?.owner_run_id !== this.runId) {
      throw new Error(`MUNICIBID_ATOMIC_LOCK_OWNERSHIP_FAILED:${request?.userData?.owner_run_id || 'unknown'}`);
    }

    const fenceToken = `${added.requestId}:${this.runId}:${acquiredAt}`;
    const lease = {
      version: 3,
      owner_run_id: this.runId,
      lock_request_id: added.requestId,
      fence_token: fenceToken,
      acquired_at: acquiredAt,
      renewed_at: acquiredAt,
      expires_at: new Date(now + this.ttlMs).toISOString(),
    };
    await this.kv.setValue(RUN_LEASE_KEY, lease);
    const verified = await this.kv.getValue(RUN_LEASE_KEY);
    if (!validLease(verified) || verified.owner_run_id !== this.runId || verified.lock_request_id !== added.requestId || verified.fence_token !== fenceToken) {
      throw new Error(`MUNICIBID_ACTIVE_RUN_LEASE_RACE:${verified?.owner_run_id || 'unknown'}`);
    }
    this.lockRequestId = added.requestId;
    this.fenceToken = fenceToken;
    this.acquired = true;
    return { acquired: true, lease: verified, authoritative_lock: 'APIFY_NAMED_REQUEST_QUEUE_UNIQUE_KEY', fence_token: fenceToken };
  }

  async assertOwned() {
    if (!this.enabled || !this.acquired) return;
    const current = await this.kv.getValue(RUN_LEASE_KEY);
    if (!validLease(current)
      || current.owner_run_id !== this.runId
      || current.lock_request_id !== this.lockRequestId
      || current.fence_token !== this.fenceToken) {
      throw new Error(`MUNICIBID_ACTIVE_RUN_LEASE_LOST:${current?.owner_run_id || 'unknown'}`);
    }
    const q = await this._queue();
    const lockRequest = await q.getRequest(this.lockRequestId);
    if (!lockRequest || lockRequest.userData?.owner_run_id !== this.runId) {
      throw new Error(`MUNICIBID_ACTIVE_RUN_ATOMIC_LOCK_LOST:${lockRequest?.userData?.owner_run_id || 'unknown'}`);
    }
  }

  async renew() {
    if (!this.enabled || !this.acquired) return;
    await this.assertOwned();
    const current = await this.kv.getValue(RUN_LEASE_KEY);
    const now = nowMs();
    await this.kv.setValue(RUN_LEASE_KEY, {
      ...current,
      renewed_at: nowIso(),
      expires_at: new Date(now + this.ttlMs).toISOString(),
    });
    await this.assertOwned();
  }

  snapshot() {
    return {
      enabled: this.enabled,
      acquired: this.acquired,
      owner_run_id: this.runId,
      lock_request_id: this.lockRequestId,
      fence_token: this.fenceToken,
    };
  }

  async release() {
    if (!this.enabled || !this.acquired) return;
    const current = await this.kv.getValue(RUN_LEASE_KEY);
    if (validLease(current)
      && current.owner_run_id === this.runId
      && current.lock_request_id === this.lockRequestId
      && current.fence_token === this.fenceToken) {
      await this.kv.setValue(RUN_LEASE_KEY, null);
      try {
        const q = await this._queue();
        await q.drop();
      } catch (err) {
        this.log.warning?.('Municibid atomic lock queue release failed', { error: err.message });
      }
    }
    this.acquired = false;
    this.lockRequestId = null;
    this.fenceToken = null;
  }
}