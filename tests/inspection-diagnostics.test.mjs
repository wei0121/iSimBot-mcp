import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tools } from '../dist/mcp/registry.js';
import { IDBClient } from '../dist/operation/idb-client.js';
import { ScreenshotSettingsStore } from '../dist/setting/screenshot-settings.js';
import { presentElements } from '../dist/mcp/element-presentation.js';
import { cleanCache } from '../dist/storage/clean-cache.js';
const tool=name=>tools.find(t=>t.definition.name===name);
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'isimbot-diagnostics-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}

test('describe_ui saves original JSON, paginates the same snapshot and only returns raw tree explicitly',async t=>{
 const dir=fixture(t),settings=new ScreenshotSettingsStore(join(dir,'screenshot.json'));
 const raw=Array.from({length:130},(_,i)=>({AXLabel:`Button ${i}`,AXUniqueId:`id${i}`,type:'Button',frame:{x:i,y:0,width:50,height:30}}));
 let reads=0;const client={describeUI:async()=>{reads++;return JSON.stringify(raw)}};
 const first=await tool('describe_ui').execute(client,{},settings);
 assert.equal(first.elements.length,50);assert.equal(first.nextOffset,50);assert.equal(first.elementCount,130);assert.equal(first.uiTree,undefined);
 assert.deepEqual(JSON.parse(readFileSync(first.path)),raw);
 const second=await tool('describe_ui').execute(client,{snapshotId:first.snapshotId,offset:50,limit:100},settings);
 assert.equal(second.elements.length,80);assert.equal(second.elements[0].elementId,'id50');assert.equal(second.nextOffset,null);assert.equal(reads,1);
 const full=await tool('describe_ui').execute(client,{snapshotId:first.snapshotId,detail:'raw'},settings);assert.deepEqual(full.uiTree,raw);
 const count=await tool('describe_ui').execute(client,{snapshotId:first.snapshotId,detail:'number'},settings);assert.equal(count.elementCount,130);assert.equal(count.elements,undefined);
 await assert.rejects(tool('describe_ui').execute(client,{snapshotId:'../../secret'},settings),e=>e.details.code==='INVALID_UI_SNAPSHOT');
 const outside=join(dir,'outside.json');writeFileSync(outside,'[]');const linked='ui-1793877566165-11111111-1111-1111-1111-111111111111.json';symlinkSync(outside,join(dir,'ui',linked));
 await assert.rejects(tool('describe_ui').execute(client,{snapshotId:linked},settings),e=>e.details.code==='UI_SNAPSHOT_UNAVAILABLE');
 cleanCache(settings);assert.equal(existsSync(first.path),false);assert.equal(existsSync(outside),true);
 await assert.rejects(tool('describe_ui').execute(client,{snapshotId:first.snapshotId},settings),e=>e.details.code==='UI_SNAPSHOT_UNAVAILABLE');
});

test('anonymous scrolling matches unique content and size without merging repeated labels',()=>{
 const node=(label,y,id=null)=>({identifier:id,label,type:'Button',frame:{x:0,y,width:100,height:40}});
 const before={elements:[node('Unique A',0),node('Unique B',50),node('Repeated',100),node('Repeated',150),node('Gone',200)]};
 const after={elements:[node('Unique A',-50),node('Unique B',0),node('Repeated',50),node('Repeated',100),node('New',150)]};
 const result=presentElements(after,before,'changes',true).elements;
 assert.deepEqual(result.filter(e=>e.changeTypes.includes('moved')).map(e=>e.text),['Unique A','Unique B']);
 assert.equal(result.filter(e=>e.text==='Repeated'&&e.changeTypes.includes('moved')).length,0);
 const many=Array.from({length:55},(_,i)=>node(`Row ${i}`,i*50));
 const changes=presentElements({elements:many.map(e=>({...e,frame:{...e.frame,y:e.frame.y-20}}))},{elements:many},'changes',true).elements;
 assert.equal(changes.length,55);assert.ok(changes.every(e=>e.changeTypes.join()==='moved'));
});

test('invalid coordinates explain one-sided bounds without undefined',async()=>{
 await assert.rejects(tool('tap').execute({}, {x:-1,y:0},{}),e=>/x must be at least 0/.test(e.message)&&!e.message.includes('undefined'));
});

test('install diagnoses paths and terminate distinguishes missing, stopped and still running apps',async t=>{
 const dir=fixture(t),client=new IDBClient();client.udid='device';
 await assert.rejects(client.installApp(join(dir,'missing.app')),e=>e.details.code==='APP_PATH_NOT_FOUND'&&!e.message.includes('Traceback'));
 const invalid=join(dir,'invalid.app');mkdirSync(invalid);await assert.rejects(client.installApp(invalid),e=>e.details.code==='INVALID_APP_BUNDLE');
 client.listApps=async()=>[];await assert.rejects(client.terminateApp('app.test'),e=>e.details.code==='APP_NOT_INSTALLED');
 client.listApps=async()=>[{bundleId:'app.test',processState:'Not running'}];assert.deepEqual(await client.terminateApp('app.test'),{terminated:false,alreadyStopped:true,confirmed:true});
 const old=process.env.PATH;writeFileSync(join(dir,'idb'),`#!${process.execPath}\nprocess.exit(0);`,{mode:0o755});process.env.PATH=`${dir}:${old}`;t.after(()=>{process.env.PATH=old});
 client.listApps=async()=>[{bundleId:'app.test',processState:'Running'}];await assert.rejects(client.terminateApp('app.test'),e=>e.details.code==='APP_STILL_RUNNING');
 client.listApps=async()=>[{bundleId:'app.test',processState:null}];assert.deepEqual(await client.terminateApp('app.test'),{terminated:null,alreadyStopped:false,confirmed:false});
 let n=0;client.listApps=async()=>[{bundleId:'app.test',processState:++n<=2?'Running':'Not running'}];assert.deepEqual(await client.terminateApp('app.test'),{terminated:true,alreadyStopped:false,confirmed:true});
});

test('get_logs uses historical simulator logs, literal process argv, bounded timestamp window and trailing lines',async t=>{
 const dir=fixture(t),old=process.env.PATH,log=join(dir,'args');
 writeFileSync(join(dir,'xcrun'),`#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2)));console.log('one\\ntwo\\nthree');`,{mode:0o755});
 process.env.PATH=`${dir}:${old}`;t.after(()=>{process.env.PATH=old});
 const client=new IDBClient();client.udid='9DF5FF83-1E6C-44D8-BC9C-AA9EDDD2F017';
 assert.equal(await client.getLogs(2,5,'app; echo unsafe'),'two\nthree');
 assert.deepEqual(JSON.parse(readFileSync(log)),['simctl','spawn',client.udid,'log','show','--last','5s','--style','compact','--info','--process','app; echo unsafe']);
 const result=await tool('get_logs').execute(client,{lines:1,lastSeconds:5},{});assert.equal(result.source,'simulator_unified_log');assert.equal(result.logs,'three');
 client.udid='real-device';await assert.rejects(client.getLogs(),e=>e.details.code==='LOGS_UNSUPPORTED_DEVICE');
});

test('orientation timeout retries the read once, sends no duplicate touch and reports bounded failure',async t=>{
 const dir=fixture(t),old=process.env.PATH,count=join(dir,'count'),touches=join(dir,'touches');
 writeFileSync(join(dir,'xcrun'),`#!${process.execPath}\nconst fs=require('node:fs'),a=process.argv.slice(2);if(a.includes('devicectl')){console.log(JSON.stringify({result:{displays:[{currentOrientation:"rot0"}]}}));}else{let n=fs.existsSync(${JSON.stringify(count)})?Number(fs.readFileSync(${JSON.stringify(count)})):0;fs.writeFileSync(${JSON.stringify(count)},String(n+1));if(n===0)setTimeout(()=>{},15000);else console.log(JSON.stringify({orientation:1,width:402,height:874}));}`,{mode:0o755});
 writeFileSync(join(dir,'idb'),`#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(touches)},'touch\\n');`,{mode:0o755});
 process.env.PATH=`${dir}:${old}`;t.after(()=>{process.env.PATH=old});
 const client=new IDBClient();client.udid='9DF5FF83-1E6C-44D8-BC9C-AA9EDDD2F017';
 await client.tap(10,20);assert.equal(readFileSync(count,'utf8'),'2');assert.equal(readFileSync(touches,'utf8'),'touch\n');
 writeFileSync(join(dir,'xcrun'),`#!${process.execPath}\nsetTimeout(()=>{},15000);`,{mode:0o755});
 const started=Date.now();await assert.rejects(client.tap(10,20),e=>e.details.code==='DISPLAY_GEOMETRY_UNAVAILABLE'&&e.details.attempts===2&&e.details.retryable===true);
 assert.ok(Date.now()-started<13000);assert.equal(readFileSync(touches,'utf8'),'touch\n');
});
