import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeviceManager } from '../dist/operation/device-manager.js';
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
  const events=[],clients=new Map();
  class Fake {
    id=null;
    getConnectedDevice(){return this.id;}
    async connect(id){if(id==='fail')throw new Error('connect failed');clearScreenshotCoordinates(this);this.id=id;clients.set(id,this);}
    async listDevices(){return ['A','B'].map(udid=>({udid,name:udid,state:'Booted',type:'simulator'}));}
    async tap(x,y){events.push([this.id,x,y]);}
    async bootSimulator(id){events.push(['boot',id]);}
    async shutdownSimulator(id){events.push(['shutdown',id]);}
    async screenshot(path){await sharp({create:{width:this.id==='A'?200:300,height:600,channels:3,background:'white'}}).png().toFile(path);return path;}
    getScreenshotGeometry(){return {udid:this.id,scale:this.id==='A'?2:3};}
  }
  const discovery=new Fake();const factory=()=>new Fake();
  const manager=new DeviceManager(discovery,factory);
  const run=(name,args={})=>manager.execute(tools.find(t=>t.definition.name===name),args,{});
  const connect=()=>Promise.all(['A','B'].map(deviceId=>run('connect_device',{deviceId})));
  return {events,clients,manager,run,connect,discovery,factory};
}
function reference(client) {
  const result=registerScreenshot(client,{content:[],structuredContent:{mode:'pixel',imageSize:{width:200,height:400},deviceInfo:{deviceId:client.id,screenSize:{width:100,height:200},scale:2}}},{udid:client.id,scale:2});
  return result.structuredContent.screenshotId;
}

test('explicit selection, sole-device fallback, reference routing and mismatches fail before actions',async()=>{
  const {run,connect,events,clients}=fixture();
  await assert.rejects(run('tap',{x:1,y:2}),e=>e.details.code==='NO_DEVICE_CONNECTED');
  await run('connect_device',{udid:'A'});
  await run('tap',{x:1,y:2});assert.deepEqual(events.pop(),['A',1,2]);
  await run('connect_device',{deviceId:'B'});
  await assert.rejects(run('tap',{x:1,y:2}),e=>e.details.code==='DEVICE_REQUIRED'&&e.details.connectedDevices.length===2);
  const screenshotId=reference(clients.get('A'));
  await run('tap',{screenshotId,x:100,y:200});assert.deepEqual(events.pop(),['A',50,100]);
  await assert.rejects(run('tap',{deviceId:'B',screenshotId,x:1,y:2}),e=>e.details.code==='DEVICE_MISMATCH');
  await assert.rejects(run('tap',{deviceId:'missing',x:1,y:2}),e=>e.details.code==='DEVICE_NOT_CONNECTED');
  await assert.rejects(run('connect_device',{deviceId:'B',udid:'A'}),e=>e.details.code==='DEVICE_MISMATCH');
  await assert.rejects(run('connect_device',{deviceId:'fail'}),/connect failed/);
  await run('tap',{deviceId:'A',x:1,y:2});assert.deepEqual(events.pop(),['A',1,2]);
  assert.equal(events.length,0);
  assert.ok((await run('list_devices')).every(d=>d.connected));
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
  const chain=run('operation_chain',{deviceId:'A',steps:[1,2].map(x=>({tool:'tap',arguments:{x,y:0},delay:0}))});
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
  const queued=assert.rejects(run('tap',{deviceId:'A',x:2,y:2}),e=>e.details.code==='DEVICE_NOT_CONNECTED');
  release.resolve();await Promise.all([tap,shutdown,queued]);
  await assert.rejects(run('tap',{screenshotId:a,x:1,y:1}),e=>e.details.code==='INVALID_SCREENSHOT_REFERENCE');
  await run('tap',{screenshotId:b,x:1,y:1});
  await run('connect_device',{deviceId:'A'});
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
    for(const deviceId of ['A','B'])assert.ok(!(await client.callTool({name:'connect_device',arguments:{deviceId}})).isError);
    const results=await Promise.all(['A','B'].map(deviceId=>client.callTool({name:'screenshot',arguments:{deviceId,mode:'both'}})));
    for(const [i,result] of results.entries()){
      assert.ok(!result.isError);const [logical,pixel]=result.structuredContent.images;
      assert.equal(logical.deviceInfo.deviceId,i?'B':'A');assert.deepEqual(logical.deviceInfo,pixel.deviceInfo);
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
  await run('connect_device',{deviceId:lower});
  const entered=deferred(),release=deferred();t.after(()=>release.resolve());
  clients.get(upper).tap=async x=>{events.push(x);if(x===1){entered.resolve();await release.promise;}};
  const first=run('tap',{deviceId:lower,x:1,y:1});await entered.promise;
  const second=run('tap',{deviceId:upper,x:2,y:2});
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(events,[1]);
  release.resolve();await Promise.all([first,second]);assert.deepEqual(events,[1,2]);
});
