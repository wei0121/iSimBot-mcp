import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { ScreenshotSettingsStore, defaults } from '../dist/setting/screenshot-settings.js';
import { screenshotResult } from '../dist/mcp/screenshot-response.js';
import { createServer } from '../dist/mcp/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'isimbot-image-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
test('settings reads are side-effect free; updates persist; invalid settings do not overwrite', t => {
  const path = join(fixture(t), 'screenshot.json');
  const store = new ScreenshotSettingsStore(path);
  assert.deepEqual(store.update({}), defaults);
  assert.equal(existsSync(path), false);
  store.update({ scale: 0.2 });
  assert.equal(new ScreenshotSettingsStore(path).read().scale, 0.2);
  const original = readFileSync(path, 'utf8');
  for (const patch of [{ scale: 0 }, { scale: 5 }, { scale: '2x' }, { maxWidth: 100 }, { format: 'gif' }, { quality: 3 }, { maxBytes: -1 }, { maxSavedImages: 0 }, { maxSavedImages: 1.5 }, { maxSavedImages: 10001 }]) {
    assert.throws(() => store.update(patch));
    assert.equal(readFileSync(path, 'utf8'), original);
  }
  writeFileSync(path, 'broken');
  assert.throws(() => store.update({ scale: 2 }));
  assert.equal(readFileSync(path, 'utf8'), 'broken');
});
test('PNG output honors 1x, 2x, 0.5x, 0.2x and keeps original intact', async t => {
  const path = join(fixture(t), 'original.png');
  await sharp({ create: { width: 200, height: 400, channels: 3, background: '#abcdef' } }).png().toFile(path);
  const original = readFileSync(path);
  for (const scale of [1, 2, 0.5, 0.2]) {
    const result = await screenshotResult(path, { ...defaults, scale });
    const metadata = JSON.parse(result.content[0].text);
    const image = result.content[1];
    assert.equal(image.type, 'image');
    assert.equal(image.mimeType, 'image/png');
    const bytes = Buffer.from(image.data, 'base64');
    const decoded = await sharp(bytes).metadata();
    assert.equal(decoded.width, 200 * scale);
    assert.equal(decoded.height, 400 * scale);
    assert.equal(metadata.bytes, bytes.length);
    assert.equal(metadata.base64Bytes, image.data.length);
    assert.equal(metadata.originalPixelsPerReturnedPixel.x, 1 / scale);
    assert.deepEqual(readFileSync(path), original);
  }
});
test('byte cap fails explicitly instead of changing scale; JPEG returns valid bytes', async t => {
  const path = join(fixture(t), 'noise.png');
  await sharp(randomBytes(200 * 400 * 3), { raw: { width: 200, height: 400, channels: 3 } }).png().toFile(path);
  await assert.rejects(screenshotResult(path, { ...defaults, maxBytes: 10000 }), /requested scale/);
  const result = await screenshotResult(path, { ...defaults, format: 'jpeg' });
  assert.equal(result.content[1].mimeType, 'image/jpeg');
  assert.equal((await sharp(Buffer.from(result.content[1].data, 'base64')).metadata()).format, 'jpeg');
});
test('MCP setup configures subsequent image responses, survives server recreation, propagates errors', async t => {
  const dir = fixture(t);
  const path = join(dir, 'screen.png');
  const settingsPath = join(dir, 'settings.json');
  await sharp({ create: { width: 200, height: 400, channels: 3, background: 'white' } }).png().toFile(path);
  const fake = { screenshot: async output => { copyFileSync(path, output); return output; } };
  for (const restart of [false, true]) {
    const server = createServer(fake, new ScreenshotSettingsStore(settingsPath));
    const client = new Client({ name: 'test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(a); await client.connect(b);
      const response = await client.callTool({ name: 'setup', arguments: restart ? {} : { scale: 0.5 } });
      assert.equal(JSON.parse(response.content[0].text).configuration.scale, 0.5);
      const image = await client.callTool({ name: 'screenshot', arguments: {} });
      assert.equal(image.content[1].type, 'image');
      assert.equal(JSON.parse(image.content[0].text).returnedWidth, 100);
      const bad = await client.callTool({ name: 'setup', arguments: { scale: -1 } });
      assert.equal(bad.isError, true);
    } finally { await client.close(); await server.close(); }
  }
});
