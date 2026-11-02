import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IDBClient } from '../dist/operation/idb-client.js';

test('launch passes selected UDID before bundle ID and never interprets shell syntax', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'isimbot-launch-'));
  const oldPath = process.env.PATH;
  const log = join(dir, 'args');
  writeFileSync(join(dir, 'idb'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\n`, { mode: 0o755 });
  process.env.PATH = `${dir}:${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; rmSync(dir, { recursive: true, force: true }); });
  const client = new IDBClient();
  client.udid = 'chosen-device';
  const bundleId = 'com.example.app; echo unexpected';
  await client.launchApp(bundleId);
  assert.deepEqual(readFileSync(log, 'utf8').trimEnd().split('\n'), ['launch', '--udid', 'chosen-device', bundleId]);
});
