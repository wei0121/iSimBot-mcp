import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeviceManager, deviceToolDefinition } from '../dist/operation/device-manager.js';
import { tools } from '../dist/mcp/registry.js';
import { registerScreenshot, clearScreenshotCoordinates } from '../dist/image/screenshot-coordinates.js';
import { createServer } from '../dist/mcp/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ScreenshotSettingsStore } from '../dist/setting/screenshot-settings.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

function deferred() { let resolve; const promise=new Promise(r=>{resolve=r;});return {promise,resolve}; }
function fixture() {
  const events=[],clients=new Map(),stopped=new Set(),connects=[];
  class Fake {
    id=null;
    getConnectedDevice(){return this.id;}
    async connect(id){connects.push(id);if(id==='fail')throw new Error('connect failed');clearScreenshotCoordinates(this);this.id=id;clients.set(id,this);}
    async listDevices(){return ['A','B','fail','9DF5FF83-1E6C-44D8-BC9C-AA9EDDD2F017'].map(udid=>({udid,name:udid,state:stopped.has(udid)?'Shutdown':'Booted',type:'simulator'}));}
    async tap(x,y){events.push([this.id,x,y]);}
    async bootSimulator(id){stopped.delete(id);events.push(['boot',id]);}
    async shutdownSimulator(id){stopped.add(id);events.push(['shutdown',id]);}
    async screenshot(path){await sharp({create:{width:this.id==='A'?200:300,height:600,channels:3,background:'white'}}).png().toFile(path);return path;}
    getScreenshotGeometry(){return {udid:this.id,scale:this.id==='A'?2:3};}
  }
  const discovery=new Fake();const factory=()=>new Fake();
  const manager=new DeviceManager(discovery,factory);
  const run=(name,args={})=>manager.execute(tools.find(t=>t.definition.name===name),args,{});
  const connect=async()=>{await Promise.all(['A','B'].map(deviceId=>run('tap',{deviceId,x:0,y:0})));events.length=0;};
  return {events,clients,manager,run,connect,discovery,factory,stopped,connects};
}
function reference(client) {
  const result=registerScreenshot(client,{content:[],structuredContent:{mode:'pixel',imageSize:{width:200,height:400},deviceInfo:{deviceId:client.id,screenSize:{width:100,height:200},scale:2}}},{udid:client.id,scale:2});
  return result.structuredContent.screenshotId;
}

test('explicit selection, sole-device fallback, reference routing and mismatches fail before actions',async()=>{
  const {run,connect,events,clients}=fixture();
  await assert.rejects(run('tap',{x:1,y:2}),e=>e.details.code==='DEVICE_REQUIRED');
  await run('tap',{deviceId:'A',x:0,y:0});events.length=0;
  await run('tap',{x:1,y:2});assert.deepEqual(events.pop(),['A',1,2]);
  await run('tap',{deviceId:'B',x:0,y:0});events.length=0;
  await assert.rejects(run('tap',{x:1,y:2}),e=>e.details.code==='DEVICE_REQUIRED');
  const screenshotId=reference(clients.get('A'));
  await run('tap',{screenshotId,x:100,y:200});assert.deepEqual(events.pop(),['A',50,100]);
  await assert.rejects(run('tap',{deviceId:'B',screenshotId,x:1,y:2}),e=>e.details.code==='DEVICE_MISMATCH');
  await assert.rejects(run('tap',{deviceId:'missing',x:1,y:2}),e=>e.details.code==='DEVICE_NOT_FOUND');
  await assert.rejects(run('boot_simulator',{deviceId:'B',udid:'A'}),e=>e.details.code==='DEVICE_MISMATCH');
  await assert.rejects(run('tap',{deviceId:'fail',x:0,y:0}),/connect failed/);
  await run('tap',{deviceId:'A',x:1,y:2});assert.deepEqual(events.pop(),['A',1,2]);
  assert.equal(events.length,0);
  assert.ok((await run('list_devices')).every(d=>!('connected' in d)));
});

test('same device is serial; other device runs while first is blocked; failure releases queue',{timeout:3000},async t=>{
  const {run,connect,clients,events}=fixture();await connect();
  const entered=deferred(),release=deferred();t.after(()=>release.resolve());
  clients.get('A').tap=async x=>{events.push(['A',x]);if(x===1){entered.resolve();await release.promise;throw new Error('tap failed');}};
  const first=run('tap',{deviceId:'A',x:1,y:0});const failure=assert.rejects(first,/tap failed/);await entered.promise;
  const second=run('tap',{deviceId:'A',x:2,y:0});
  await run('tap',{deviceId:'B',x:3,y:0});
  assert.deepEqual(events,[['A',1],['B',3,0]]);
  release.resolve();await failure;await second;
  assert.deepEqual(events.at(-1),['A',2]);
});

test('entire chain owns one queue; other devices continue; lifecycle and cross-device steps rejected',{timeout:3000},async t=>{
  const {run,connect,clients,events}=fixture();await connect();
  const entered=deferred(),release=deferred();t.after(()=>release.resolve());
  clients.get('A').tap=async x=>{events.push(['A',x]);if(x===1){entered.resolve();await release.promise;}};
  const chain=run('operation_chain',{deviceId:'A',steps:[1,2].map(x=>({tool:'tap',arguments:{x,y:0},delay:x===1?0:0.4}))});
  await entered.promise;
  const other=run('tap',{deviceId:'A',x:3,y:0});await run('tap',{deviceId:'B',x:4,y:0});
  assert.deepEqual(events,[['A',1],['B',4,0]]);
  release.resolve();assert.equal((await chain).structuredContent.success,true);await other;
  assert.deepEqual(events.filter(e=>e[0]==='A'),[['A',1],['A',2],['A',3]]);
  events.length=0;
  for(const step of [{tool:'connect_device',arguments:{udid:'B'}},{tool:'shutdown_simulator',arguments:{udid:'B'}},{tool:'tap',arguments:{deviceId:'B',x:0,y:0}}]){
    await assert.rejects(run('operation_chain',{deviceId:'A',steps:[{tool:'tap',arguments:{x:9,y:0},delay:0},{...step,delay:0}]}));
  }
  await assert.rejects(run('operation_chain',{deviceId:'A',steps:[{tool:'tap',arguments:{x:9,y:0},delay:0},{tool:'tap',arguments:{screenshotId:reference(clients.get('B')),x:1,y:1},delay:0}]}),e=>e.details.code==='DEVICE_MISMATCH');
  assert.deepEqual(events,[]);
});

test('shutdown waits for active work, rejects queued operations, and invalidates only that device references',{timeout:3000},async t=>{
  const {run,connect,clients}=fixture();await connect();
  const a=reference(clients.get('A')),b=reference(clients.get('B'));
  const entered=deferred(),release=deferred();t.after(()=>release.resolve());
  clients.get('A').tap=async()=>{entered.resolve();await release.promise;};
  const tap=run('tap',{deviceId:'A',x:1,y:1});await entered.promise;
  const shutdown=run('shutdown_simulator',{deviceId:'A'});
  const queued=assert.rejects(run('tap',{deviceId:'A',x:2,y:2}),e=>e.details.code==='DEVICE_NOT_BOOTED');
  release.resolve();await Promise.all([tap,shutdown,queued]);
  await assert.rejects(run('tap',{screenshotId:a,x:1,y:1}),e=>e.details.code==='INVALID_SCREENSHOT_REFERENCE');
  await run('tap',{screenshotId:b,x:1,y:1});
  await run('boot_simulator',{deviceId:'A'});
  await assert.rejects(run('tap',{screenshotId:a,x:1,y:1}));
  await run('tap',{deviceId:'A',x:2,y:2});
});

test('MCP advertises routing, captures independent deviceInfo, and resolves screenshot references',async t=>{
  const {discovery,factory,events}=fixture();
  const dir=mkdtempSync(join(tmpdir(),'isimbot-multi-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const server=createServer(discovery,new ScreenshotSettingsStore(join(dir,'settings.json')),factory);
  const client=new Client({name:'multi-test',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();
  try{
    await server.connect(a);await client.connect(b);
    const list=(await client.listTools()).tools;
    for(const name of ['tap','screenshot','operation_chain'])assert.equal(list.find(t=>t.name===name).inputSchema.properties.deviceId.type,'string');
    assert.ok(!list.some(t=>t.name==='connect_device'));
    const results=await Promise.all(['A','B'].map(deviceId=>client.callTool({name:'screenshot',arguments:{deviceId,mode:'both'}})));
    for(const [i,result] of results.entries()){
      assert.ok(!result.isError);const [logical,pixel]=result.structuredContent.images;
      assert.equal(logical.deviceInfo.udid,i?'B':'A');assert.match(logical.deviceInfo.deviceId,/^[a-z0-9]{8}$/);assert.deepEqual(logical.deviceInfo,pixel.deviceInfo);
      assert.equal(logical.deviceInfo.scale,i?3:2);
      assert.ok(!(await client.callTool({name:'tap',arguments:{screenshotId:pixel.screenshotId,x:100,y:100}})).isError);
      assert.equal(events.at(-1)[0],i?'B':'A');
    }
    const invalid=await client.callTool({name:'tap',arguments:{x:1,y:1}});
    assert.equal(JSON.parse(invalid.content[0].text).code,'DEVICE_REQUIRED');
  }finally{await client.close();await server.close();}
});

test('UUID letter casing cannot create two queues for the same simulator',{timeout:3000},async t=>{
  const {run,clients,events}=fixture();
  const lower='9df5ff83-1e6c-44d8-bc9c-aa9eddd2f017',upper=lower.toUpperCase();
  await run('tap',{deviceId:lower,x:0,y:0});events.length=0;
  const entered=deferred(),release=deferred();t.after(()=>release.resolve());
  clients.get(upper).tap=async x=>{events.push(x);if(x===1){entered.resolve();await release.promise;}};
  const first=run('tap',{deviceId:lower,x:1,y:1});await entered.promise;
  const second=run('tap',{deviceId:upper,x:2,y:2});
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(events,[1]);
  release.resolve();await Promise.all([first,second]);assert.deepEqual(events,[1,2]);
});


test('published tool schemas avoid root combinators while lifecycle IDs remain validated', async () => {
  for (const tool of tools) {
    const schema = deviceToolDefinition(tool).inputSchema;
    assert.equal(schema.type, 'object');
    for (const key of ['anyOf', 'oneOf', 'allOf']) assert.ok(!(key in schema), `${tool.definition.name}: root ${key}`);
  }
  for (const name of ['boot_simulator', 'shutdown_simulator']) {
    const { run, events, clients } = fixture();
    for (const args of [{}, {deviceId:''}, {deviceId:'A',udid:'B'}]) await assert.rejects(run(name,args));
    assert.equal(events.length,0);
    assert.equal(clients.size,0);
    await run(name,{deviceId:'A'});
    await run(name,{udid:'A'});
  }
});

test('first-use concurrent calls connect once per device; stopped/unknown devices never connect', async () => {
  const {run,connects,stopped,events}=fixture();
  stopped.add('B');
  await assert.rejects(run('tap',{deviceId:'B',x:1,y:1}),e=>e.details.code==='DEVICE_NOT_BOOTED');
  await assert.rejects(run('tap',{deviceId:'missing',x:1,y:1}),e=>e.details.code==='DEVICE_NOT_FOUND');
  assert.deepEqual(connects,[]);assert.deepEqual(events,[]);
  await run('boot_simulator',{deviceId:'B'});events.length=0;
  await Promise.all([run('tap',{deviceId:'A',x:1,y:1}),run('tap',{deviceId:'A',x:2,y:2}),run('tap',{deviceId:'B',x:3,y:3})]);
  assert.equal(connects.filter(id=>id==='A').length,1);
  assert.equal(connects.filter(id=>id==='B').length,1);
  assert.deepEqual(events.filter(e=>e[0]==='A'),[['A',1,1],['A',2,2]]);
});

test('failed automatic connection is not cached and later requests retry', async () => {
  let attempts=0;const actions=[];
  const discovery={getConnectedDevice:()=>null,listDevices:async()=>[{udid:'A',type:'simulator',state:'Booted'}]};
  const manager=new DeviceManager(discovery,()=>({connect:async()=>{if(++attempts===1)throw Error('temporary connection failure');},tap:async()=>actions.push('tap')}));
  const tap=tools.find(t=>t.definition.name==='tap');
  await assert.rejects(manager.execute(tap,{deviceId:'A',x:1,y:1},{}),e=>e.details.code==='DEVICE_CONNECTION_FAILED');
  assert.deepEqual(actions,[]);
  await manager.execute(tap,{deviceId:'A',x:1,y:1},{});
  await manager.execute(tap,{deviceId:'A',x:1,y:1},{});
  assert.equal(attempts,2);assert.deepEqual(actions,['tap','tap']);
});

test('short IDs are stable per session, accept full UDIDs and share the same queue', {timeout:3000}, async t => {
  const {run,events,clients,connects}=fixture();
  const devices=await run('list_devices');
  const a=devices.find(d=>d.udid==='A'),b=devices.find(d=>d.udid==='B');
  assert.match(a.deviceId,/^[a-z0-9]{8}$/);
  assert.equal(new Set(devices.map(d=>d.deviceId)).size,devices.length);
  assert.deepEqual((await run('list_devices')).map(d=>d.deviceId),devices.map(d=>d.deviceId));
  await run('tap',{deviceId:a.deviceId,x:0,y:0});events.length=0;
  const entered=deferred(),release=deferred();t.after(()=>release.resolve());
  clients.get('A').tap=async x=>{events.push(['A',x]);if(x===1){entered.resolve();await release.promise;}};
  const first=run('tap',{deviceId:a.deviceId,x:1,y:0});await entered.promise;
  const second=run('tap',{deviceId:'A',x:2,y:0});
  await run('tap',{deviceId:b.deviceId,x:3,y:0});
  assert.deepEqual(events,[['A',1],['B',3,0]]);
  release.resolve();await Promise.all([first,second]);
  assert.equal(connects.filter(d=>d==='A').length,1);
  assert.deepEqual(events.at(-1),['A',2]);
  const screenshotId=reference(clients.get('A'));
  await run('tap',{deviceId:a.deviceId,screenshotId,x:2,y:2});
  await assert.rejects(run('tap',{deviceId:b.deviceId,screenshotId,x:2,y:2}),e=>e.details.code==='DEVICE_MISMATCH');
  await run('shutdown_simulator',{deviceId:a.deviceId,udid:'A'});
  await run('boot_simulator',{deviceId:a.deviceId});
  assert.equal((await run('list_devices')).find(d=>d.udid==='A').deviceId,a.deviceId);
  const fresh=fixture();
  await assert.rejects(fresh.run('tap',{deviceId:a.deviceId,x:0,y:0}),e=>e.details.code==='UNKNOWN_DEVICE_ID');
  await fresh.run('tap',{deviceId:'A',x:0,y:0});
});

test('short IDs are returned in both and chain screenshot metadata alongside the UDID', async t => {
  const {manager,run}=fixture();
  const dir=mkdtempSync(join(tmpdir(),'isimbot-short-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const settings=new ScreenshotSettingsStore(join(dir,'settings.json'));
  const id=(await run('list_devices')).find(d=>d.udid==='A').deviceId;
  const result=await manager.execute(tools.find(t=>t.definition.name==='operation_chain'),{deviceId:id,steps:[{tool:'screenshot',arguments:{mode:'both'},delay:0}]},settings);
  for(const entry of result.structuredContent.steps[0].result.images){
    assert.equal(entry.deviceInfo.deviceId,id);assert.equal(entry.deviceInfo.udid,'A');
    await run('tap',{deviceId:id,screenshotId:entry.screenshotId,x:2,y:2});
  }
});

test('device names resolve exactly, reject duplicates even across boot states, and refresh after rename', async () => {
  const {run,discovery,events,connects}=fixture();
  let devices=[{udid:'A',name:'iPhone Test',state:'Booted',type:'simulator'},{udid:'B',name:'Other',state:'Shutdown',type:'simulator'}];
  discovery.listDevices=async()=>devices;
  const listed=await run('list_devices');const short=listed[0].deviceId;
  await run('tap',{deviceId:'iPhone Test',x:1,y:1});
  await run('tap',{deviceId:short,x:2,y:2});
  await run('tap',{deviceId:'A',x:3,y:3});
  assert.deepEqual(events,[['A',1,1],['A',2,2],['A',3,3]]);assert.deepEqual(connects,['A']);
  await assert.rejects(run('tap',{deviceId:'iphone test',x:1,y:1}),e=>e.details.code==='DEVICE_NOT_FOUND');
  devices[1]={...devices[1],name:'iPhone Test'};events.length=0;
  for(const name of ['tap','boot_simulator','shutdown_simulator','operation_chain']){
    const args=name==='tap'?{x:1,y:1}:name==='operation_chain'?{steps:[{tool:'tap',arguments:{x:1,y:1},delay:0}]}:{};
    await assert.rejects(run(name,{...args,deviceId:'iPhone Test'}),e=>e.details.code==='AMBIGUOUS_DEVICE_NAME'&&e.details.devices.length===2&&e.details.devices.every(d=>d.deviceId&&d.udid));
  }
  assert.deepEqual(events,[]);assert.deepEqual(connects,['A']);
  devices=devices.map((d,i)=>({...d,name:i?'Other':'Renamed'}));
  await assert.rejects(run('tap',{deviceId:'iPhone Test',x:1,y:1}),e=>e.details.code==='DEVICE_NOT_FOUND');
  await run('tap',{deviceId:'Renamed',x:4,y:4});assert.deepEqual(events,[['A',4,4]]);
});
