import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {IDBClient} from '../dist/operation/idb-client.js';
import {appIsRunning,waitUntilRunning} from '../dist/operation/readiness.js';
import {tools} from '../dist/mcp/registry.js';

test('readiness polls until Running, distinguishes target and times out',async()=>{
  assert.equal(appIsRunning('{"bundle_id":"other","process_state":"Running"}', 'target'),false);
  assert.equal(appIsRunning('[{"bundle_id":"target","process_state":"Not running"}]','target'),false);
  assert.equal(appIsRunning('{"bundle_id":"other","process_state":"Running"}\n{"bundle_id":"target","process_state":"Running"}','target'),true);
  let queries=0;
  await waitUntilRunning(async remaining=>{assert.ok(remaining>0);return ++queries===3;},100,1);
  assert.equal(queries,3);
  await assert.rejects(waitUntilRunning(async()=>false,10,1),/Launch may have occurred/);
  await assert.rejects(waitUntilRunning(async()=>{throw new Error('backend unavailable');}),/backend unavailable/);
});

test('backend passes injection strings literally, sends gestures once, and waits for bootstatus',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'isimbot-backend-'));const log=join(dir,'args');
  const oldPath=process.env.PATH; t.after(()=>{process.env.PATH=oldPath;rmSync(dir,{recursive:true,force:true});});
  const binary=`#!${process.execPath}\nimport('node:fs').then(fs=>fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2))+'\\n'));\n`;
  for(const name of ['idb','xcrun'])writeFileSync(join(dir,name),binary,{mode:0o755});
  process.env.PATH=`${dir}:${oldPath}`;
  const client=new IDBClient(),marker=join(dir,'INJECTED');
  const attack=`\\$(touch ${marker}); \u0060touch ${marker}\u0060 " ' & |\n--help`;
  await client.connect(attack);
  await client.typeText(attack);
  let listCalls=0;client.listApps=async()=>[{bundleId:attack,processState:++listCalls<=2?'Running':'Not running'}];
  await client.terminateApp(attack);
  await client.uninstallApp(attack);
  const appPath=join(dir,`a \\$(touch INJECTED) "quoted".app`);
  mkdirSync(appPath);writeFileSync(join(appPath,'Info.plist'),'test');
  await client.installApp(appPath);
  await client.tap(10,20);await client.swipe(1,2,3,4);
  await client.bootSimulator(attack);
  const calls=readFileSync(log,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert.deepEqual(calls,[
    ['connect','--',attack],['ui','text','--udid',attack,'--',attack],
    ['terminate','--udid',attack,'--',attack],['uninstall','--udid',attack,'--',attack],
    ['install','--udid',attack,'--',appPath],
    ['ui','tap','--udid',attack,'--duration','0.1','--','10','20'],
    ['ui','swipe','--udid',attack,'--duration','0.5','--','1','2','3','4'],
    ['simctl','bootstatus',attack,'-b'],
  ]);
  assert.equal(existsSync(marker),false);
  assert.ok(tools.some(t=>t.definition.name==='pinch'));
});
