import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {IDBClient} from '../dist/operation/idb-client.js';
import {simulatorAppIsRunning} from '../dist/operation/readiness.js';
import {launchWithTextInput} from '../dist/operation/text-input.js';
const udid='11111111-1111-4111-8111-111111111111',bundle='app.test';
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'isimbot-lifecycle-')),old=process.env.PATH;t.after(()=>{process.env.PATH=old;rmSync(dir,{recursive:true,force:true})});const log=join(dir,'calls');process.env.PATH=dir+':'+old;return {dir,log,client:Object.assign(new IDBClient(),{udid})};}

test('simulator process parser matches exact bundle labels, ignores similarly named apps and rejects failed listings',()=>{
 const listing=rows=>'PID\tStatus\tLabel\n'+rows.join('\n');
 assert.equal(simulatorAppIsRunning(listing(['42\t0\tUIKitApplication:app.test[abcd][rb-legacy]']),bundle),true);
 assert.equal(simulatorAppIsRunning(listing(['-\t0\tUIKitApplication:app.test[abcd][rb-legacy]']),bundle),false);
 assert.equal(simulatorAppIsRunning(listing(['42\t0\tUIKitApplication:app.test.other[abcd]']),bundle),false);
 assert.equal(simulatorAppIsRunning(listing(['-\t0\tUIKitApplication:app.test[a]','45\t0\tUIKitApplication:app.test[b]']),bundle),true);
 for(const bad of ['', 'connection failed', 'PID Status Label\ntruncated', 'PID Status Label\n0 0 UIKitApplication:app.test[a]'])assert.throws(()=>simulatorAppIsRunning(bad,bundle));
});

test('both launch modes reject missing apps before launch and status failures have a concise code',async t=>{
 const {client,dir,log}=fixture(t);
 writeFileSync(join(dir,'idb'),`#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2))+'\\n');console.log('[]');`,{mode:0o755});
 for(const launch of [()=>client.launchApp(bundle),()=>launchWithTextInput(client,bundle)])await assert.rejects(launch(),e=>e.details.code==='APP_NOT_INSTALLED'&&e.details.bundleId===bundle&&e.message.length<250);
 const calls=readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);assert.ok(calls.every(a=>a[0]==='list-apps'));
 client.listApps=async()=>{throw Error('raw internal error '.repeat(100));};await assert.rejects(client.launchApp(bundle),e=>e.details.code==='APP_STATUS_UNAVAILABLE'&&!e.message.includes('raw internal error'));
});

test('backend launch errors are mapped without raw system output or retries',async t=>{
 const {client,dir,log}=fixture(t);client.listApps=async()=>[{bundleId:bundle}];
 writeFileSync(join(dir,'idb'),`#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(log)},'launch\\n');process.stderr.write('SYSTEM INTERNAL STACK '.repeat(100));process.exit(1);`,{mode:0o755});
 await assert.rejects(client.launchApp(bundle),e=>e.details.code==='APP_LAUNCH_FAILED'&&!e.message.includes('SYSTEM INTERNAL')&&e.message.length<250);
 assert.equal(readFileSync(log,'utf8'),'launch\n');
});

test('termination confirms actual simulator processes even when idb reports Unknown, waits for exit and sends once',async t=>{
 const {client,dir,log}=fixture(t),count=join(dir,'count');client.listApps=async()=>[{bundleId:bundle,processState:'Unknown'}];
 writeFileSync(join(dir,'idb'),`#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2))+'\\n');`,{mode:0o755});
 writeFileSync(join(dir,'xcrun'),`#!${process.execPath}\nconst fs=require('node:fs'),p=${JSON.stringify(count)};let n=0;try{n=Number(fs.readFileSync(p))}catch{};fs.writeFileSync(p,String(n+1));console.log('PID\\tStatus\\tLabel');if(n<2)console.log('42\\t0\\tUIKitApplication:app.test[instance][rb-legacy]');`,{mode:0o755});
 assert.deepEqual(await client.terminateApp(bundle),{terminated:true,alreadyStopped:false,confirmed:true});assert.equal(readFileSync(count,'utf8'),'3');
 assert.deepEqual(await client.terminateApp(bundle),{terminated:false,alreadyStopped:true,confirmed:true});
 const calls=readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);assert.deepEqual(calls,[['terminate','--udid',udid,'--',bundle]]);
});

test('failed/malformed process queries remain unconfirmed instead of being treated as stopped',async t=>{
 const {client,dir}=fixture(t);client.listApps=async()=>[{bundleId:bundle,processState:'Unknown'}];
 writeFileSync(join(dir,'idb'),`#!${process.execPath}\nprocess.exit(0);`,{mode:0o755});
 for(const body of ["console.log('bad response');","process.exit(1);"]){
  writeFileSync(join(dir,'xcrun'),`#!${process.execPath}\n${body}`,{mode:0o755});
  assert.deepEqual(await client.terminateApp(bundle),{terminated:null,alreadyStopped:false,confirmed:false});
 }
});
