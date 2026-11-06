import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IDBClient } from '../dist/operation/idb-client.js';
import { tools } from '../dist/mcp/registry.js';

test('app operations target the selected device, preserve literal URLs and parse JSON/NDJSON', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'isimbot-apps-'));
  const oldPath = process.env.PATH;
  const log = join(dir, 'args'), output = join(dir, 'output'), marker = join(dir, 'injected');
  writeFileSync(output, '');
  writeFileSync(join(dir, 'idb'), `#!${process.execPath}
import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write(fs.readFileSync(${JSON.stringify(output)}));
`, { mode: 0o755 });
  process.env.PATH = `${dir}:${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; rmSync(dir, { recursive: true, force: true }); });
  const client = new IDBClient(); client.udid = 'device-A';
  const url = `myapp://page?literal=$(touch\u0024{IFS}${marker})&quote=';`;
  await client.openUrl(url);
  assert.deepEqual(JSON.parse(readFileSync(log)), ['open', '--udid', 'device-A', '--', url]);
  assert.equal(existsSync(marker), false);
  const raw = [{bundle_id:'app.one', name:'中文 App',install_type:'user',process_state:'Running'}, {bundle_id:'app.two'}];
  const expected = [{bundleId:'app.one',name:'中文 App',installType:'user',processState:'Running'}, {bundleId:'app.two',name:null,installType:null,processState:null}];
  for (const text of [JSON.stringify(raw), raw.map(x => JSON.stringify(x)).join('\n')]) {
    writeFileSync(output, text);
    assert.deepEqual(await client.listApps(), expected);
    assert.deepEqual(JSON.parse(readFileSync(log)), ['list-apps','--udid','device-A','--json','--fetch-process-state']);
  }
  writeFileSync(output, ''); assert.deepEqual(await client.listApps(), []);
  for (const invalid of ['[{}]', '{"bundle_id":null}', 'not json']) {
    writeFileSync(output, invalid); await assert.rejects(client.listApps());
  }
  for (const invalid of ['--help', 'example.com', 'https://example.com/a b', 'https://x/\n']) {
    await assert.rejects(client.openUrl(invalid));
  }
});

test('new app tools work in chains and invalid URLs fail preflight before earlier actions', async () => {
  const chain = tools.find(t => t.definition.name === 'operation_chain');
  const calls = [];
  const fake = { listApps: async () => { calls.push('list'); return [{bundleId:'app.one'}]; }, openUrl: async url => calls.push(url) };
  const result = await chain.execute(fake, {steps:[{tool:'list_apps',interval:0},{tool:'open_url',arguments:{url:'myapp://page'},interval:0}]}, {});
  assert.ok(!result.isError);
  assert.deepEqual(calls, ['list','myapp://page']);
  calls.length = 0;
  await assert.rejects(chain.execute(fake, {steps:[{tool:'list_apps',interval:0},{tool:'open_url',arguments:{url:'missing-scheme'},interval:0}]}, {}));
  assert.deepEqual(calls, []);
});

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
  assert.deepEqual(calls,[['list-apps','--udid','chosen-device','--json','--fetch-process-state'],['launch','--udid','chosen-device','--foreground-if-running',bundleId],['list-apps','--udid','chosen-device','--json','--fetch-process-state']]);
});

test('list_apps defaults to user installation type and supports all/system in direct and chain calls', async () => {
 const list=tools.find(t=>t.definition.name==='list_apps');
 const apps=[{bundleId:'com.apple.user-example',installType:'user'},
   {bundleId:'third.party.system-example',installType:'system'},
   {bundleId:'custom.uppercase',installType:'User'},
   {bundleId:'unknown',installType:null}];
 let calls=0;const client={listApps:async()=>{calls++;return apps;}};
 assert.deepEqual((await list.execute(client,{},{})).apps,[apps[0],apps[2]]);
 assert.deepEqual((await list.execute(client,{installType:'system'},{})).apps,[apps[1]]);
 assert.deepEqual((await list.execute(client,{installType:'all'},{})).apps,apps);
 const before=calls;
 await assert.rejects(list.execute(client,{installType:'invalid'},{}));assert.equal(calls,before);
 const chain=await tools.find(t=>t.definition.name==='operation_chain').execute(client,{steps:[{tool:'list_apps',arguments:{installType:'system'},interval:0}]},{});
 assert.deepEqual(chain.structuredContent.events[0].result.apps,[apps[1]]);
});
