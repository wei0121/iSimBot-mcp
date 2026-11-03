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
  const bundleId = 'com.example.app; echo unexpected';
  writeFileSync(join(dir, 'idb'), `#!${process.execPath}\nimport('node:fs').then(fs=>{const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');if(args[0]==='list-apps')console.log(JSON.stringify({bundle_id:${JSON.stringify(bundleId)},process_state:'Running'}));});\n`, { mode: 0o755 });
  process.env.PATH = `${dir}:${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; rmSync(dir, { recursive: true, force: true }); });
  const client = new IDBClient();
  client.udid = 'chosen-device';
  await client.launchApp(bundleId);
  const calls=readFileSync(log,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert.deepEqual(calls,[['launch','--udid','chosen-device','--foreground-if-running',bundleId],['list-apps','--udid','chosen-device','--json','--fetch-process-state']]);
});
