export const RUN_LEASE_KEY = 'PUBLICSURPLUS_ACTIVE_RUN_LEASE_V1';

function nowMs() { return Date.now(); }
function nowIso() { return new Date().toISOString(); }

function validLease(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && typeof value.owner_run_id === 'string'
    && typeof value.expires_at === 'string';
}

export class PublicSurplusRunLease {
  constructor(kvStore, {
    runId,
    ttlMs = 30 * 60 * 1000,
    enabled = true,
    log = console,
  } = {}) {
    this.kv = kvStore;
    this.runId = String(runId || 'unknown-run');
    this.ttlMs = Math.max(60_000, Number(ttlMs) || 30 * 60 * 1000);
    this.enabled = enabled !== false;
    this.log = log;
    this.acquired = false;
  }

  async acquire() {
    if (!this.enabled) return { acquired: false, disabled: true };
    const existing = await this.kv.getValue(RUN_LEASE_KEY);
    const now = nowMs();
    if (validLease(existing)) {
      const expiry = Date.parse(existing.expires_at);
      if (Number.isFinite(expiry) && expiry > now && existing.owner_run_id !== this.runId) {
        throw new Error(`PUBLICSURPLUS_ACTIVE_RUN_LEASE_HELD:${existing.owner_run_id}:${existing.expires_at}`);
      }
    }

    const lease = {
      version: 1,
      owner_run_id: this.runId,
      acquired_at: nowIso(),
      renewed_at: nowIso(),
      expires_at: new Date(now + this.ttlMs).toISOString(),
    };
    await this.kv.setValue(RUN_LEASE_KEY, lease);

    // Read-after-write verification reduces the chance that simultaneous runs both
    // proceed after racing on the same named KV state.
    const verified = await this.kv.getValue(RUN_LEASE_KEY);
    if (!validLease(verified) || verified.owner_run_id !== this.runId) {
      throw new Error(`PUBLICSURPLUS_ACTIVE_RUN_LEASE_RACE:${verified?.owner_run_id || 'unknown'}`);
    }
    this.acquired = true;
    return { acquired: true, lease: verified };
  }

  async renew() {
    if (!this.enabled || !this.acquired) return;
    const current = await this.kv.getValue(RUN_LEASE_KEY);
    if (!validLease(current) || current.owner_run_id !== this.runId) {
      throw new Error(`PUBLICSURPLUS_ACTIVE_RUN_LEASE_LOST:${current?.owner_run_id || 'unknown'}`);
    }
    const now = nowMs();
    await this.kv.setValue(RUN_LEASE_KEY, {
      ...current,
      renewed_at: nowIso(),
      expires_at: new Date(now + this.ttlMs).toISOString(),
    });
  }

  async release() {
    if (!this.enabled || !this.acquired) return;
    const current = await this.kv.getValue(RUN_LEASE_KEY);
    if (validLease(current) && current.owner_run_id === this.runId) {
      await this.kv.setValue(RUN_LEASE_KEY, null);
    }
    this.acquired = false;
  }
}