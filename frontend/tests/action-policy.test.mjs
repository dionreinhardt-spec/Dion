import test from 'node:test';
import assert from 'node:assert/strict';
import { assertActionAllowed } from '../lib/action-policy.ts';
const connected = { path: '/api/paper/buy', fresh: true, visible: true, online: true, locked: false, secure: true };
test('stale data blocks paper orders and cannot resume automation', () => {
  for (const path of ['/api/paper/buy','/api/paper/token/close','/api/risk/kill?active=false']) {
    assert.throws(() => assertActionAllowed({ ...connected, path, fresh: false }), /Frische Verbindung/);
  }
});
test('manual STOP remains available even when analytics is stale', () => {
  assert.doesNotThrow(() => assertActionAllowed({ ...connected, fresh: false, path: '/api/risk/kill?active=true' }));
});
test('manual STOP cannot bypass a locked session', () => {
  assert.throws(() => assertActionAllowed({ ...connected, fresh: false, locked: true, path: '/api/risk/kill?active=true' }), /Sitzung gesperrt/);
});
test('all writes require HTTPS and a visible online session', () => {
  for (const path of ['/api/paper/buy','/api/risk/kill?active=true']) {
    for (const patch of [{ visible:false },{ online:false },{ secure:false }]) assert.throws(() => assertActionAllowed({ ...connected, path, ...patch }));
  }
});
test('fresh authenticated foreground session can request a paper trade', () => {
  assert.doesNotThrow(() => assertActionAllowed(connected));
});
