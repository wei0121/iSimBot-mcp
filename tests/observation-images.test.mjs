import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveObservationCapture, readObservationCapture, deleteObservationCapture } from '../dist/storage/observation-images.js';

test('observation images round-trip independently of JSON and report deleted media', t => {
  const dir = mkdtempSync(join(tmpdir(), 'isimbot-observation-images-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const data = Buffer.from('observation-image-fixture').toString('base64');
  const capture = saveObservationCapture(dir, 'session_1234abcd', 0, {
    content: [{ type: 'image', mimeType: 'image/png', data }], structuredContent: { elements: [] },
  });
  const restored = JSON.parse(JSON.stringify(capture));
  assert.equal(JSON.stringify(restored).includes(data), false);
  assert.deepEqual(readObservationCapture(dir, restored), [{ type: 'image', mimeType: 'image/png', data }]);
  assert.throws(() => saveObservationCapture(dir, 'session_1234abcd', 0, { content: [{ type: 'image', mimeType: 'image/png', data }] }), /EEXIST/);
  assert.equal(readObservationCapture(dir, restored)[0].data, data);
  deleteObservationCapture(dir, restored);
  assert.throws(() => readObservationCapture(dir, restored), /ENOENT/);
});

test('observation image references reject outside paths and symlinks', t => {
  const dir = mkdtempSync(join(tmpdir(), 'isimbot-observation-images-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const outside = join(dir, 'private.txt'); writeFileSync(outside, 'private');
  const capture = saveObservationCapture(dir, 'session_1234abcd', 0, { content: [{ type: 'image', mimeType: 'image/png', data: 'aGk=' }] });
  assert.throws(() => readObservationCapture(dir, { images: [{ path: outside, mimeType: 'image/png' }] }), /Invalid observation image reference/);
  rmSync(capture.images[0].path); symlinkSync(outside, capture.images[0].path);
  assert.throws(() => readObservationCapture(dir, capture), /regular file/);
});
