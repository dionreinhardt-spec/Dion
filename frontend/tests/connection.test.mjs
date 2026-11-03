import test from 'node:test';
import assert from 'node:assert/strict';
import { TerminalConnection } from '../lib/connection.ts';
const flush = () => new Promise(resolve => setImmediate(resolve));
const snapshot = (time = 1000, tick = time) => ({ scanner: [], portfolio: {}, system: { last_tick_at: tick }, server_time: time });
function harness() {
  let clock = 0, serial = 0;
  const timers = new Map(), pending = [], sockets = [], seen = [], states = [];
  const runtime = {
    now: () => clock,
    fetch: (url, init) => new Promise(resolve => pending.push({ url, init, resolve })),
    socket: url => { const socket = { url, readyState: 0, sent: [], onopen: null, onclose: null, onerror: null, onmessage: null, send(data) { this.sent.push(data); }, close() { this.readyState = 3; this.onclose?.(); } }; sockets.push(socket); return socket; },
    interval: fn => { const id = ++serial; timers.set(id, { fn, repeat: true }); return id; },
    timeout: (fn, ms) => { const id = ++serial; timers.set(id, { fn, ms, at: clock + ms }); return id; },
    clearInterval: id => timers.delete(id), clearTimeout: id => timers.delete(id),
  };
  const connection = new TerminalConnection({ token: 'test-memory-token', wsURL: 'wss://intel.example.test/ws', runtime, onSnapshot: data => seen.push(data), onState: state => states.push(state) });
  return { connection, runtime, pending, sockets, seen, states,
    advance(ms) { clock += ms; for (const [id, timer] of [...timers]) { if (!timers.has(id)) continue; if (timer.repeat) timer.fn(); else if (clock >= timer.at) { timers.delete(id); timer.fn(); } } },
    reply(index, data, status = 200) { pending[index].resolve({ ok: status === 200, status, json: async () => data }); },
    frame(index, data) { sockets[index].readyState = 1; sockets[index].onmessage?.({ data: JSON.stringify(data) }); },
  };
}
test('foreground snapshot unlocks; standby immediately locks and aborts HTTP', async () => {
  const h = harness();h.connection.resume();assert.equal(h.connection.isFresh(), false);
  h.reply(0, snapshot());await flush();assert.equal(h.connection.isFresh(), true);
  h.connection.suspend();assert.equal(h.connection.isFresh(), false);assert.equal(h.sockets[0].readyState, 3);
  const reads = h.pending.length;h.advance(9000);assert.equal(h.pending.length, reads);
});
test('late pre-standby HTTP data cannot unlock or overwrite a resumed session', async () => {
  const h = harness();h.connection.resume();const oldSignal = h.pending[0].init.signal;
  h.connection.suspend();assert.equal(oldSignal.aborted, true);h.connection.resume();
  h.reply(0, snapshot(900));await flush();assert.equal(h.seen.length, 0);assert.equal(h.connection.isFresh(), false);
  h.reply(1, snapshot(1100));await flush();assert.equal(h.seen.length, 1);assert.equal(h.connection.isFresh(), true);
  h.connection.suspend();
});
test('API token is an authorization header and first socket frame, never a URL', () => {
  const h = harness();h.connection.resume();const socket = h.sockets[0];socket.readyState = 1;socket.onopen();
  assert.equal(h.pending[0].init.headers.Authorization, 'Bearer test-memory-token');assert.equal(h.pending[0].init.cache, 'no-store');
  assert.equal(socket.sent[0], '{"token":"test-memory-token"}');assert.equal(socket.url, 'wss://intel.example.test/ws');h.connection.suspend();
});
test('401 never unlocks paper actions', async () => {
  const h = harness();h.connection.resume();h.reply(0, {}, 401);await flush();assert.equal(h.connection.isFresh(), false);assert.match(h.states.at(-1).error, /API-Token/);h.connection.suspend();
});
test('new packet with stalled backend evaluation remains locked', async () => {
  const h = harness();h.connection.resume();h.reply(0, snapshot(1000, 990));await flush();assert.equal(h.connection.isFresh(), false);assert.match(h.states.at(-1).error, /Backend-Auswertung/);h.connection.suspend();
});
test('websocket silence locks after six seconds and switches to REST', async () => {
  const h = harness();h.connection.resume();h.frame(0, snapshot(1001));assert.equal(h.connection.isFresh(), true);
  h.reply(0, snapshot(1000));await flush();h.advance(7000);assert.equal(h.connection.isFresh(), false);assert.equal(h.sockets[0].readyState, 3);
  h.reply(1, snapshot(1009));await flush();assert.equal(h.connection.isFresh(), true);assert.equal(h.states.at(-1).transport, 'REST · 1s');h.connection.suspend();
});
test('late REST result cannot replace a more recent websocket snapshot', async () => {
  const h = harness();h.connection.resume();h.frame(0, snapshot(1100));h.reply(0, snapshot(1000));await flush();assert.deepEqual(h.seen.map(x => x.server_time), [1100]);h.connection.suspend();
});
test('repeated cached snapshots cannot extend freshness indefinitely', async () => {
  const h = harness();h.connection.resume();h.reply(0, snapshot(1000));await flush();h.advance(4000);h.frame(0, snapshot(1000));h.advance(3000);assert.equal(h.connection.isFresh(), false);h.connection.suspend();
});
test('a stopped token session ignores delayed socket callbacks', () => {
  const h = harness();h.connection.resume();const callback = h.sockets[0].onmessage;h.connection.suspend();callback({ data: JSON.stringify(snapshot(1000)) });assert.equal(h.seen.length, 0);assert.equal(h.connection.isFresh(), false);
});
test('malformed socket data fails closed', () => {
  const h = harness();h.connection.resume();h.frame(0, snapshot());h.sockets[0].onmessage({ data: 'not-json' });assert.equal(h.connection.isFresh(), false);assert.match(h.states.at(-1).error, /Stream getrennt|Datenpaket/);h.connection.suspend();
});
