import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IDBClient } from '../dist/operation/idb-client.js';
import { tools } from '../dist/mcp/registry.js';
import { coordinateMapping } from '../dist/image/coordinate-mapping.js';

test('text and file paths remain literal arguments, including shell and option syntax', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'isimbot-safe-'));
  const oldPath = process.env.PATH;
  const log = join(dir, 'args');
  const marker = join(dir, 'injected');
  writeFileSync(join(dir, 'idb'), `#!${process.execPath}\nimport('node:fs').then(fs => { fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2))); console.log('{"screen_scale":3}'); });\n`, { mode: 0o755 });
  process.env.PATH = `${dir}:${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; rmSync(dir, { recursive: true, force: true }); });
  const client = new IDBClient(); client.udid = 'device';
  const text = `--help \"; $(touch ${marker}) \u0060touch ${marker}\u0060\nnext line`;
  await client.typeText(text);
  assert.deepEqual(JSON.parse(readFileSync(log, 'utf8')), ['ui', 'text', '--udid', 'device', '--', text]);
  const path = join(dir, 'a $(whoami) "quote".png');
  await client.screenshot(path);
  assert.deepEqual(JSON.parse(readFileSync(log, 'utf8')), ['screenshot', '--udid', 'device', '--json', '--', path]);
  assert.deepEqual(client.getScreenshotGeometry(path), { udid: 'device', scale: 3 });
  assert.equal(client.getScreenshotGeometry(path), undefined);
  assert.equal(existsSync(marker), false);
});

test('direct and chain calls reject invalid arguments before side effects', async () => {
  const calls = [];
  const client = new Proxy({}, { get: (_, method) => async () => calls.push(method) });
  for (const [name, args] of [
    ['tap', { x: NaN, y: 2 }], ['long_press', { x: 1, y: 2, duration: -1 }],
    ['get_logs', { lines: 1.5 }], ['set_location', { latitude: 91, longitude: 0 }],
    ['type_text', { text: 'bad\0text' }], ['install_app', { appPath: '' }],
  ]) await assert.rejects(tools.find(t => t.definition.name === name).execute(client, args, {}));
  const chain = tools.find(t => t.definition.name === 'operation_chain');
  await assert.rejects(chain.execute(client, { steps: [
    { tool: 'tap', arguments: { x: 1, y: 2 }, delay: 0 },
    { tool: 'swipe', arguments: { x1: 1, y1: 2, x2: 3, y2: 4, duration: -1 } },
  ] }, {}));
  assert.deepEqual(calls, []);
});

test('coordinate mapping uses actual rounded dimensions for portrait and landscape', () => {
  for (const [w, h] of [[1206, 2622], [2622, 1206]]) {
    for (const scale of [0.2, 0.5, 0.6, 1, 2]) {
      const rw = Math.round(w * scale), rh = Math.round(h * scale);
      const map = coordinateMapping(w, h, rw, rh, { udid: 'device', scale: 3 });
      assert.equal(map.available, true);
      assert.equal(map.touchSize.width, w / 3);
      assert.ok(Math.abs(rw * map.touchPointsPerReturnedPixel.x - w / 3) < 1e-10);
      assert.ok(Math.abs(rh * map.touchPointsPerReturnedPixel.y - h / 3) < 1e-10);
    }
  }
  for (const scale of [undefined, 0, NaN, Infinity, -1]) {
    assert.equal(coordinateMapping(1206, 2622, 724, 1573, scale === undefined ? undefined : { scale, udid: 'device' }).available, false);
  }
});

test('screenshot responses expose mapping and explicitly flag missing backend geometry', async t => {
  const { default: sharp } = await import('sharp');
  const { screenshotResult } = await import('../dist/mcp/screenshot-response.js');
  const dir = mkdtempSync(join(tmpdir(), 'isimbot-mapping-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'image.png');
  await sharp({ create: { width: 1206, height: 2622, channels: 3, background: '#222222' } }).png().toFile(path);
  const settings = { mode: 'pixel', format: 'png', quality: 80, maxBytes: 2000000, maxSavedImages: 200 };
  for (const geometry of [undefined, { udid: 'device', scale: 3 }]) {
    const response = await screenshotResult(path, settings, geometry);
    const metadata = response.structuredContent.deviceInfo;
    assert.equal(response.content[0].type, 'image');
    assert.equal(metadata.scale, geometry ? 3 : null);
    if (geometry) {
      assert.deepEqual(metadata.screenSize, { width: 402, height: 874 });
      assert.deepEqual(response.structuredContent.imageSize, { width: 1206, height: 2622 });
    }
  }
});
