/** Validate generated metadata and shipped public assets after `next build`. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const html = fs.readFileSync('.next/server/app/index.html', 'utf8');
const manifest = JSON.parse(fs.readFileSync('.next/server/app/manifest.webmanifest.body', 'utf8'));
assert.equal(manifest.display, 'standalone');
assert.equal(manifest.start_url, '/');
assert.equal(manifest.scope, '/');
assert.match(html, /name="viewport" content="[^"]*viewport-fit=cover/);
assert.doesNotMatch(html, /maximum-scale=1|user-scalable=no/);
assert.match(html, /rel="manifest" href="\/manifest.webmanifest"/);
assert.match(html, /rel="apple-touch-icon"[^>]+href="\/icons\/apple-touch-icon.png"/);
assert.match(html, /name="apple-mobile-web-app-title" content="Axiom Intel"/);
assert.ok(fs.existsSync('.next/server/app/install.html'));
for (const icon of [...manifest.icons, { src: '/icons/apple-touch-icon.png', sizes: '180x180' }]) {
  const filename = path.join('public', icon.src);
  const buffer = fs.readFileSync(filename);
  assert.equal(buffer.subarray(1, 4).toString(), 'PNG', filename);
  const dimensions = icon.sizes.split('x').map(Number);
  assert.equal(buffer.readUInt32BE(16), dimensions[0], filename);
  assert.equal(buffer.readUInt32BE(20), dimensions[1], filename);
}
assert.ok(fs.existsSync('public/sw.js'));
assert.ok(fs.existsSync('public/offline.html'));
console.log('Generated PWA metadata, safe viewport, install route and four icon dimensions verified.');
