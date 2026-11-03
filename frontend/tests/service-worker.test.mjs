import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
function harness() {
  const handlers = {}, reads = [], writes = [];
  const cache = { addAll: async paths => writes.push(paths), match: async path => { reads.push(path); return { offline: true }; } };
  let networkFails = false;
  const context = { URL, Promise, caches: { open: async () => cache, keys: async () => [], delete: async () => true }, fetch: async () => { if (networkFails) throw new Error('offline'); return { online: true }; }, self: { location: { origin: 'https://intel.example.test' }, clients: { claim: async () => {} }, skipWaiting() {}, addEventListener: (name, fn) => handlers[name] = fn } };
  vm.runInNewContext(fs.readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), context);
  return { reads, writes, handlers, failNetwork() { networkFails = true; }, async request(path, mode = 'cors', method = 'GET', origin = 'https://intel.example.test') { let response;handlers.fetch({ request: { url: origin + path, mode, method }, respondWith: value => response = value });return response; } };
}
test('personal market data, portfolio/orders, auth requests and websocket are never intercepted or cached', async () => {
  const h = harness();
  for (const path of ['/api/snapshot','/api/paper/buy','/api/token/mint','/api/risk/kill','/ws','/metrics','/health/ready']) assert.equal(await h.request(path), undefined, path);
  assert.equal(await h.request('/api/paper/buy', 'cors', 'POST'), undefined);assert.equal(h.reads.length, 0);assert.equal(h.writes.length, 0);
});
test('offline navigation returns only a public empty-state page', async () => {
  const h = harness();h.failNetwork();assert.equal((await h.request('/', 'navigate')).offline, true);assert.deepEqual(h.reads, ['/offline.html']);
});
test('ordinary navigation uses the network, never saved trading HTML', async () => {
  const h = harness();assert.equal((await h.request('/', 'navigate')).online, true);assert.equal(h.reads.length, 0);
});
test('cross-origin requests are untouched', async () => {
  const h = harness();assert.equal(await h.request('/icons/icon-192.png', 'cors', 'GET', 'https://another.example.test'), undefined);
});
test('installation precaches only the offline page and public icons', async () => {
  const h = harness();let work;h.handlers.install({ waitUntil: promise => work = promise });await work;
  const paths = Array.from(h.writes[0]);assert.ok(paths.includes('/offline.html'));assert.ok(paths.every(path => path === '/offline.html' || path.startsWith('/icons/')));
});
