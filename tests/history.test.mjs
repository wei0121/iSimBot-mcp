import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readdirSync, symlinkSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { ScreenshotSettingsStore } from '../dist/setting/screenshot-settings.js';
import { captureScreenshot } from '../dist/operation/screenshot.js';
import { historyDirectory } from '../dist/setting/screenshot-settings.js';
import { pruneScreenshots } from '../dist/storage/screenshot-history.js';
import { settingsTools } from '../dist/setting/setup.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'isimbot-history-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return new ScreenshotSettingsStore(join(dir, 'settings.json'));
}
test('defaults retain 200 newest managed files; unrelated files and symlinks survive', t => {
  const store = fixture(t), dir = historyDirectory(store);
  mkdirSync(dir);
  const names = Array.from({ length: 202 }, (_, i) => `isimbot-${1700000000000 + i}-${randomUUID()}.png`);
  for (const name of names) writeFileSync(join(dir, name), 'fixture');
  writeFileSync(join(dir, 'user.png'), 'user');
  writeFileSync(join(dir, '.pending-active.png'), 'pending');
  const link = join(dir, `isimbot-1700000000000-${randomUUID()}.png`);
  symlinkSync(join(dir, 'user.png'), link);
  assert.equal(pruneScreenshots(historyDirectory(store), store.read().maxSavedImages), 2);
  assert.equal(existsSync(join(dir, names[0])), false);
  assert.equal(existsSync(join(dir, names[2])), true);
  assert.equal(existsSync(link), true);
  assert.equal(existsSync(join(dir, 'user.png')), true);
  assert.equal(existsSync(join(dir, '.pending-active.png')), true);
});
test('setup read does not delete; lowering retention prunes immediately and persists', async t => {
  const store = fixture(t), dir = historyDirectory(store);
  mkdirSync(dir);
  for (let i = 0; i < 3; i++) writeFileSync(join(dir, `isimbot-${1700000000000 + i}-${randomUUID()}.png`), 'fixture');
  await settingsTools[0].execute({}, {}, store);
  assert.equal(readdirSync(dir).length, 3);
  const result = await settingsTools[0].execute({}, { maxSavedImages: 1 }, store);
  assert.equal(result.deletedOldImages, 2);
  assert.equal(new ScreenshotSettingsStore(store.path).read().maxSavedImages, 1);
  assert.equal(readdirSync(dir).length, 1);
});
test('captures return images before retention, clean failures, and preserve explicit paths', async t => {
  const store = fixture(t);
  store.update({ maxSavedImages: 2 });
  const source = join(join(store.path, '..'), 'source.png');
  await sharp({ create: { width: 50, height: 100, channels: 3, background: 'white' } }).png().toFile(source);
  const fake = { getScreenshotGeometry: () => ({udid:'device',scale:2}), screenshot: async path => { copyFileSync(source, path); return path; } };
  const results = await Promise.all(Array.from({ length: 4 }, () => captureScreenshot(fake, store)));
  for (const result of results) assert.equal(result.content[0].type, 'image');
  assert.equal(readdirSync(historyDirectory(store)).length, 2);
  const explicit = join(join(store.path, '..'), 'user-output.png');
  await captureScreenshot(fake, store, explicit);
  pruneScreenshots(historyDirectory(store), 1);
  assert.equal(existsSync(explicit), true);
  const failing = { screenshot: async path => { writeFileSync(path, 'partial'); throw new Error('capture failed'); } };
  await assert.rejects(captureScreenshot(failing, store), /capture failed/);
  assert.equal(readdirSync(historyDirectory(store)).some(name => name.startsWith('.pending-')), false);
});
test('history symlink is refused without touching its target', t => {
  const store = fixture(t);
  const target = join(join(store.path, '..'), 'other');
  mkdirSync(target);
  symlinkSync(target, historyDirectory(store));
  assert.throws(() => pruneScreenshots(historyDirectory(store), 1), /symbolic link/);
});
