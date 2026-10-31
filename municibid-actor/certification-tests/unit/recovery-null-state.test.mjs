import assert from 'node:assert/strict';
import { MunicibidRecoveryState } from '../../src/municibid/recovery.js';
const kv = { async getValue() { return null; }, async setValue() {} };
const rs = new MunicibidRecoveryState(kv, { log: console });
assert.equal(await rs.markFailed({ manifest: {} }), null, 'markFailed before initialize must not throw');
console.log('PASS recovery finalize is safe before initialization');