import assert from 'node:assert/strict';
import { LiquidationRunLease } from '../../src/liquidation/lease.js';
const values = new Map(); const kv = { async getValue(k) { return values.get(k) ?? null; }, async setValue(k,v) { values.set(k,v); } };
let entries = new Map(), seq = 0;
const open = async () => ({
  async addRequest(r) { const prior = [...entries.values()].find(v => v.uniqueKey === r.uniqueKey); if(prior)return {requestId:prior.id,wasAlreadyPresent:true}; const id=String(++seq);entries.set(id,{...r,id});return {requestId:id,wasAlreadyPresent:false}; },
  async getRequest(id) { return entries.get(id); }, async drop() { entries = new Map(); },
});
const a = new LiquidationRunLease(kv, {runId:'old',openLockQueue:open}); await a.acquire();
const active = new LiquidationRunLease(kv, {runId:'new',openLockQueue:open,verifyPriorRunTerminal:async()=>({terminal:false,status:'RUNNING'})});
await assert.rejects(active.acquire(), /NOT_TERMINAL/); await a.assertOwned();
const unavailable = new LiquidationRunLease(kv, {runId:'new',openLockQueue:open,verifyPriorRunTerminal:async()=>{throw new Error('API unavailable');}});
await assert.rejects(unavailable.acquire(), /VERIFICATION_FAILED/); await a.assertOwned();
const retry = new LiquidationRunLease(kv, {runId:'retry',openLockQueue:open,verifyPriorRunTerminal:async()=>({terminal:true,status:'FAILED'}),log:{warning(){}}});
await retry.acquire(); await assert.rejects(a.assertOwned(), /LEASE_LOST/); await retry.release();
console.log('PASS active-owner protection, API-error protection, confirmed failed-owner recovery and fencing');