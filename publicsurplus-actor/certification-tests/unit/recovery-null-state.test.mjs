// Run: node certification-tests/unit/recovery-null-state.test.mjs
import assert from 'node:assert/strict';
import { PublicSurplusRecoveryState } from '../../src/publicsurplus/recovery.js';
const kv = { async getValue() { return null; }, async setValue() {} };
const rs = new PublicSurplusRecoveryState(kv, { log: console });
assert.equal(await rs.markFailed({ manifest: {} }), null, 'markFailed before initialize must not throw');
assert.equal(await rs.markIncomplete({}), null);
console.log('PASS recovery finalize is safe before initialization');