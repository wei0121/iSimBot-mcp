import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveTimelineCapture, readTimelineCapture, deleteTimelineCapture } from '../dist/storage/timeline-images.js';

test('observation images round-trip independently of JSON and report deleted media', t => {
  const dir = mkdtempSync(join(tmpdir(), 'isimbot-observation-images-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const data = Buffer.from('observation-image-fixture').toString('base64');
  const capture = saveTimelineCapture(dir, 'session_1234abcd', 0, {
    content: [{ type: 'image', mimeType: 'image/png', data }], structuredContent: { elements: [] },
  });
  const restored = JSON.parse(JSON.stringify(capture));
  assert.equal(JSON.stringify(restored).includes(data), false);
  assert.deepEqual(readTimelineCapture(dir, restored), [{ type: 'image', mimeType: 'image/png', data }]);
  assert.throws(() => saveTimelineCapture(dir, 'session_1234abcd', 0, { content: [{ type: 'image', mimeType: 'image/png', data }] }), /EEXIST/);
  assert.equal(readTimelineCapture(dir, restored)[0].data, data);
  deleteTimelineCapture(dir, restored);
  assert.throws(() => readTimelineCapture(dir, restored), /ENOENT/);
});

test('observation image references reject outside paths and symlinks', t => {
  const dir = mkdtempSync(join(tmpdir(), 'isimbot-observation-images-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const outside = join(dir, 'private.txt'); writeFileSync(outside, 'private');
  const capture = saveTimelineCapture(dir, 'session_1234abcd', 0, { content: [{ type: 'image', mimeType: 'image/png', data: 'aGk=' }] });
  assert.throws(() => readTimelineCapture(dir, { images: [{ path: outside, mimeType: 'image/png' }] }), /Invalid timeline image reference/);
  rmSync(capture.images[0].path); symlinkSync(outside, capture.images[0].path);
  assert.throws(() => readTimelineCapture(dir, capture), /regular file/);
});
